/* Two kinds of memory, both plain rows:
 * - messages: an append-only log with timestamps. "What did I ask on Tuesday" is a lookup, not a guess.
 * - facts: (subject, predicate, object) triples with valid_from / valid_to. When a fact changes,
 *   the old row is closed, not deleted, so we know what was true when. */
import { createClient, type InValue } from "@libsql/client";
import type Groq from "groq-sdk";
import { DB_PATH, MEMORY_MODEL, TURSO_TOKEN, TURSO_URL } from "./config.ts";
import type { Sentence, Source } from "./search.ts";

export type Evidence = { sources: Source[]; sentences: Record<string, Sentence> };
export type Message = {
  id: number;
  thread_id: string;
  title?: string;
  role: "user" | "assistant";
  content: string;
  evidence: Evidence | null;
  created_at: number;
};
export type Fact = { id: number; subject: string; predicate: string; object: string; valid_from: number; valid_to: number | null };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, user_id TEXT NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL, evidence TEXT, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, subject TEXT NOT NULL,
  predicate TEXT NOT NULL, object TEXT NOT NULL, valid_from REAL NOT NULL, valid_to REAL,
  message_id INTEGER);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_facts_user ON facts(user_id, valid_to);`;

// With Turso: a local replica that takes writes offline and pushes them in the background,
// so no request ever waits on a round trip to the primary.
const db = createClient(
  TURSO_URL
    ? { url: `file:${DB_PATH}`, syncUrl: TURSO_URL, authToken: TURSO_TOKEN, offline: true }
    : { url: `file:${DB_PATH}` },
);

let pushTimer: NodeJS.Timeout | undefined;
function push() {
  if (!TURSO_URL || pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    db.sync().catch((e) => console.error("turso sync failed:", e.message));
  }, 1000);
}

export async function init() {
  if (TURSO_URL) await db.sync();
  await db.executeMultiple(SCHEMA);
}

export const flush = async () => void (TURSO_URL && (await db.sync()));

async function rows<T>(sql: string, args: InValue[] = []): Promise<T[]> {
  const rs = await db.execute({ sql, args });
  return rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])) as T);
}

const now = () => Date.now() / 1000;
const parse = (m: Message): Message => ({ ...m, evidence: m.evidence ? JSON.parse(m.evidence as unknown as string) : null });

export async function ensureThread(user: string, threadId: string, title: string) {
  await db.execute({
    sql: "INSERT OR IGNORE INTO threads (id, user_id, title, created_at) VALUES (?, ?, ?, ?)",
    args: [threadId, user, title.slice(0, 80), now()],
  });
  push();
}

export async function addMessage(user: string, threadId: string, role: string, content: string, evidence?: Evidence | null) {
  const rs = await db.execute({
    sql: "INSERT INTO messages (thread_id, user_id, role, content, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: [threadId, user, role, content, evidence ? JSON.stringify(evidence) : null, now()],
  });
  push();
  return Number(rs.lastInsertRowid);
}

export const threads = (user: string) =>
  rows(
    `SELECT t.id, t.title, MAX(m.created_at) AS updated_at FROM threads t JOIN messages m ON m.thread_id = t.id
     WHERE t.user_id = ? GROUP BY t.id ORDER BY updated_at DESC LIMIT 100`,
    [user],
  );

export const threadMessages = async (user: string, threadId: string) =>
  (await rows<Message>("SELECT * FROM messages WHERE user_id = ? AND thread_id = ? ORDER BY id", [user, threadId])).map(parse);

/** Everything the user has said and been told, newest last. One user's history is small enough to scan. */
export const allMessages = async (user: string) =>
  (
    await rows<Message>(
      `SELECT m.*, t.title FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.user_id = ? ORDER BY m.id DESC LIMIT 2000`,
      [user],
    )
  )
    .reverse()
    .map(parse);

export const facts = (user: string) => rows<Fact>("SELECT * FROM facts WHERE user_id = ? ORDER BY id", [user]);

export async function deleteFact(user: string, id: number) {
  await db.execute({ sql: "DELETE FROM facts WHERE user_id = ? AND id = ?", args: [user, id] });
  push();
}

/** Deleting a question deletes its answer and anything learned from it. */
export async function deleteExchange(user: string, id: number) {
  const [m] = await rows<Message>("SELECT thread_id, role FROM messages WHERE id = ? AND user_id = ?", [id, user]);
  if (!m) return;
  const [next] = await rows<Message>("SELECT id, role FROM messages WHERE thread_id = ? AND id > ? ORDER BY id LIMIT 1", [m.thread_id, id]);
  const ids = m.role === "user" && next?.role === "assistant" ? [id, next.id] : [id];
  await db.batch([
    { sql: `DELETE FROM messages WHERE user_id = ? AND id IN (${ids.map(() => "?").join()})`, args: [user, ...ids] },
    { sql: "DELETE FROM facts WHERE user_id = ? AND message_id = ?", args: [user, id] },
  ]);
  push();
}

/** Deleting a conversation deletes everything in it, including facts learned from it. */
export async function deleteThread(user: string, threadId: string) {
  const owned = "SELECT id FROM messages WHERE user_id = ? AND thread_id = ?";
  await db.batch([
    { sql: `DELETE FROM facts WHERE user_id = ? AND message_id IN (${owned})`, args: [user, user, threadId] },
    { sql: "DELETE FROM messages WHERE user_id = ? AND thread_id = ?", args: [user, threadId] },
    { sql: "DELETE FROM threads WHERE user_id = ? AND id = ?", args: [user, threadId] },
  ]);
  push();
}

const EXTRACT_PROMPT = `You maintain a memory of durable facts about a user, stored as triples.
Read the user's new message and decide what to change. Store things the user states about
themselves, their preferences, plans, people, projects, decisions and anything they ask you to remember.
Do not store questions, opinions about search results, or small talk.

