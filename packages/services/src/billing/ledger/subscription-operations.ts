// 订阅升级的窄账本写者。调用方已持有同主体账户锁并完成advance；所有批次仍经原writeOperation落库。
import type { BillingOrder, SubscriptionTerm } from "@liyoxi/db";
import type { BillingOrderContent } from "@liyoxi/contract";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import type { LedgerClock } from "./context.js";
import type { AccountState } from "./operation.js";
import { findOperation, writeOperation } from "./operation.js";
import { selfCheck } from "./self-check.js";
import type { LedgerDeps } from "./types.js";

type UpgradeContent = Extract<BillingOrderContent, { kind: "upgrade" }>;

export async function grantUpgradeMonth(
  tx: Tx,
  deps: LedgerDeps,
  clock: LedgerClock,
  account: AccountState,
  term: SubscriptionTerm,
  order: BillingOrder,
  content: UpgradeContent,
  monthNo: number,
  ctx: IdentityContext,
): Promise<readonly string[]> {
  const opKey = `grant:upgrade:${order.id}:${monthNo}`;
  const existing = await findOperation(tx, opKey);
  if (existing)
    return (
      await tx.pointLot.findMany({
        where: { sourceType: "grant_upgrade", sourceId: order.id, sourceNo: monthNo },
        select: { id: true },
      })
    ).map((row) => row.id);
  const first = monthNo === content.monthIndex;
  const points = first ? content.topupPoints : content.pointsDeltaPerMonth;
  const cost = first ? content.proratedFen : content.feeDeltaPerMonthFen;
  const written = await writeOperation(tx, deps, clock, account, {
    opKey,
    opType: "grant",
    ref: { type: "billing_order", id: order.id },
    occurredAt: clock.now,
    bizDate: clock.today,
    ctx,
    gateOpen: true,
    title: {
      code: "grant_upgrade",
      args: {
        toMonthlyPoints: term.monthlyPoints + content.pointsDeltaPerMonth,
        fromMonthlyPoints: term.monthlyPoints,
        remainingDays: content.remainingDays,
        baseDays: content.baseDays,
        billingOrderNo: order.orderNo,
      },
    },
    newLots:
      points > 0
        ? [
            {
              kind: "plan",
              sourceType: "grant_upgrade",
              sourceId: order.id,
              sourceNo: monthNo,
              subscriptionTermId: term.id,
              planId: term.planId,
              planRevisionId: content.toPlanRevisionId,
              expiresAt: term.endsAt,
              qty: points,
              costBasisFen: cost,
            },
          ]
        : [],
  });
  await selfCheck(tx, clock, written);
  return written.lotIds;
}
