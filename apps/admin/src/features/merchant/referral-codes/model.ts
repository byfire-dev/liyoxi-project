import { ReferralCodeCreateBodySchema, ReferralCodeListQuerySchema } from "@liyoxi/contract";
import { readContractQuery } from "../../../lib/contract-query";
import { canAction, hasModuleLevel, type AccessSnapshot } from "../../../lib/permissions";
import type { ReferralQuery, ReferralRow } from "./api";

export const REFERRAL_KEY = ["merchant", "referral-codes"] as const;
export const REFERRAL_FILTERS = ["sourceType", "status", "ownerStaffId"] as const;
export function referralSearch(raw: Readonly<Record<string, unknown>>): Record<string, string> {
  const candidate = { ...raw };
  if (![10, 20, 50].includes(Number(candidate.pageSize))) delete candidate.pageSize;
  return readContractQuery(ReferralCodeListQuerySchema, candidate, {
    keys: ["q", "page", "pageSize", ...REFERRAL_FILTERS],
    defaults: { page: "1", pageSize: "20" },
    keywordLimit: 30,
  }).wire;
}
export function referralQuery(raw: Readonly<Record<string, unknown>>): ReferralQuery {
  const { page, pageSize, ...filters } = referralSearch(raw);
  return { ...filters, page: Number(page), pageSize: Number(pageSize) };
}
export function canManageReferral(access: AccessSnapshot | null) {
  return hasModuleLevel(access, "merchant") && canAction(access, "merchant.referral_code.manage");
}
export function referralAction(
  access: AccessSnapshot | null,
  row: ReferralRow,
): "enable" | "disable" | undefined {
  if (!canManageReferral(access)) return undefined;
  return row.status === "active" ? "disable" : row.status === "disabled" ? "enable" : undefined;
}
export const sourceOptions = [
  { value: "sales", label: "销售码" },
  { value: "campaign", label: "活动码" },
  { value: "partner", label: "合作渠道码" },
];
export const statusOptions = [
  { value: "active", label: "启用" },
  { value: "disabled", label: "停用" },
];
export const sourceLabel = (value: string) =>
  sourceOptions.find((item) => item.value === value)?.label ?? "未识别来源";
export const statusLabel = (value: string) =>
  statusOptions.find((item) => item.value === value)?.label ?? "未识别状态";
export function referralBody(draft: {
  code: string;
  sourceType: "sales" | "campaign";
  ownerStaffId: string;
  label: string;
}) {
  return ReferralCodeCreateBodySchema.safeParse({
    code: draft.code,
    sourceType: draft.sourceType,
    ...(draft.sourceType === "sales" && draft.ownerStaffId
      ? { ownerStaffId: draft.ownerStaffId }
      : {}),
    ...(draft.label.trim() ? { label: draft.label } : {}),
  });
}
