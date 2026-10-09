import type { components } from "@liyoxi/contract/types/admin";
import { STAFF_ROLE_KEY } from "@liyoxi/contract/enums";
import { permissionByKey } from "@liyoxi/contract/authz";

export type RoleDetail = components["schemas"]["RoleDetail"];
export type RoleConfig = components["schemas"]["RoleConfig"];
export type RoleBody = components["schemas"]["RoleReplaceBody"];
export const ROLE_KEY = ["system", "roles"] as const;
export function allowsLeadLimit(key: string) {
  const permission = permissionByKey(key);
  return permission?.grant.kind === "roles" && permission.grant.roles.some((row) => row.leadOnly);
}
export function roleSearch(raw: Readonly<Record<string, unknown>>): { role?: string } {
  return typeof raw.role === "string" &&
    (STAFF_ROLE_KEY.values as readonly string[]).includes(raw.role)
    ? { role: raw.role }
    : {};
}
export function roleDraft(
  value: Pick<RoleDetail, "moduleLevels" | "actions" | "dataScope">,
): Omit<RoleBody, "lockVersion"> {
  return {
    moduleLevels: { ...value.moduleLevels },
    actions: Object.fromEntries(
      Object.entries(value.actions).map(([key, action]) => [key, { ...action }]),
    ),
    dataScope: value.dataScope as RoleBody["dataScope"],
  };
}
export function roleDirty(
  current: Omit<RoleBody, "lockVersion">,
  original: Omit<RoleBody, "lockVersion">,
) {
  return JSON.stringify(current) !== JSON.stringify(original);
}
export const levelLabels = { n: "无权限", v: "查看", o: "本人任务", e: "编辑" } as const;
