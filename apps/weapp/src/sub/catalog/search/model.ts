import { normalizeKeyword } from "../../../lib/search-history";
import type { SearchPage } from "./api";

export interface HighlightPart {
  text: string;
  hit: boolean;
}
/** 只切分服务器已经判定命中的展示文字，不重算匹配/排序，不注入 HTML。 */
export function highlight(
  text: string,
  q: string,
  matched: boolean,
  genre = false,
): HighlightPart[] {
  const normalized = normalizeKeyword(text),
    keyword = normalizeKeyword(q);
  if (!matched || !keyword || !normalized) return [{ text, hit: false }];
  if (genre && keyword.includes(normalized)) return [{ text, hit: true }];
  const start = normalized.indexOf(keyword);
  if (start < 0) return [{ text, hit: false }];
  // normalized 的 UTF-16 索引映回原文字；空格/中点保留在画面里。
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i++) if (!/[\s·]/u.test(text[i]!)) offsets.push(i);
  const from = offsets[start]!,
    to = offsets[start + keyword.length - 1]! + 1;
  return [
    { text: text.slice(0, from), hit: false },
    { text: text.slice(from, to), hit: true },
    { text: text.slice(to), hit: false },
  ].filter((part) => part.text !== "");
}
function unique<T extends { dramaId: string }>(previous: T[], next: T[]): T[] {
  const seen = new Set(previous.map((item) => item.dramaId));
  return [
    ...previous,
    ...next.filter((item) => !seen.has(item.dramaId) && Boolean(seen.add(item.dramaId))),
  ];
}
export function mergeSearchPage(previous: SearchPage, next: SearchPage): SearchPage {
  if (previous.viewerRole === "owner" && next.viewerRole === "owner")
    return { ...next, items: unique(previous.items, next.items) };
  if (previous.viewerRole === "clerk" && next.viewerRole === "clerk")
    return { ...next, items: unique(previous.items, next.items) };
  if (previous.viewerRole === "guest" && next.viewerRole === "guest")
    return { ...next, items: unique(previous.items, next.items) };
  return next;
}
export const searchError = (error: unknown): string =>
  error instanceof Error ? error.message : "网络异常，请检查网络后重试";