Current facts (id: subject | predicate | object):
{facts}

Reply with JSON only:
{"add": [{"subject": "...", "predicate": "...", "object": "..."}], "retire": [ids of facts that the new message makes no longer true]}
Use "user" as the subject for facts about the user. Keep values short. If a fact changed, retire the old id and add the new one.`;

export async function remember(groq: Groq, user: string, text: string, messageId: number) {
  const current = (await facts(user)).filter((f) => f.valid_to === null);
  const listing = current.map((f) => `${f.id}: ${f.subject} | ${f.predicate} | ${f.object}`).join("\n") || "(none)";
  let ops: { add?: Partial<Fact>[]; retire?: number[] };
  try {
    const r = await groq.chat.completions.create(
      {
        model: MEMORY_MODEL,
        messages: [
          { role: "system", content: EXTRACT_PROMPT.replace("{facts}", listing) },
          { role: "user", content: text },
        ],
        response_format: { type: "json_object" },
        reasoning_effort: "low",
        temperature: 0,
      },
      { maxRetries: 2 },
    );
    ops = JSON.parse(r.choices[0].message.content ?? "{}");
  } catch (e) {
    return console.error("memory extraction failed:", (e as Error).message); // memory must never break chat
  }

  const t = now();
  const live = new Set(current.map((f) => f.id));
  const str = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const writes = [
    ...(ops.retire ?? [])
      .filter((id) => live.has(id))
      .map((id) => ({ sql: "UPDATE facts SET valid_to = ? WHERE id = ? AND user_id = ?", args: [t, id, user] })),
    ...(ops.add ?? [])
      .filter((f) => str(f.subject) && str(f.predicate) && str(f.object))
      .map((f) => ({
        sql: "INSERT INTO facts (user_id, subject, predicate, object, valid_from, message_id) VALUES (?, ?, ?, ?, ?, ?)",
        args: [user, f.subject!.trim(), f.predicate!.trim(), f.object!.trim(), t, messageId],
      })),
  ];
  if (!writes.length) return;
  await db.batch(writes);
  push();
}
