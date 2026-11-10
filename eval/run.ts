/* Runs the real agent against real Groq and Exa and prints a markdown report.
 *   npm run eval -- [--model qwen/qwen3.8-27b] [--pause 8]
 * --pause spaces out questions so the free tier's 8k tokens/minute doesn't skew latency. */
import { readFileSync, rmSync } from "node:fs";
import { parseArgs } from "node:util";

const DB = "/tmp/verbatim-eval.db";
rmSync(DB, { force: true });
Object.assign(process.env, { DB_PATH: DB, TURSO_URL: "" }); // never touch the real database

const { createClient } = await import("@libsql/client");
const memory = await import("../server/memory.ts");
const { run, background } = await import("../server/agent.ts");
const { inlineQuotes } = await import("../server/recall.ts");
const { REF } = await import("../shared/cite.ts");

const { values } = parseArgs({ options: { model: { type: "string", default: "qwen/qwen3.8-27b" }, pause: { type: "string", default: "8" } } });
const model = values.model!;
const pause = () => new Promise((r) => setTimeout(r, Number(values.pause) * 1000));
const id = () => crypto.randomUUID();

type Result = { text: string; evidence: any; timings: any; searched: boolean };

async function ask(user: string, text: string, thread = id()): Promise<Result> {
  const r: Result = { text: "", evidence: null, timings: null, searched: false };
  for await (const e of run(user, thread, text, model, false, "Asia/Kolkata")) {
    if (e.type === "search") r.searched = true;
    if (e.type === "done") Object.assign(r, { text: e.content, evidence: e.evidence, timings: e.timings });
  }
  await Promise.all(background); // let memory extraction land before the next turn
  return r;
}

const readable = (r: Result) => inlineQuotes(r.text, r.evidence).toLowerCase();
const has = (r: Result, words: string[]) => words.every((w) => readable(r).includes(w));
const log = (ok: boolean, q: string) => console.log(`${ok ? "PASS" : "FAIL"} ${q}`);

await memory.init();
const qa = readFileSync(new URL("qa.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
let correct = 0, withReceipts = 0, refs = 0, resolved = 0;
const timings: any[] = [];

for (const item of qa) {
  const r = await ask("eval-" + id(), item.q);
  const ok = item.expect.some((x: string) => readable(r).includes(x.toLowerCase()));
  const cited = [...r.text.matchAll(REF)];
  refs += cited.length;
  resolved += cited.filter(([, a]) => r.evidence?.sentences[a]).length;
  withReceipts += Object.keys(r.evidence?.sentences ?? {}).length > 0 ? 1 : 0;
  correct += ok ? 1 : 0;
  timings.push(r.timings);
  log(ok, item.q);
  await pause();
}

// Memory, each turn in a fresh conversation so only memory can answer.
const facts = "eval-" + id();
const factChecks: [string, string[] | null][] = [
  ["I live in Pune and I'm vegetarian.", null],
  ["Actually I just moved to Bangalore last week.", null],
  ["Where do I live now, and where did I live before?", ["bangalore", "pune"]],
  ["What's my diet?", ["vegetarian"]],
];
let memOk = 0, memTotal = 0;
for (const [q, expect] of factChecks) {
  const r = await ask(facts, q);
  if (expect) {
    memTotal++;
    memOk += has(r, expect) ? 1 : 0;
    log(has(r, expect), q);
  }
  await pause();
}

// Recall by date and topic, like "What did I ask you on 3 November?". The first question is backdated 8 days.
const past = "eval-" + id();
const oldThread = id();
await ask(past, "What does the cheapest paid plan on Neon Postgres hosting cost?", oldThread);
const backdated = Date.now() / 1000 - 8 * 86400;
const raw = createClient({ url: `file:${DB}` });
await raw.execute({ sql: "UPDATE messages SET created_at = ? WHERE thread_id = ?", args: [backdated, oldThread] });
const day = new Date(backdated * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Asia/Kolkata" });
for (const q of [`What did I ask you on ${day}? Is your answer still correct today?`, "Last week I asked you about Postgres hosting. Has any pricing changed since then?"]) {
  await pause();
  const r = await ask(past, q);
  const ok = has(r, ["neon"]) && r.searched;
  memTotal++;
  memOk += ok ? 1 : 0;
  log(ok, q);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const total = timings.map((t) => t.total_ms);
console.log(`
## Results (${model}, ${new Date().toISOString().slice(0, 10)})

| metric | value |
|---|---|
| QA accuracy | ${correct}/${qa.length} |
| QA answers with at least one verbatim quote | ${withReceipts}/${qa.length} |
| Quote refs that resolved to a real sentence | ${resolved}/${refs} |
| Memory and recall (facts across threads, recall by date and topic, then re-check) | ${memOk}/${memTotal} |
| Median first token | ${median(timings.map((t) => t.first_token_ms))} ms |
| Median total | ${median(total)} ms |
| p90 total | ${[...total].sort((a, b) => a - b)[Math.ceil(total.length * 0.9) - 1]} ms |`);
process.exit(0);
