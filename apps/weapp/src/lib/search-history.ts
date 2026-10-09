import type { KeyValueStorage } from "./platform";
import { StorageKey } from "./storage";

/** 与 m.drama.search 的输入合同一致；历史不保存原始空白。 */
export const normalizeKeyword = (text: string): string => text.replace(/[\s·]/gu, "");
export const validKeyword = (text: string): boolean => {
  const length = [...normalizeKeyword(text)].length;
  return length >= 1 && length <= 20;
};
export function createSearchHistory(storage: KeyValueStorage) {
  const read = (): string[] => {
    const value = storage.get<unknown>(StorageKey.searchHistory);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    for (const item of value) {
      if (typeof item !== "string" || !validKeyword(item)) continue;
      seen.add(normalizeKeyword(item));
      if (seen.size === 10) break;
    }
    return [...seen];
  };
  return {
    read,
    remember: (text: string): string[] => {
      if (!validKeyword(text)) return read();
      const word = normalizeKeyword(text);
      const next = [word, ...read().filter((item) => item !== word)].slice(0, 10);
      storage.set(StorageKey.searchHistory, next);
      return next;
    },
    clear: (): void => storage.remove(StorageKey.searchHistory),
  };
}
export type SearchHistory = ReturnType<typeof createSearchHistory>;
