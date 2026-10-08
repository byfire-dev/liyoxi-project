/** D8 5.2：商城列表与搜索共用三字段规则；只匹配已由调用方筛为可见的目录。 */
export type SearchField = "title" | "genre" | "cast";
export interface SearchableDrama {
  readonly title: string;
  readonly genreCodes: readonly string[];
  readonly castNames: string | null;
}
export const normalizeSearch = (text: string): string => text.replace(/[\s·]/gu, "");
export function matchedFields(
  row: SearchableDrama,
  keyword: string,
  genres: ReadonlyMap<string, string>,
): SearchField[] {
  const q = normalizeSearch(keyword);
  if (!q) return [];
  const fields: SearchField[] = [];
  if (normalizeSearch(row.title).includes(q)) fields.push("title");
  if (
    row.genreCodes.some((code) => {
      const name = genres.get(code);
      if (!name) return false;
      const normalized = normalizeSearch(name);
      return normalized.includes(q) || q.includes(normalized);
    })
  )
    fields.push("genre");
  if (row.castNames && normalizeSearch(row.castNames).includes(q)) fields.push("cast");
  return fields;
}
