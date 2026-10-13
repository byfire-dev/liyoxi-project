import { IdSchema } from "@liyoxi/contract";
import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { formatMoneyFixed } from "@liyoxi/shared/format/money";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { canAction, hasModuleLevel, type AccessSnapshot } from "../../../lib/permissions";
export const MERCHANT_KEY = ["merchant", "management"] as const;
export const DETAIL_TABS = [
  "profile",
  "qualification",
  "entity",
  "follow",
  "accounts",
  "activity",
] as const;
export function merchantDetailSearch(raw: Readonly<Record<string, unknown>>) {
  return {
    tab:
      typeof raw.tab === "string" && DETAIL_TABS.some((tab) => tab === raw.tab)
        ? raw.tab
        : "profile",
  };
}
export function validStoreId(value: unknown): value is string {
  return IdSchema.safeParse(value).success;
}
export const merchantScope = (access: AccessSnapshot | null) =>
  access
    ? JSON.stringify([
        access.staff.id,
        access.moduleLevels,
        access.actions,
        access.dataScope,
        access.isLead,
      ])
    : "anonymous";
export function text(value: unknown, limit = 160): string {
  return typeof value === "string" && value
    ? Array.from(value)
        .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char))
        .slice(0, limit)
        .join("")
    : "—";
}
export function moment(value: string | null | undefined) {
  return value ? appDateTimeFormat.dateTimeFull(value) : "—";
}
export function amount(fen: number | null | undefined) {
  return fen === null || fen === undefined ? "—" : formatMoneyFixed(fen);
}
export function status(value: unknown, column: string) {
  return typeof value === "string"
    ? (statusToneByEnum(column, value)?.admin?.label ?? text(value))
    : "未识别状态";
}
export function allowed(
  access: AccessSnapshot | null,
  permission: string,
  actions: readonly unknown[],
  action: string,
) {
  return (
    hasModuleLevel(access, "merchant") && canAction(access, permission) && actions.includes(action)
  );
}
export function formError(error: unknown) {
  return error instanceof Error && error.name !== "ZodError"
    ? error.message
    : "请核对必填项、格式、原因与当前确认信息";
}
