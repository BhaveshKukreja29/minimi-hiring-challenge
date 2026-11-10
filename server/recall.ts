/* Builds the memory section of the system prompt before the model runs. Memory is not a tool:
 * finding the right past exchanges is deterministic (dates + keywords), so it costs no model round trip. */
import * as chrono from "chrono-node";
import { allMessages, facts, type Evidence, type Message } from "./memory.ts";
import { expand, REF } from "../shared/cite.ts";

const DAY = 86400;
const STOP = new Set(
  `about above after again also answer any are asked been before being both but can could did does doing done
  each few for from had has have having here how into its just like more most much must not now off once only
  other our out over own same should since some still such than that the their them then there these they this
  those through too under until very was were what when where which while who why will with would you your yours
  tell told me my we us is in on at to of a an or be do it i im ive id dont isnt any has know think thing things
  changed change anything something shipped big today yesterday week last ago`.split(/\s+/),
);

export function fmtTime(ts: number, tz: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(ts * 1000);
}

const fmtDay = (ts: number, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "2-digit", month: "short", year: "numeric" }).format(
    ts * 1000,
  );

function offsetMinutes(tz: string, at = new Date()) {
  const wall = (zone: string) => new Date(at.toLocaleString("en-US", { timeZone: zone })).getTime();
  return Math.round((wall(tz) - wall("UTC")) / 60000);
}

/** "on Monday", "3 November", "last Tuesday" -> local day ranges, always in the past. */
export function mentionedDays(text: string, tz: string, at = new Date()) {
  const offset = offsetMinutes(tz, at);
  const days: { phrase: string; from: number; to: number }[] = [];
  for (const r of chrono.parse(text, { instant: at, timezone: offset }, { forwardDate: false })) {
    if (!r.start.isCertain("day") && !r.start.isCertain("weekday")) continue;
    const dayStart = (c: chrono.ParsedComponents) =>
      Date.UTC(c.get("year")!, c.get("month")! - 1, c.get("day")!) / 1000 - offset * 60;
    const from = dayStart(r.start);
    const to = (r.end ? dayStart(r.end) : from) + DAY;
    const back = from > at.getTime() / 1000 ? (r.start.isCertain("month") ? 365 * DAY : 7 * DAY) : 0;
    days.push({ phrase: r.text, from: from - back, to: Math.max(to, from + DAY) - back });
  }
  // "Is that still true today?" next to a real date is about now, not a request to recall today.
  const nowTs = at.getTime() / 1000;
  return days.length > 1 ? days.filter((d) => !(d.from <= nowTs && nowTs < d.to)) : days;
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*[a-z0-9+#]|[a-z0-9]/g) ?? [];

export function inlineQuotes(content: string, evidence: Evidence | null) {
  if (!evidence) return content;
  const sources = new Map(evidence.sources.map((s) => [s.n, s]));
  return content.replace(REF, (_, a: string, b?: string) => {
    const parts = expand(a, b).flatMap((id) => evidence.sentences[id] ?? []);
    if (!parts.length) return "";
    const s = sources.get(parts[0].source);
    return `"${parts.map((p) => p.text).join(" ")}" (${[s?.domain, s?.published].filter(Boolean).join(", ")})`;
  });
}

type Exchange = { q: Message; a?: Message };

function pair(log: Message[]): Exchange[] {
  const out: Exchange[] = [];
  for (const m of log) {
    if (m.role === "user") out.push({ q: m });
    else if (out.length && out.at(-1)!.q.thread_id === m.thread_id && !out.at(-1)!.a) out.at(-1)!.a = m;
  }
  return out;
}

/** Rank past exchanges by the rare words they share with the new message (a tiny BM25 without the B). */
function topical(exchanges: Exchange[], text: string, skipPhrases: string[]) {
  let query = text.toLowerCase();
  for (const p of skipPhrases) query = query.replace(p.toLowerCase(), " ");
  const terms = [...new Set(words(query))].filter((w) => w.length > 2 && !STOP.has(w));
  if (!terms.length) return [];
  const docs = exchanges.map((e) => new Set(words(`${e.q.content} ${e.a?.content ?? ""}`)));
  const idf = (t: string) => Math.log((docs.length + 1) / (docs.filter((d) => d.has(t)).length + 0.5));
  return exchanges
    .map((e, i) => ({ e, score: terms.reduce((s, t) => s + (docs[i].has(t) ? idf(t) : 0), 0) }))
    .filter((x) => x.score > 1.5)
    .sort((x, y) => y.score - x.score)
    .slice(0, 2)
    .map((x) => x.e);
}

function render({ q, a }: Exchange, tz: string) {
  const answer = a ? inlineQuotes(a.content, a.evidence).slice(0, 900) : "(no answer saved)";
  return `[${fmtTime(q.created_at, tz)} · conversation "${q.title}"]\nUser: ${q.content.slice(0, 300)}\nYou answered: ${answer}`;
}

export async function memoryBlock(user: string, threadId: string, text: string, tz: string) {
  const [log, allFacts] = await Promise.all([allMessages(user), facts(user)]);
  const exchanges = pair(log);
  const elsewhere = exchanges.filter((e) => e.q.thread_id !== threadId); // this thread is already in the chat history
  const days = mentionedDays(text, tz);

  const dated = days.flatMap((d) => exchanges.filter((e) => e.q.created_at >= d.from && e.q.created_at < d.to)).slice(-4);
  const related = topical(elsewhere, text, days.map((d) => d.phrase)).filter((e) => !dated.includes(e));

  const active = allFacts.filter((f) => f.valid_to === null);
  const past = allFacts.filter((f) => f.valid_to !== null).slice(-10);
  const out = ["# Memory\nThese records are exact. Trust them over your own guesses about what the user said or when."];

  if (days.length)
    out.push(
      "Dates in the user's message: " +
        days.map((d) => `"${d.phrase}" = ${fmtDay(d.from, tz)}${d.to - d.from > DAY ? ` to ${fmtDay(d.to - 1, tz)}` : ""}`).join("; "),
    );
  if (days.length)
    out.push(
      dated.length
        ? "## Everything from those dates\n" + dated.map((e) => render(e, tz)).join("\n\n")
        : "## Everything from those dates\nNothing. The user didn't talk to you then. Say so.",
    );
  if (related.length) out.push("## Past exchanges that look related\n" + related.map((e) => render(e, tz)).join("\n\n"));
  if (active.length)
    out.push(
      "## Facts about the user\n" +
        active.map((f) => `- ${f.subject} | ${f.predicate} | ${f.object} (since ${fmtDay(f.valid_from, tz)})`).join("\n"),
    );
  if (past.length)
    out.push(
      "## Facts that used to be true\n" +
        past.map((f) => `- ${f.subject} | ${f.predicate} | ${f.object} (${fmtDay(f.valid_from, tz)} to ${fmtDay(f.valid_to!, tz)})`).join("\n"),
    );
  const recent = elsewhere.slice(-12).reverse();
  if (recent.length)
    out.push(
      "## The user's recent questions in other conversations, newest first\n" +
        recent.map((e) => `- ${fmtTime(e.q.created_at, tz)}: "${e.q.content.slice(0, 140)}"`).join("\n"),
    );
  if (out.length === 1) out.push("Nothing yet. This is a new user.");
  return out.join("\n\n");
}
