import { divRoundHalfUp } from "@liyoxi/shared";
import { DOCUMENT_LIMITS } from "./limits.js";
import { DocumentFailure } from "./types.js";

export function normalizeDocumentText(text: string): string[] {
  const chars = [...text.normalize("NFC")].filter((char) => !/\s/u.test(char));
  if (chars.length > DOCUMENT_LIMITS.codepoints) throw new DocumentFailure("too_large");
  return chars;
}
/** Multiset Dice over Unicode codepoint bigrams; only one integer rounding. */
export function textSimilarityBp(left: string, right: string): number {
  const a = normalizeDocumentText(left);
  const b = normalizeDocumentText(right);
  if (!a.length || !b.length) return 0;
  if (a.length === 1 || b.length === 1) return a.length === b.length && a[0] === b[0] ? 10000 : 0;
  const counts = new Map<string, number>();
  for (let i = 1; i < a.length; i++) {
    const key = a[i - 1]! + a[i]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let intersection = 0;
  for (let i = 1; i < b.length; i++) {
    const key = b[i - 1]! + b[i]!;
    const count = counts.get(key) ?? 0;
    if (count) {
      intersection++;
      counts.set(key, count - 1);
    }
  }
  return divRoundHalfUp([2, intersection, 10000], [a.length + b.length - 2]);
}
