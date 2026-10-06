import { AppError } from "../../kernel/index.js";

export type MerchantViewerRole = "owner" | "clerk" | "guest";
export type MerchantViewSchemas<T> = Partial<
  Record<MerchantViewerRole, { parse(input: unknown): T }>
>;

/** C55：角色来自观察者；传入裁剪前结果。幂等保存必须发生在调用本函数之前。 */
export function cropMerchantView<T>(
  role: MerchantViewerRole,
  schemas: MerchantViewSchemas<T>,
  result: unknown,
): T {
  const schema = schemas[role];
  if (schema === undefined) throw new AppError("ROLE_FORBIDDEN");
  const value =
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    "viewerRole" in result
      ? { ...result, viewerRole: role }
      : result;
  return schema.parse(value);
}
