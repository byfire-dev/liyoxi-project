import { newIdempotencyKey } from "../../../lib/idempotency";
import { readQueueSearch } from "../../../lib/queue";
import type { AccountDetail, ApproveBody, RejectBody, Template } from "./api";
export const ACCOUNTS_KEY = ["publish", "account-review"] as const;
export const fields = [
  "account_name",
  "account_uid",
  "account_type",
  "cert_subject_name",
  "account_status",
] as const;
export type Field = (typeof fields)[number];
export const fieldLabels: Record<Field, string> = {
  account_name: "账号名称",
  account_uid: "账号 ID",
  account_type: "账号类型",
  cert_subject_name: "认证主体",
  account_status: "账号状态",
};
export const accountTypes = { enterprise: "企业号", personal: "个人号", none: "未认证" } as const;
export type AccountType = keyof typeof accountTypes;
export type Draft = Record<Field, { recognized: string; match: boolean | null }>;
export function accountSearch(raw: Readonly<Record<string, unknown>>) {
  const search = readQueueSearch(raw);
  return {
    ...search,
    tab: search.tab === "done_today" ? "done_today" : "todo",
    q: search.q?.slice(0, 30),
  };
}
export function initialDraft(detail: Pick<AccountDetail, "compareRows">): Draft {
  const entry = (field: Field) => {
    const row = detail.compareRows.find((item) => item.field === field);
    return { recognized: row?.recognized ?? "", match: row?.match ?? null };
  };
  return {
    account_name: entry("account_name"),
    account_uid: entry("account_uid"),
    account_type: entry("account_type"),
    cert_subject_name: entry("cert_subject_name"),
    account_status: entry("account_status"),
  };
}
export function compareBody(
  draft: Draft,
  type: AccountType,
  approving: boolean,
): ApproveBody["compareRows"] | null {
  if (fields.some((field) => draft[field].match === null || draft[field].recognized.length > 100))
    return null;
  return fields.map((field) => ({
    field,
    recognized:
      approving && type !== "enterprise" && field === "cert_subject_name"
        ? null
        : draft[field].recognized.trim() || null,
    match: draft[field].match === true,
  }));
}
type DecisionDetail = Pick<AccountDetail, "roundNo" | "filled"> & {
  approval: Pick<AccountDetail["approval"], "lockVersion" | "confirmChecks">;
  account: { store: Pick<AccountDetail["account"]["store"], "entityName"> };
};
export function approveBody(
  detail: DecisionDetail,
  draft: Draft,
  type: AccountType,
  template: Pick<Template, "versionNo" | "items"> | undefined,
  checked: readonly string[],
): ApproveBody | null {
  const compareRows = compareBody(draft, type, true);
  if (!compareRows || compareRows.some((row) => !row.match)) return null;
  const cert = draft.cert_subject_name.recognized.trim();
  if (
    type === "enterprise" &&
    (!cert ||
      cert.replace(/\s/g, "") !== (detail.account.store.entityName ?? "").replace(/\s/g, ""))
  )
    return null;
  if (detail.approval.confirmChecks.some((key) => !checked.includes(`confirm:${key}`))) return null;
  if (!Object.hasOwn(accountTypes, draft.account_type.recognized)) return null;
  if (template?.items.some((item) => item.required && !checked.includes(item.key))) return null;
  return {
    lockVersion: detail.approval.lockVersion,
    confirm: { roundNo: detail.roundNo, accountUid: detail.filled.accountUid },
    accountType: type,
    certSubjectName: type === "enterprise" ? cert : null,
    compareRows,
    confirmChecks: detail.approval.confirmChecks.filter((key) =>
      checked.includes(`confirm:${key}`),
    ),
    ...(template
      ? {
          checklistVersionNo: template.versionNo,
          results: template.items
            .filter((item) => checked.includes(item.key))
            .map((item) => ({ key: item.key, result: "pass" as const })),
        }
      : {}),
  };
}
export function rejectBody(
  draft: Draft,
  type: AccountType,
  reason: string,
  note: string,
): RejectBody | null {
  const compareRows = compareBody(draft, type, false),
    text = note.trim();
  return reason && text && text.length <= 200 && compareRows
    ? { reasonCode: reason, note: text, compareRows }
    : null;
}
export function createDecisionIntent(newKey = () => newIdempotencyKey("account-review")) {
  let busy = false,
    fingerprint = "",
    key = "";
  return async <T>(payload: unknown, send: (key: string) => Promise<T>): Promise<T | null> => {
    if (busy) return null;
    const next = JSON.stringify(payload);
    if (next !== fingerprint) {
      fingerprint = next;
      key = newKey();
    }
    busy = true;
    try {
      return await send(key);
    } finally {
      busy = false;
    }
  };
}
