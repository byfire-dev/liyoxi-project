import {
  DateSchema,
  PointAdjustmentInputSchema,
  PointAdjustmentRequestCreateBodySchema,
} from "@liyoxi/contract";
import { idValue } from "../plans/model";
export const pageSize = (value: unknown): 10 | 20 | 50 =>
  value === 10 || value === "10" ? 10 : value === 50 || value === "50" ? 50 : 20;
export const pageNumber = (value: unknown) =>
  Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 1;
export const dateValue = (value: unknown) =>
  DateSchema.safeParse(value).success ? String(value) : undefined;
export const keyword = (value: unknown) =>
  typeof value === "string" ? value.trim().slice(0, 100) || undefined : undefined;
export function accountSearch(raw: Record<string, unknown>) {
  return {
    page: pageNumber(raw.page),
    pageSize: pageSize(raw.pageSize),
    q: keyword(raw.q),
    planId: idValue(raw.planId),
    subStatus:
      raw.subStatus === "active"
        ? ("active" as const)
        : raw.subStatus === "expired"
          ? ("expired" as const)
          : raw.subStatus === "none"
            ? ("none" as const)
            : undefined,
    flag:
      raw.flag === "has_held"
        ? ("has_held" as const)
        : raw.flag === "expiring_7d"
          ? ("expiring_7d" as const)
          : raw.flag === "refund_pending"
            ? ("refund_pending" as const)
            : undefined,
    sort:
      raw.sort === "-spendablePoints"
        ? ("-spendablePoints" as const)
        : raw.sort === "planPointsExpireAt"
          ? ("planPointsExpireAt" as const)
          : ("-updatedAt" as const),
    accountId: idValue(raw.accountId),
    ledgerTab:
      raw.ledgerTab === "gain"
        ? ("gain" as const)
        : raw.ledgerTab === "use"
          ? ("use" as const)
          : raw.ledgerTab === "expire"
            ? ("expire" as const)
            : ("all" as const),
    lotKind:
      raw.lotKind === "plan"
        ? ("plan" as const)
        : raw.lotKind === "addon"
          ? ("addon" as const)
          : undefined,
    storeId: idValue(raw.storeId),
    occurredFrom: dateValue(raw.occurredFrom),
    occurredTo: dateValue(raw.occurredTo),
    cursor: typeof raw.cursor === "string" && raw.cursor.length <= 2048 ? raw.cursor : undefined,
    ledgerLimit: pageSize(raw.ledgerLimit),
  };
}
export function accountFilters(search: ReturnType<typeof accountSearch>) {
  return { q: search.q, planId: search.planId, subStatus: search.subStatus, flag: search.flag };
}
export function ledgerQuery(search: ReturnType<typeof accountSearch>) {
  return {
    tab: search.ledgerTab,
    lotKind: search.lotKind,
    storeId: search.storeId,
    occurredFrom: search.occurredFrom,
    occurredTo: search.occurredTo,
    cursor: search.cursor,
    limit: search.ledgerLimit,
  };
}
export interface AdjustmentDraft {
  direction: "increase" | "decrease";
  lotKind: "plan" | "addon";
  adjustPoints?: number;
  reasonCode?: string;
  pointHoldId?: string;
  note: string;
  storeId?: string;
  termExtensionRequestId?: string;
  serviceTicketId?: string;
}
export function adjustmentInput(draft: AdjustmentDraft) {
  return PointAdjustmentInputSchema.parse({
    direction: draft.direction,
    lotKind: draft.lotKind,
    adjustPoints: draft.adjustPoints,
    reasonCode: draft.reasonCode,
    ...(draft.pointHoldId ? { pointHoldId: draft.pointHoldId } : {}),
  });
}
/** confirm只取本次真实试算，不能用余额差或默认值重算。 */
export function adjustmentBody(
  accountId: string,
  draft: AdjustmentDraft,
  quote: { isAllowed: boolean; spendableBeforePoints: number },
) {
  if (!quote.isAllowed) throw new Error("当前试算不允许发起调整");
  return PointAdjustmentRequestCreateBodySchema.parse({
    ...adjustmentInput(draft),
    pointAccountId: accountId,
    note: draft.note,
    confirm: { spendableBeforePoints: quote.spendableBeforePoints },
    ...(draft.storeId ? { storeId: draft.storeId } : {}),
    ...(draft.termExtensionRequestId
      ? { termExtensionRequestId: draft.termExtensionRequestId }
      : {}),
    ...(draft.serviceTicketId ? { serviceTicketId: draft.serviceTicketId } : {}),
  });
}
