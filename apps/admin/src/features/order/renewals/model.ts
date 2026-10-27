import { TermExtensionRequestCreateBodySchema } from "@liyoxi/contract";
import { idValue } from "../../billing/plans/model";
import { keyword, pageNumber, pageSize } from "../../billing/accounts/model";
import type { RenewalsApi, TermRow } from "./api";
export function renewalSearch(raw: Record<string, unknown>) {
  return {
    q: keyword(raw.q),
    managerId: idValue(raw.managerId),
    planId: idValue(raw.planId),
    page: pageNumber(raw.page),
    pageSize: pageSize(raw.pageSize),
    tab:
      raw.tab === "expired"
        ? ("expired" as const)
        : raw.tab === "renewed"
          ? ("renewed" as const)
          : ("expiring" as const),
    termId: idValue(raw.termId),
  };
}
export function renewalFilters(search: ReturnType<typeof renewalSearch>) {
  return { q: search.q, managerId: search.managerId, planId: search.planId };
}
export function extensionBody(
  row: Pick<TermRow, "subscriptionTermId" | "endDate">,
  draft: { days: number; reasonCode: string; note: string },
  quote: Awaited<ReturnType<RenewalsApi["quote"]>>,
) {
  if (
    quote.days !== draft.days ||
    quote.mode === "not_applicable" ||
    quote.blockReasons.length ||
    !quote.targetSubscriptionTermId ||
    !quote.newEndDate
  )
    throw new Error("请重新核对有效延长试算");
  return TermExtensionRequestCreateBodySchema.parse({
    ...draft,
    subscriptionTermId: row.subscriptionTermId,
    confirm: { subscriptionTermId: row.subscriptionTermId, endDate: row.endDate },
  });
}
