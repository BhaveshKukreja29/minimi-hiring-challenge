import Groq, { APIError, RateLimitError } from "groq-sdk";
import type { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions";
import * as config from "./config.ts";
import { addMessage, ensureThread, remember, threadMessages } from "./memory.ts";
import { fmtTime, inlineQuotes, memoryBlock } from "./recall.ts";
import { normalizeRefs } from "../shared/cite.ts";
import { Evidence, exaSearch } from "./search.ts";

// No silent retries on the chat path: on a 429 we switch models instead of sleeping.
export const groq = new Groq({ apiKey: config.GROQ_API_KEY, maxRetries: 0 });
export const background = new Set<Promise<unknown>>();

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description: "Search the web. Returns numbered sentences from the top pages.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "A focused search query, like you'd type into Google." },
          since: { type: "string", description: "YYYY-MM-DD. Only pages published on or after this date." },
          fresh: { type: "boolean", description: "Re-crawl pages live. For prices, plans, versions, status." },
        },
        required: ["query"],
      },
    },
  },
];

const SYSTEM = `You are Verbatim, a chat assistant with one tool: web_search. Now is {now}.

Every factual answer comes with receipts: quotes from web_search results. So call web_search before
answering any question about the world, even trivia you are sure about; your training data is stale.
Answering a factual question without searching is a failure. Don't search only for small talk,
rewriting text the user gave you, math, and questions about the user or past conversations that the
memory below fully answers.
- Run 2-3 searches at once when a question has several parts, e.g. one per product.
- since=YYYY-MM-DD for news and "what changed since <date>". Memory shows what dates resolve to.
- fresh=true for prices, plans, versions and anything that changes week to week.
- To check whether an old answer still holds, search for the current state and compare it with what
  you said then. Memory has your old answer with its quotes and their dates. Say plainly what changed
  and what didn't.

How to quote: results are numbered sentences like [s12]. Cite with [[s12]], or [[s12-s14]] for up to
3 consecutive sentences from one source. The app swaps the reference for the exact sentence, so quotes
are always verbatim. Never type a quote yourself or wrap source text in quotation marks.
- Back every claim from the web with a reference. 2-4 per answer is typical.
- Put the most important reference alone on its own line, without a bullet, right after the claim.
- Other references go at the end of the sentence they support.
- Write claims in your own words. Don't copy a source sentence into your text; the reference already shows it.

Style: don't announce that you're searching, just search. Lead with the answer in a sentence or two, then the evidence. Be brief and plain, like a sharp
friend, not a report. Paragraphs, short lists and **bold** only, no headings or tables. If sources
disagree or look outdated, say so and prefer the newest. If the results don't answer the question,
say that instead of guessing.

{memory}`;

async function history(user: string, threadId: string, tz: string): Promise<ChatCompletionMessageParam[]> {
  return (await threadMessages(user, threadId)).slice(-8).map((m) =>
    m.role === "user"
      ? { role: "user", content: `[${fmtTime(m.created_at, tz)}] ${m.content}` }
      : { role: "assistant", content: inlineQuotes(m.content, m.evidence).slice(0, 1200) },
  );
}

// Receipts are the product, so whether to search isn't left to the model's mood. A message about the
// world always searches first; only small talk and messages about the user or the chat let the model decide.
const SMALL_TALK = /^\W*(hi|hey|hello|yo|thanks|thank you|thx|ok|okay|cool|nice|great|lol|bye|good (morning|night))\b/i;
const PERSONAL = /\b(i|i'm|im|i've|me|my|mine|we|our|us|you said|you told|remember|earlier|before)\b/i;
const mustSearch = (text: string) => !(SMALL_TALK.test(text) && text.split(/\s+/).length <= 6) && !PERSONAL.test(text);

type ToolMode = "required" | "auto" | "none";

function complete(model: string, think: boolean, messages: ChatCompletionMessageParam[], toolChoice: ToolMode) {
  return groq.chat.completions.create({
    model,
    messages,
    tools: TOOLS,
    tool_choice: toolChoice,
    stream: true,
    temperature: 0.6,
    max_completion_tokens: 2048,
    ...(config.MODELS[model][think ? "think" : "fast"] as object),
  });
}

type Call = { id: string; name: string; args: string };
type Event = Record<string, unknown> & { type: string };

// Qwen sometimes garbles a tool call ("webollar") and Groq rejects the whole generation.
const badToolCall = (e: unknown) =>
  e instanceof APIError && /tool_use_failed|Failed to call a function|tool call validation|model called a tool/.test(e.message);

