# Verbatim: design

A chat agent with one tool, web search. The bet: the best answer is one you don't have to trust, so every quote is word for word from the page, and the agent remembers what you asked and *when* well enough to check its own old answers.

## How a message flows

1. **Recall, before the model runs (no LLM call, a few ms).** The server reads your history and builds the memory part of the prompt:
   - `chrono-node` turns "last Tuesday" or "on 3 November" into real dates in your timezone, and everything from those days gets pulled in: your question, my answer, and its quotes with publish dates.
   - Past exchanges that share rare words with the new message ("Postgres hosting") come along too, ranked by IDF.
   - Facts about you, and your last 12 questions with timestamps.
2. **Route.** A question about the world *must* search on the first turn (`tool_choice: required`). Only small talk and messages about you or the chat let the model decide. Receipts are the product, so they aren't left to the model's mood.
3. **Search.** One tool: `web_search(query, since?, fresh?)`. The model fires up to 4 queries in parallel, e.g. one per CRM tool. `since` filters by publish date ("what changed since Monday"). `fresh` makes Exa re-crawl, because a month-old cache of a pricing page is a wrong answer. Exa returns query-relevant highlights in the same call, so there's no second fetch step.
4. **Quote by reference.** Highlights are split into sentences with ids: `[s14] It turns out that an octopus has three hearts...`. The model cites `[[s14]]` and never types the quote. The browser swaps the id for the stored sentence and shows it as a clipping, linked with a [text fragment](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment/Text_fragments) (`#:~:text=`), so the page opens scrolled to that sentence, highlighted. Some sites' own scripts undo the scroll or the highlight after load; then you still land on the right page.
5. **Stream.** Over SSE. Generation is detached from the HTTP connection, so if you close the tab mid-answer it still finishes and gets saved.
6. **Remember, in parallel.** `gpt-oss-20b` (its own rate-limit bucket) reads the message and updates a small temporal fact graph: `(user, lives in, Pune, valid_from, valid_to)`. A changed fact gets closed, not deleted. That's how "you said Pune, then Bangalore on the 7th" works. Everything shows up in the Ledger, where you can forget any of it.

## Why it's built like this

- **A fabricated quote is impossible by construction.** An id that doesn't exist renders as nothing. Models still sometimes type quotes in "marks", so the renderer checks those against the evidence too. Yellow means verbatim, always. The model can still cite the *wrong* sentence, but then the sentence sits right under the claim and you catch it in a second. A bad paraphrase hides. A bad quote doesn't.
- **Memory isn't a tool.** "What did I ask on 3 November" is a date lookup, not a reasoning problem. Doing it before the model runs keeps to one tool and saves a whole round trip.
- **Fast by default.** Groq, with Qwen 3.8 27B and reasoning off, so the first word lands in ~0.4s without search and ~2.8s (median) with it. Quote ids are about 5 tokens against ~30 for a retyped sentence. The answer streams while memory extraction runs next to it. Turso is used as a local replica with offline writes, so no request waits on a database round trip. That one was 13s per message before I caught it.
- **Built for how these models actually fail.** Every case below showed up in testing:
  - Qwen garbles tool calls now and then (`webollar`), so it retries.
  - gpt-oss writes `【s3】`, so all citation formats get normalized.
  - Models sometimes paste a source sentence instead of citing it. An exact match gets turned back into a reference, so it still shows up as a clipping.
  - A 429 falls back to another model and tells you.
  - Groq's free tier caps a request at ~7k tokens, so evidence, memory and history each have a budget.

## Considered and rejected

- **Embeddings / a vector DB for memory.** Dates and product names are exact-match problems, and embeddings blur "Tuesday" into "Thursday". One user's history is small enough to scan. I'd add SQLite FTS5 before I'd add vectors.
- **Memory as a second tool.** It costs a round trip and breaks the one-tool brief.
- **Letting the model quote, then fuzzy-checking.** It can still drift inside the marks, and a fuzzy match would happily pass a near-miss. Ids are cheaper and exact.
- **Fetching full pages and ranking sentences myself.** Better quotes, but 2-5s more per answer.
- **Multi-round agentic search loops.** On the free tier, one round of parallel queries is faster and fits the token cap. `MAX_SEARCH_ROUNDS` goes to 2 on a paid key.
- **An agent framework.** The loop is ~100 lines, and I'd rather own the failure handling than configure around it.

## With another week

- **Snapshots for "what changed".** Store a hash and the quotes for each page I cite, so "has pricing changed since Monday" becomes an exact diff, not a re-read. Then offer watchlists: "tell me when any of these 5 CRMs changes pricing".
- **Claim checking.** A cheap NLI pass per quote that flags the ones that don't actually support the sentence they sit under.
- **Full text for the top 2 results** when highlights are thin, like JS-heavy pricing pages.
- Accounts, per-user rate limits, a paid Groq tier, and an LLM-judged eval on a set shaped like your dataset.

## Evals

`npm run eval` runs the real agent: 15 factual questions, then memory scripts where each turn is a fresh conversation. One script changes a fact midway. The other backdates a question by 8 days and then asks "What did I ask you on <date>? Is your answer still correct today?".

| metric (qwen/qwen3.8-27b, 2026-11-10) | value |
|---|---|
| QA accuracy | 15/15 |
| QA answers with at least one verbatim quote | 15/15 |
| Quote refs that resolved to a real sentence | 28/28 |
| Memory and recall (facts across threads, recall by date and topic, then re-check) | 4/4 |
| Median first token (every QA answer searched first) | 2822 ms |
| Median total | 2963 ms |
| p90 total | 4228 ms |

The QA set is easy on purpose. Accuracy isn't the interesting row; receipts and recall are. Next I'd grow the recall scripts, since that's where agents quietly fall apart.
