import { AdPricingSnapshotSchema } from "@liyoxi/contract";
import type { PrismaClient } from "@liyoxi/db";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import { SYSTEM_SCOPE } from "../authz/index.js";
import { createAdCancel, quoteAdCancel } from "../order/index.js";
import type { CancelActor, CancelDeps } from "../order/index.js";
import { createSla } from "../sla/index.js";
import { bindPublish, createPublish } from "../publish/index.js";
import type { Runtime } from "../runtime.js";
import { createLedgerHarness, openTerm } from "./billing.js";
import type { AdjustableClock } from "./clock.js";
import { sampleStaffContext } from "./approval.js";
let sequence = 50100;

/** Test composition stays outside the order domain's same-layer dependency surface. */
export function createW501Publish(deps: Parameters<typeof createPublish>[0]) {
  return { publish: createPublish(deps), unbindPublish: bindPublish(deps.assembly) };
}

/** Until W5-08 provides an ad producer, seed only the upstream ad; hold and cancel are real writers. */
export async function prepareW501AdCancel(
  prisma: PrismaClient,
  runtime: Pick<Runtime, "tx" | "clock" | "assembly" | "approval" | "flow" | "events" | "timers">,
  clock: AdjustableClock,
  input: { requesterId: string; approverId: string; captured?: boolean },
) {
  clock.advance(1);
  const h = createLedgerHarness(prisma, { clock }),
    now = clock.now();
  await prisma.paramValue.create({
    data: {
      id: uuidv7(),
      key: "refund.points.auto_approve_before_production",
      value: false,
      effectiveAt: now,
      createdAt: now,
      createdByStaffId: input.requesterId,
      reason: "HTTP取消执行公共前置",
    },
  });
  const merchant = await h.make.merchant({ verified: true }),
    { term } = await openTerm(h, { entityId: merchant.entity.id });
  const id = uuidv7(),
    adNo = `GG20260105${++sequence}`,
    ctx = createIdentityContext({
      actor: { type: "system", job: "lyxtest.w501_upstream_ad" },
      entityId: merchant.entity.id,
    });
  const held = await h.tx.run((tx) =>
    h.ledger.hold(tx, {
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      refType: "ad",
      refId: id,
      pricing: { kind: "ad" },
      title: { code: "ad_hold", args: { adNo, unitPoints: 50, discountBp: term.discountBp } },
      ctx,
    }),
  );
  if (input.captured)
    await h.tx.run((tx) =>
      h.ledger.capture(tx, {
        pointHoldId: held.pointHoldId,
        title: { refType: "ad", refNo: adNo, count: 1 },
        ctx,
      }),
    );
  const pricing = AdPricingSnapshotSchema.parse(held.snapshot),
    hold = await prisma.pointHold.findUniqueOrThrow({ where: { id: held.pointHoldId } }),
    consent = await h.make.agreementConsent({
      scene: "ad_request",
      merchantUserId: merchant.user.id,
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      bizId: id,
    });
  const editor = input.captured ? await h.make.staff({ staffRoleKey: "editor" }) : null;
  const ad = await prisma.ad.create({
    data: {
      id,
      adNo,
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      requestedByUserId: merchant.user.id,
      type: "opening",
      durationSec: 3,
      promoPointCodes: ["TEST"],
      status: input.captured ? "producing" : "pending_assign",
      unitPricePoints: pricing.unitPoints,
      discountBp: pricing.discountBp,
      chargePoints: held.points,
      pricingSnapshot: held.snapshot,
      pointHoldId: held.pointHoldId,
      capturedAt: hold.capturedAt,
      editorId: editor?.id ?? null,
      freeRevisionQuota: pricing.freeRevisions,
      agreementConsentId: consent.id,
      submittedAt: now,
      firstDueAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  const actor = async (staffId: string): Promise<CancelActor> => ({
    ctx: createIdentityContext({ actor: { type: "staff", id: staffId, client: "admin" } }),
    staff: await sampleStaffContext(prisma, staffId, { stepUpAt: clock.now() }),
  });
  const deps: CancelDeps = {
      ...runtime,
      ledger: h.ledger,
      sla: createSla({ clock, assembly: runtime.assembly }),
    },
    service = createAdCancel(deps);
  const reasonCode = input.captured ? ("platform_fault" as const) : ("merchant_request" as const);
  const quote = await runtime.tx.run((tx) =>
    quoteAdCancel(tx, { scope: SYSTEM_SCOPE, adId: ad.id, body: { reasonCode } }, clock.now()),
  );
  const submitted = await service.submit(await actor(input.requesterId), ad.id, {
    reasonCode,
    note: "真实HTTP执行前置",
    expect: quote.expect,
  });
  const request = await service.approve(await actor(input.approverId), submitted.id, {
    lockVersion: submitted.approvalRequest.lockVersion,
    confirm: {
      requestNo: submitted.approvalRequest.requestNo!,
      totalRefundPoints: submitted.totalRefundPoints,
    },
    confirmChecks: ["stage_rule_amount_checked"],
  });
  return {
    ad,
    merchant,
    request,
    confirm: {
      requestNo: submitted.approvalRequest.requestNo!,
      totalRefundPoints: submitted.totalRefundPoints,
    },
    deps,
    actor,
  };
}