async function* streamRound(
  model: string,
  think: boolean,
  messages: ChatCompletionMessageParam[],
  toolChoice: ToolMode,
  out: { content: string; calls: Call[]; firstToken: () => void },
): AsyncGenerator<Event> {
  for await (const chunk of await complete(model, think, messages, toolChoice)) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;
    if (delta.content) {
      out.firstToken();
      out.content += delta.content;
      yield { type: "token", text: delta.content };
    }
    for (const tc of delta.tool_calls ?? []) {
      const call = (out.calls[tc.index] ??= { id: "", name: "", args: "" });
      call.id = tc.id || call.id;
      call.name += tc.function?.name ?? "";
      call.args += tc.function?.arguments ?? "";
    }
  }
}

export async function* run(user: string, threadId: string, text: string, model: string, think: boolean, tz: string): AsyncGenerator<Event> {
  const t0 = performance.now();
  let firstToken = 0;
  let searchMs = 0;

  const [past, memory] = await Promise.all([history(user, threadId, tz), memoryBlock(user, threadId, text, tz)]);
  await ensureThread(user, threadId, text);
  const userMessageId = await addMessage(user, threadId, "user", text);

  // Fact extraction runs alongside the answer, on a different model, so it adds no latency.
  const task = remember(groq, user, text, userMessageId).catch((e) => console.error("memory failed:", e));
  background.add(task);
  task.finally(() => background.delete(task));

  const system = SYSTEM.replace("{now}", `${fmtTime(Date.now() / 1000, tz)} (${tz})`).replace("{memory}", memory);
  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: system }, ...past, { role: "user", content: text }];
  const ev = new Evidence();
  let out = { content: "", calls: [] as Call[], firstToken: () => void (firstToken ||= performance.now() - t0) };

  for (let round = 0; round <= config.MAX_SEARCH_ROUNDS; round++) {
    const toolChoice: ToolMode = round === config.MAX_SEARCH_ROUNDS ? "none" : round === 0 && mustSearch(text) ? "required" : "auto";
    for (let attempt = 0; ; attempt++) {
      out = { ...out, content: "", calls: [] };
      try {
        yield* streamRound(model, think, messages, toolChoice, out);
        break;
      } catch (e) {
        if (out.content) yield { type: "reset" };
        if (e instanceof RateLimitError && model !== config.FALLBACK_MODEL) {
          model = config.FALLBACK_MODEL;
          yield { type: "notice", text: `Rate limited, switched to ${config.MODELS[model].label}` };
        } else if (!badToolCall(e) || attempt >= 2) throw e;
      }
    }
    const calls = out.calls.filter(Boolean);
    if (!calls.length) break;

    messages.push({
      role: "assistant",
      content: out.content || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
    });
    const args = calls.slice(0, config.MAX_QUERIES).map((c) => {
      try {
        const a = JSON.parse(c.args || "{}");
        return a.query ? a : { query: text };
      } catch {
        return { query: text };
      }
    });
    yield { type: "search", queries: args.map((a) => a.query) };

    const s0 = performance.now();
    const share = 1 / args.length; // parallel queries split one evidence budget
    const results = await Promise.allSettled(
      args.map((a) => exaSearch(a.query, a.since, a.fresh === true || a.fresh === "true", share)),
    );
    searchMs += performance.now() - s0;
    calls.forEach((c, i) => {
      const r = results[i];
      const content = !r ? "Skipped: too many parallel searches." : r.status === "fulfilled" ? ev.add(r.value) : `Search failed: ${r.reason}`;
      messages.push({ role: "tool", tool_call_id: c.id, content });
    });
    yield { type: "sources", sources: ev.sources, sentences: ev.sentences };
    if (round + 1 === config.MAX_SEARCH_ROUNDS)
      messages.push({ role: "system", content: "That was your last search. Answer now from the results above." });
  }

  const content = ev.relink(normalizeRefs(out.content));
  const evidence = ev.sources.length ? { sources: ev.sources, sentences: ev.used(content) } : null;
  const id = await addMessage(user, threadId, "assistant", content, evidence);
  yield {
    type: "done",
    id,
    user_message_id: userMessageId,
    content,
    evidence,
    model,
    timings: {
      first_token_ms: Math.round(firstToken),
      search_ms: Math.round(searchMs),
      total_ms: Math.round(performance.now() - t0),
    },
  };
}
