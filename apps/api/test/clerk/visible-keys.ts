// C57：键名检查与字段路径归一化；动态字典只忽略字典键，仍递归检查值中的对象键。
import { DictRefSchema, MallConfigSchema } from "@liyoxi/contract";

const FORBIDDEN = /points|balance|amount|price|contract|invoice|uscc|license|phone/i;
export const CLERK_DICTIONARY_PATHS = ["flags", "versions.dict", "versions.site", "copy"] as const;
/** 目录标价例外按 operationId + 完整字段路径登记，不是全局按键名放行。后续目录包只增。 */
export const CLERK_CATALOG_PRICE_PATHS: Readonly<Record<string, readonly string[]>> = {
  // m03 §2.5、A86：公开服务标价保留在店员视图。
  "m.storeProfile.service.get": ["serviceItems[].priceFen", "serviceItems[].originalPriceFen"],
  // m03 §2.7、A86：素材菜单价格文字沿正式详情字段路径登记。
  "m.storeAsset.get": ["structuredItems[].priceText"],
  "m.storeAsset.portraitAuth.create": ["structuredItems[].priceText"],
  // 目录包在此按 operationId 只增完整字段路径。
  "m.drama.list": ["items[].listPricePoints"],
  "m.drama.search": ["items[].listPricePoints"],
  "m.drama.get": ["listPricePoints", "adUnitPoints"],
};

/** m04 §3.3 的公开筛选元数据：仅完整路径与既定类型，分档沿用契约的严格边界。 */
function isMallFilter(operationId: string, path: string, value: unknown): boolean {
  if (operationId !== "m.mallConfig.get") return false;
  if (path === "filters.price") return typeof value === "boolean";
  return (
    path === "filters.priceBands" &&
    MallConfigSchema.shape.filters.shape.priceBands.safeParse(value).success
  );
}

const sellingPointRefs = DictRefSchema.strict().array();

/** m03 §2.5 的公开卖点标签，仅顶层既定 DictRef[]；不开放积分或其它同名字段。 */
function isSellingPoints(operationId: string, path: string, value: unknown): boolean {
  return (
    operationId === "m.storeProfile.service.get" &&
    path === "sellingPoints" &&
    sellingPointRefs.safeParse(value).success
  );
}

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
      const invitationDecision =
        operationId === "m.invitation.lookup" &&
        path === "isPhoneRestricted" &&
        typeof child === "boolean";
      if (
        !dictionary &&
        !loginDecision &&
        !invitationDecision &&
        !isMallFilter(operationId, path, child) &&
        !isSellingPoints(operationId, path, child) &&
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
