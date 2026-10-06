// C57：键名检查与字段路径归一化；动态字典只忽略字典键，仍递归检查值中的对象键。
const FORBIDDEN = /points|balance|amount|price|contract|invoice|uscc|license|phone/i;
export const CLERK_DICTIONARY_PATHS = ["flags", "versions.dict", "versions.site", "copy"] as const;
/** 目录标价例外按 operationId + 完整字段路径登记，不是全局按键名放行。后续目录包只增。 */
export const CLERK_CATALOG_PRICE_PATHS: Readonly<Record<string, readonly string[]>> = {};

export function clerkVisibleKeys(operationId: string, data: unknown): string[] {
  const paths = new Set<string>();
  function walk(value: unknown, parent: string) {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, `${parent}[]`);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const dictionary = (CLERK_DICTIONARY_PATHS as readonly string[]).includes(parent);
    for (const [key, child] of Object.entries(value)) {
      const path = parent ? `${parent}.${dictionary ? "*" : key}` : key;
      const loginDecision =
        operationId === "m.session.create" && path === "needPhone" && typeof child === "boolean";
      if (
        !dictionary &&
        !loginDecision &&
        FORBIDDEN.test(key) &&
        !key.endsWith("Mask") &&
        !(CLERK_CATALOG_PRICE_PATHS[operationId] ?? []).includes(path)
      )
        throw new Error(`店员禁用字段：${operationId} ${path}`);
      paths.add(path);
      walk(child, path);
    }
  }
  walk(data, "");
  return [...paths].sort();
}

export function assertClerkSampleCoverage(
  routes: readonly { operationId: string; "x-clerk-view"?: string }[],
  samples: readonly string[],
) {
  if (new Set(samples).size !== samples.length) throw new Error("店员回放样例重复");
  const mounted = new Set(routes.map((route) => route.operationId));
  for (const route of routes)
    if (!samples.includes(route.operationId))
      throw new Error(`缺店员回放样例：${route.operationId}`);
  for (const id of samples) if (!mounted.has(id)) throw new Error(`店员样例没有挂载：${id}`);
}
