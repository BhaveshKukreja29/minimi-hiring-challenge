import { expand, REF } from "../shared/cite.ts";
import { EXA_API_KEY, HIGHLIGHT_CHARS, SEARCH_RESULTS } from "./config.ts";

type ExaResult = { url: string; title?: string; publishedDate?: string; highlights?: string[] };
export type Source = { n: number; title: string; url: string; domain: string; published: string };
export type Sentence = { text: string; source: number };

const cache = new Map<string, { at: number; results: ExaResult[] }>();
const CACHE_MS = 10 * 60_000;

export async function exaSearch(query: string, since?: string, fresh?: boolean, share = 1): Promise<ExaResult[]> {
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) since = undefined;
  const numResults = Math.max(2, Math.round(SEARCH_RESULTS * share));
  const maxCharacters = Math.round(HIGHLIGHT_CHARS * Math.min(1, share * 2));
  const key = JSON.stringify([query.toLowerCase().trim(), since, fresh, numResults]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;

  const r = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": EXA_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults,
      ...(since && { startPublishedDate: `${since}T00:00:00.000Z` }),
      contents: {
        highlights: { query, maxCharacters },
        ...(fresh && { maxAgeHours: 24 }), // pricing and status pages: don't trust a month-old crawl
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`exa ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const results: ExaResult[] = (await r.json()).results ?? [];
  cache.set(key, { at: Date.now(), results });
  return results;
}

// Exa joins highlight snippets with "..." and keeps some markdown. Both would break quotes and text fragments.
const SNIPPET_JOIN = /\s*(?:\.{3}|…)(?:\s+|$)/;
const SENTENCE_END = /(?<=[.!?]["”’)]?)\s+(?=["“(\[]?[A-Z0-9])/;

const stripMarkdown = (text: string) => text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|^#+\s*/gm, "");

export function splitSentences(text: string): string[] {
  return stripMarkdown(text)
    .replace(/\s+/g, " ")
    .split(SNIPPET_JOIN)
    .flatMap((s) => s.split(SENTENCE_END))
    .map((s) => s.trim())
    .filter((s) => s.length >= 25);
}

/** Every sentence the model may quote, keyed by a short id like s12.
 *  The model cites ids and never retypes text, so a quote can't be fabricated. */
export class Evidence {
  sources: Source[] = [];
  sentences: Record<string, Sentence> = {};

  add(results: ExaResult[]): string {
    const blocks: string[] = [];
    for (const res of results) {
      if (this.sources.some((s) => s.url === res.url)) continue;
      const src: Source = {
        n: this.sources.length + 1,
        title: res.title || res.url,
        url: res.url,
        domain: new URL(res.url).hostname.replace(/^www\./, ""),
        published: (res.publishedDate ?? "").slice(0, 10),
      };
      const lines: string[] = [];
      for (const sentence of (res.highlights ?? []).flatMap(splitSentences)) {
        const sid = `s${Object.keys(this.sentences).length + 1}`;
        this.sentences[sid] = { text: sentence, source: src.n };
        lines.push(`[${sid}] ${sentence}`);
      }
      if (!lines.length) continue;
      this.sources.push(src);
      const meta = [`source ${src.n}`, src.title, src.domain, src.published && `published ${src.published}`];
      blocks.push(`<${meta.filter(Boolean).join(" | ")}>\n${lines.join("\n")}`);
    }
    return blocks.join("\n\n") || "No results.";
  }

  /** Models sometimes paste a source sentence instead of citing it. Turn pasted sentences back into references. */
  relink(text: string): string {
    const longestFirst = Object.entries(this.sentences).sort(([, a], [, b]) => b.text.length - a.text.length);
    for (const [id, s] of longestFirst) if (s.text.length >= 40) text = text.split(s.text).join(`[[${id}]]`);
    return text;
  }

  /** Only keep the sentences the answer actually cited. */
  used(text: string): Record<string, Sentence> {
    const ids = [...text.matchAll(REF)].flatMap(([, a, b]) => expand(a, b));
    return Object.fromEntries(ids.filter((i) => this.sentences[i]).map((i) => [i, this.sentences[i]]));
  }
}
