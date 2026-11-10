// Shared by server and web: how a sentence reference like [[s12]] or [[s12-s14]] is read.
export const REF = /\[\[(s\d+)(?:-(s\d+))?\]\]/g;

/** A range covers at most 5 sentences, all from the first sentence's source. */
export function expand(a: string, b?: string): string[] {
  const start = +a.slice(1);
  const end = Math.min(b ? +b.slice(1) : start, start + 4);
  return Array.from({ length: Math.max(end - start + 1, 1) }, (_, i) => `s${start + i}`);
}

const refsIn = (s: string) =>
  (s.match(/s\d+(?:\s*[-–]\s*s\d+)?/g) ?? []).map((r) => `[[${r.replace(/\s*[-–]\s*/, "-")}]]`).join("");

/** Models drift from [[s3]]: gpt-oss writes 【s3】, others [s3] or [[s3, s5]]. Read them all the same way. */
export const normalizeRefs = (text: string) =>
  text.replace(/【[^】]*】|\[\[[^[\]]*\]\]|(?<!\[)\[s\d+(?:\s*[-–]\s*s\d+)?\](?![\](])/g, refsIn);
