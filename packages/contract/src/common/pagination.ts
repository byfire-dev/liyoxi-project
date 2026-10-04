// 分页与排序（约定 C42–C44）。
import { z } from "../zod.js";

export const CURSOR_LIMIT_DEFAULT = 20;
export const CURSOR_LIMIT_MAX = 50;
export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;

/** 游标分页的查询参数（商家端、下载页，约定 C42）：cursor 不透明，首页不传 */
export const CursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(CURSOR_LIMIT_MAX).default(CURSOR_LIMIT_DEFAULT),
});

/** CursorPage<T>：{ items, nextCursor, hasMore }，不返回总数（约定 C42、C87） */
export function cursorPage<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.union([z.string(), z.null()]),
    hasMore: z.boolean(),
  });
}
export type CursorPage<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };

/**
 * 页码分页的查询参数（后台，约定 C43）：page 从 1 开始。
 * 响应 { items, page, pageSize, total } 即 AdminPage<T>，归 a01，不在本包。
 */
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});

const SORT_KEY = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * 排序参数 sort（约定 C44）：逗号分隔，字段名前加 - 表示降序，如 -createdAt,orderNo。
 * 可排序字段与具名排序值（如 urgency）由各列表列在 keys 里；服务端总是追加 id 作为最后一个排序键。
 *
 * 本包定的做法：约定 C44 写“用 enum 声明可排序字段与默认排序”。sort 的取值是逗号分隔的组合，
 * 整个参数写不成 enum，所以可排序字段在契约源码里逐个列举（keys），到 OpenAPI 里是 pattern + default，
 * 生成的类型是 string。文档里要不要另列可排序字段，W0-10 接管路由前定（PR 描述第 7 节）。
 */
export function sortQuery<const K extends readonly [string, ...string[]]>(
  keys: K,
  defaultSort: string,
) {
  for (const key of keys) {
    if (!SORT_KEY.test(key)) throw new Error(`sortQuery：排序键 ${key} 须为驼峰字段名`);
  }
  const one = `-?(?:${keys.join("|")})`;
  const pattern = new RegExp(`^${one}(?:,${one})*$`);
  if (!pattern.test(defaultSort)) {
    throw new Error(`sortQuery：默认排序 ${defaultSort} 不在可排序字段内`);
  }
  return z.string().regex(pattern, "排序字段不在可选范围内").default(defaultSort);
}
