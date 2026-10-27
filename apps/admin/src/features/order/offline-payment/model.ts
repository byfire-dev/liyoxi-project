import {
  AdminPaymentOrderCreateBodySchema,
  AdminTransferProofCreateBodySchema,
} from "@liyoxi/contract";
import type { AccountRow } from "../../billing/accounts/api";
import type { PlansApi } from "../../billing/plans/api";
import type { PointPack } from "../../billing/point-packs/api";
export interface OfflineDraft {
  kind: "plan" | "topup";
  planId?: string;
  months?: number;
  intent?: "upgrade_now" | "renew_next_term";
  pointPackId?: string;
  storeId?: string;
  contractNo: string;
}
export type EntityQuote = Extract<Awaited<ReturnType<PlansApi["quote"]>>, { scope: "entity" }>;
export interface BoundEntityQuote {
  accountId: string;
  planId: string;
  months?: number;
  intent?: OfflineDraft["intent"];
  result: EntityQuote;
}
export function snapshotOfflinePack(pack: PointPack | undefined): PointPack | undefined {
  return pack ? structuredClone(pack) : undefined;
}
export function offlineBody(
  account: AccountRow,
  draft: OfflineDraft,
  source: { quote?: BoundEntityQuote; pack?: PointPack },
) {
  const amount = draft.kind === "plan" ? source.quote?.result.quote.payFen : source.pack?.priceFen;
  if (
    draft.kind === "plan" &&
    (!source.quote ||
      source.quote.accountId !== account.pointAccountId ||
      source.quote.planId !== draft.planId ||
      source.quote.result.quote.planId !== draft.planId ||
      source.quote.intent !== draft.intent ||
      source.quote.months !== (draft.intent === "upgrade_now" ? undefined : draft.months))
  )
    throw new Error("请重新获取本主体的套餐报价");
  if (
    draft.kind === "topup" &&
    (!source.pack || !source.pack.isListed || source.pack.pointPackId !== draft.pointPackId)
  )
    throw new Error("请重新选择当前上架积分包");
  return AdminPaymentOrderCreateBodySchema.parse({
    entityId: account.entity.entityId,
    ...(draft.storeId ? { storeId: draft.storeId } : {}),
    kind: draft.kind,
    ...(draft.kind === "plan"
      ? {
          planId: draft.planId,
          ...(draft.intent ? { intent: draft.intent } : {}),
          ...(draft.intent !== "upgrade_now" ? { months: draft.months } : {}),
        }
      : { pointPackId: draft.pointPackId }),
    contractNo: draft.contractNo,
    expectAmountFen: amount,
    confirm: { entityName: account.entity.name, amountFen: amount },
  });
}
export function proofBody(fileId: string | null, note: string) {
  if (!fileId) throw new Error("请先完成凭证入库");
  return AdminTransferProofCreateBodySchema.parse({
    fileId,
    ...(note.trim() ? { note: note.trim() } : {}),
  });
}
