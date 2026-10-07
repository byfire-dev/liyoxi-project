/** 公开契约 safeParse 的结构端口。wire 保留 CSV/布尔字符串，parsed 只供读取校验结果。 */
export interface QuerySchema<Parsed> {
  safeParse: (
    input: unknown,
  ) =>
    | { success: true; data: Parsed }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[] }[] } };
}

export interface ContractQueryOptions {
  keys: readonly string[];
  defaults?: Readonly<Record<string, string>>;
  keywordLimit?: number;
  /** 跨字段校验指向缺失字段时，明确删除哪一个调用方可选参数。 */
  recover?: Readonly<Record<string, readonly string[]>>;
}

export function readContractQuery<Parsed>(
  schema: QuerySchema<Parsed>,
  raw: Readonly<Record<string, unknown>>,
  { keys, defaults = {}, keywordLimit, recover = {} }: ContractQueryOptions,
): { wire: Record<string, string>; parsed: Parsed } {
  const allowed = new Set(keys);
  const wire: Record<string, string> = { ...defaults };
  for (const key of keys) {
    const value = raw[key];
    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value))
    )
      continue;
    const text = String(value).trim();
    if (text)
      wire[key] = key === "q" && keywordLimit !== undefined ? text.slice(0, keywordLimit) : text;
  }
  // 每轮只恢复契约报错字段；合法字段（包括 CSV wire）不受别的坏参数影响。
  for (let attempt = 0; attempt <= keys.length; attempt++) {
    const result = schema.safeParse(wire);
    if (result.success) return { wire, parsed: result.data };
    let changed = false;
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? "");
      for (const field of recover[key] ?? [key]) {
        if (!allowed.has(field)) continue;
        if (defaults[field] !== undefined && wire[field] !== defaults[field]) {
          wire[field] = defaults[field];
          changed = true;
        } else if (field in wire && !(field in defaults)) {
          delete wire[field];
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  // 调用方缺省必须本身符合契约；配置错误不能伪装为合法请求。
  const fallback = schema.safeParse(defaults);
  if (!fallback.success) throw new Error("查询缺省不符合契约");
  return { wire: { ...defaults }, parsed: fallback.data };
}
