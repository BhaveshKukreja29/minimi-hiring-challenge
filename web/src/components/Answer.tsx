import { memo, type ReactNode } from "react";
import { expand, normalizeRefs, REF } from "../../../shared/cite";
import type { Evidence, Source } from "../api";

// A line that's only references (optionally bulleted) becomes clippings under the claim above it.
const QUOTE_LINE = /^(?:[-*•>]\s*)?(?:\[\[s\d+(?:-s\d+)?\]\][\s,.;]*)+$/;
const KICKER = /^\*\*([^*]+)\*\*:?$/;
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[\[s\d+(?:-s\d+)?\]\]|\[[^\]]+\]\(https?:[^)]+\)|"[^"\n]{3,}"|“[^”\n]{3,}”)/g;

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");

type Quote = { text: string; source: Source };

function resolve(a: string, b: string | undefined, ev: Evidence): Quote | null {
  const first = ev.sentences[a];
  if (!first) return null;
  const parts = expand(a, b).flatMap((id) => (ev.sentences[id]?.source === first.source ? ev.sentences[id].text : []));
  const source = ev.sources.find((s) => s.n === first.source);
  return source ? { text: parts.join(" "), source } : null;
}

// Scroll-to-text fragment: opening the link highlights the quoted sentence on the page.
// Browsers match fragment text exactly, so words stay as they are; only the outer edges lose punctuation.
function deepLink({ text, source }: Quote) {
  const edge = (w: string[]) => w.join(" ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  const enc = (w: string[]) => encodeURIComponent(edge(w)).replace(/-/g, "%2D");
  const words = text.split(" ");
  const frag = words.length > 8 ? `${enc(words.slice(0, 4))},${enc(words.slice(-3))}` : enc(words);
  return `${source.url.split("#")[0]}#:~:text=${frag}`;
}

function Clipping({ q }: { q: Quote }) {
  return (
    <figure className="clip">
      <blockquote>
        <mark>{q.text}</mark>
      </blockquote>
      <figcaption>
        <span className="stamp">verbatim</span>
        <a href={deepLink(q)} target="_blank" rel="noreferrer">
          {q.source.domain}
          {q.source.published && ` · ${q.source.published}`} ↗
        </a>
      </figcaption>
    </figure>
  );
}

function inline(text: string, ev: Evidence | null | undefined, key: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const k = `${key}-${i}`;
    if (part.startsWith("**")) return <strong key={k}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`")) return <code key={k}>{part.slice(1, -1)}</code>;
    if (part.startsWith("[[")) {
      const [, a, b] = [...part.matchAll(REF)][0];
      const q = ev && resolve(a, b, ev);
      if (!q) return null;
      return (
        <a key={k} className="cite" href={deepLink(q)} target="_blank" rel="noreferrer">
          {q.source.domain}
          <span className="tip">
            <mark>{q.text}</mark>
          </span>
        </a>
      );
    }
    // The model was told not to type quotes, but sometimes does. Only ones found word for word get the highlighter.
    if (/^["“]/.test(part)) {
      const said = norm(part.slice(1, -1));
      const verbatim = ev && Object.values(ev.sentences).some((s) => norm(s.text).includes(said));
      return verbatim ? <mark key={k} title="Word for word from a source">{part}</mark> : part;
    }
    const link = part.match(/^\[([^\]]+)\]\((https?:[^)]+)\)$/);
    if (link)
      return (
        <a key={k} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    return part;
  });
}

type Block = { kind: "p" | "ul" | "ol" | "quote" | "h"; lines: string[] };

function blocks(text: string): Block[] {
  const out: Block[] = [];
  let cur: Block | null = null;
  const push = (kind: Block["kind"], line: string) => {
    if (cur?.kind !== kind || kind === "quote" || kind === "h") out.push((cur = { kind, lines: [] }));
    cur!.lines.push(line);
  };
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) cur = null;
    else if (QUOTE_LINE.test(t)) push("quote", t);
    else if (KICKER.test(t)) push("h", t.replace(KICKER, "$1"));
    else if (/^[-*•]\s+/.test(t)) push("ul", t.replace(/^[-*•]\s+/, ""));
    else if (/^\d+[.)]\s+/.test(t)) push("ol", t.replace(/^\d+[.)]\s+/, ""));
    else push("p", t.replace(/^#+\s*/, ""));
  }
  return out;
}

// The quote is the point. If the model put none on its own line, lift the first one out as a clipping.
function withLeadQuote(bs: Block[], ev?: Evidence | null): Block[] {
  if (!ev || bs.some((b) => b.kind === "quote")) return bs;
  const i = bs.findIndex((b) => /\[\[s\d+/.test(b.lines.join(" ")));
  if (i < 0) return bs;
  const ref = bs[i].lines.join(" ").match(/\[\[s\d+(?:-s\d+)?\]\]/)![0];
  return [...bs.slice(0, i + 1), { kind: "quote", lines: [ref] }, ...bs.slice(i + 1)];
}

export const Answer = memo(function Answer({ text, evidence }: { text: string; evidence?: Evidence | null }) {
  // Hide a half-streamed reference like "[[s1" until it closes.
  const clean = normalizeRefs(text.replace(/(\[\[?s?\d*(?:-s?\d*)?\]?|【[^】]*)$/, ""));
  return (
    <div className="answer">
      {withLeadQuote(blocks(clean), evidence).map((b, i) => {
        const key = String(i);
        if (b.kind === "quote") {
          const quotes = [...b.lines[0].matchAll(REF)]
            .map(([, a, z]) => evidence && resolve(a, z, evidence))
            .filter(Boolean) as Quote[];
          return quotes.map((q, j) => <Clipping key={`${key}-${j}`} q={q} />);
        }
        if (b.kind === "h") return <h3 key={key}>{b.lines[0]}</h3>;
        if (b.kind === "p") return <p key={key}>{inline(b.lines.join(" "), evidence, key)}</p>;
        const List = b.kind;
        return (
          <List key={key}>
            {b.lines.map((l, j) => (
              <li key={j}>{inline(l, evidence, `${key}-${j}`)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
});
