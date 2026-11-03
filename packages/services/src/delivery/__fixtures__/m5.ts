import { AdPricingSnapshotSchema } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import {
  createLedgerHarness,
  deliveryChecklistForTest as checks,
  releaseM5DeliveryForTest as released,
} from "../../testing/index.js";
import type {
  DeliveryFixtureHarness as Harness,
  DeliveryProductionFixture as ProductionHarness,
  M5DeliveryFixture as M5Harness,
  M5DeliveryOrder as M5Order,
  M5DeliveryStaff as M5Staff,
} from "../../testing/index.js";

// Existing callers keep the same helpers; the shared production prerequisites live in testing.
export {
  createM5DeliveryFixture as m5Harness,
  createM5DeliveryService as m5Service,
  deliveryChecklistForTest as checks,
  prepareM5DeliveryForTest as prepared,
  createM5ProductionFile as productionFile,
  releaseM5DeliveryForTest as released,
} from "../../testing/index.js";
export type {
  M5DeliveryFixture as M5Harness,
  M5DeliveryOrder as M5Order,
  M5DeliveryStaff as M5Staff,
} from "../../testing/index.js";

let adSequence = 50300;
/** W5-08's producer is absent. Only upstream ad declaration/decision is seeded; money/probe are real. */
export async function confirmedPlacementAd(h: ProductionHarness, o: M5Order, editor: M5Staff) {
  const ledger = createLedgerHarness(h.prisma, { clock: h.clock }),
    now = h.clock.now(),
    id = uuidv7(),
    adNo = `GG20260105${++adSequence}`,
    term = await h.prisma.subscriptionTerm.findUniqueOrThrow({
      where: { id: o.order.subscriptionTermId },
    });
  // Seed the upstream grant schedule for the existing active term, then let the ledger issue it.
  await h.prisma.billingAccount.create({
    data: {
      entityId: o.entity.id,
      subStatus: "active",
      currentSubscriptionTermId: term.id,
      createdAt: now,
      updatedAt: now,
    },
  });
  const schedule = await h.prisma.grantSchedule.create({
    data: {
      id: uuidv7(),
      entityId: o.entity.id,
      subscriptionTermId: term.id,
      monthNo: 0,
      dueAt: term.startsAt,
      dueDate: new Date(calendarDate(term.startsAt)),
      points: term.monthlyPoints,
      valueFen: term.monthlyEquivFen,
      planId: term.planId,
      planRevisionId: term.planRevisionId,
      createdAt: now,
      updatedAt: now,
    },
  });
  await ledger.tx.run((tx) => ledger.ledger.grant(tx, { grantScheduleId: schedule.id }));
  const ctx = createIdentityContext({
    actor: { type: "system", job: "lyxtest.m5.upstream_ad" },
    entityId: o.entity.id,
  });
  const held = await ledger.tx.run((tx) =>
    ledger.ledger.hold(tx, {
      entityId: o.entity.id,
      storeId: o.store.id,
      refType: "ad",
      refId: id,
      pricing: { kind: "ad" },
      title: { code: "ad_hold", args: { adNo, unitPoints: 50, discountBp: term.discountBp } },
      ctx,
    }),
  );
  await ledger.tx.run((tx) =>
    ledger.ledger.capture(tx, {
      pointHoldId: held.pointHoldId,
      title: { refType: "ad", refNo: adNo, count: 1 },
      ctx,
    }),
  );
  const pricing = AdPricingSnapshotSchema.parse(held.snapshot),
    hold = await h.prisma.pointHold.findUniqueOrThrow({ where: { id: held.pointHoldId } }),
    consent = await h.make.agreementConsent({
      scene: "ad_request",
      merchantUserId: o.user.id,
      entityId: o.entity.id,
      storeId: o.store.id,
      bizId: id,
    });
  const ad = await h.prisma.ad.create({
    data: {
      id,
      adNo,
      entityId: o.entity.id,
      storeId: o.store.id,
      requestedByUserId: o.user.id,
      type: "opening",
      durationSec: 3,
      promoPointCodes: ["TEST"],
      copy: "虚构片头广告",
      status: "producing",
      editorId: editor.row.id,
      capturedAt: hold.capturedAt,
      unitPricePoints: pricing.unitPoints,
      discountBp: pricing.discountBp,
      chargePoints: held.points,
      pricingSnapshot: held.snapshot,
      pointHoldId: held.pointHoldId,
      freeRevisionQuota: pricing.freeRevisions,
      agreementConsentId: consent.id,
      submittedAt: now,
      firstDueAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  const bytes = new Uint8Array(1234);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
  const file = await h.make.fileObject({
    category: "ad_video",
    bucket: "media",
    scopeType: "store",
    entityId: o.entity.id,
    storeId: o.store.id,
    uploadActorType: "staff",
    uploadActorId: editor.row.id,
    uploadClient: "admin",
    ext: "mp4",
    mime: "video/mp4",
    declaredMime: "video/mp4",
    sizeBytes: bytes.length,
    declaredSize: bytes.length,
  });
  const etag = h.fake.storage.put({ bucket: "media", key: file.objectKey }, bytes, "video/mp4");
  await h.prisma.fileObject.update({ where: { id: file.id }, data: { etag } });
  await h.prisma.productionRecord.create({
    data: {
      fileId: file.id,
      kind: "ad",
      adId: ad.id,
      source: "manual_upload",
      aiUsage: {
        used: false,
        tools: [],
        declaredBy: editor.row.id,
        declaredAt: now.toISOString(),
        forcedByDrama: false,
      },
      aigcState: "not_required",
      pipelineState: "uploading",
      uploadedByStaffId: editor.row.id,
      createdAt: now,
      updatedAt: now,
    },
  });
  const probeJobId = await h.probe(file.id, 3000),
    info = await h.prisma.mediaInfo.findUniqueOrThrow({ where: { fileId: file.id } }),
    check = await h.prisma.mediaCheck.findUniqueOrThrow({ where: { fileId: file.id } }),
    record = await h.prisma.productionRecord.findUniqueOrThrow({ where: { fileId: file.id } });
  if (check.gate !== "pass" || record.pipelineState !== "ready")
    throw new Error("The real ad probe gate must pass before creating the upstream ad decision");
  const version = await h.prisma.adVersion.create({
    data: {
      id: uuidv7(),
      adId: ad.id,
      entityId: o.entity.id,
      storeId: o.store.id,
      versionNo: 1,
      fileId: file.id,
      durationMs: info.durationMs!,
      width: info.displayWidth!,
      height: info.displayHeight!,
      uploadedByStaffId: editor.row.id,
      uploadedAt: now,
      pushedAt: now,
      previewChannels: ["weapp"],
      decision: "confirmed",
      decidedAt: now,
      confirmViewedVia: "weapp",
      createdAt: now,
      updatedAt: now,
    },
  });
  await h.prisma.ad.update({
    where: { id: ad.id },
    data: { status: "confirmed", latestVersionNo: 1, confirmedVersionNo: 1, confirmedAt: now },
  });
  return { ad, version, file, probeJobId, held };
}

/** Pending cancellation facts only; never manufacture captured/refunded money or a terminal state. */
export async function cancellationCause(h: Harness, o: M5Order, qualification = false) {
  const now = h.clock.now(),
    id = uuidv7(),
    approvalId = uuidv7();
  const ctx = createIdentityContext({
    actor: qualification
      ? { type: "system", job: "lyxtest.m5.cancel" }
      : { type: "staff", id: o.order.deliveryManagerId!, client: "admin" },
  });
  const kind = qualification ? "qualification_cancel" : "order_cancel";
  await h.prisma.approvalRequest.create({
    data: {
      id: approvalId,
      requestNo: `TK${uuidv7().replaceAll("-", "").slice(0, 18)}`,
      kind,
      category: "approval",
      subjectType: qualification ? "store" : "drama_order",
      subjectId: qualification ? o.store.id : o.order.id,
      entityId: o.entity.id,
      storeId: o.store.id,
      status: "pending",
      summarySnapshot: { title: "虚构暂停源", domain: { type: "cancel_request", id } },
      submitActorType: ctx.actor.type,
      submitActorId: ctx.actor.id,
      submitClient: ctx.actor.client,
      requesterStaffId: o.order.deliveryManagerId!,
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  await h.prisma.cancelRequest.create({
    data: {
      id,
      approvalRequestId: approvalId,
      kind,
      entityId: o.entity.id,
      storeId: o.store.id,
      dramaOrderId: qualification ? null : o.order.id,
      reasonCode: qualification ? "qualification_final" : "merchant_request",
      note: "虚构暂停源",
      lineCount: o.items.length,
      totalBasePoints: 100 * o.items.length,
      totalDeductPoints: 0,
      totalRefundPoints: 100 * o.items.length,
      status: "pending_approval",
      createdAt: now,
      updatedAt: now,
    },
  });
  for (const item of o.items) {
    const ticket = await h.prisma.deliveryTicket.findUniqueOrThrow({
      where: { orderItemId: item.id },
    });
    await h.prisma.cancelRequestLine.create({
      data: {
        id: uuidv7(),
        cancelRequestId: id,
        entityId: o.entity.id,
        storeId: o.store.id,
        targetType: "order_item",
        targetId: item.id,
        pointHoldId: item.pointHoldId,
        mode: "refund",
        stage: ticket.step === "plan_confirm" ? "plan_confirm" : "ad_and_sample",
        stepAtSubmit: ticket.step,
        reasonClass: qualification ? "qualification" : "merchant",
        chargePoints: 100,
        priorRequestedPoints: 0,
        ratioBp: 0,
        deductPoints: 0,
        refundPoints: 100,
        previewSnapshot: { test: "pending cancellation association" },
        createdAt: now,
      },
    });
  }
  return { id, approvalId, ctx };
}

/** A real initial package and real first launch approval; only the later in-flight reopen is a fixture. */
export async function pendingTwoAccountLaunches(h: M5Harness) {
  const f = await released(h, true);
  const tasks = await h.prisma.launchTask.findMany({
    where: { deliveryTicketId: f.id },
    orderBy: { id: "asc" },
  });
  const actualLaunchDate = h.clock.now().toISOString().slice(0, 10);
  for (const task of tasks)
    await h.deps.publish.submitLaunch(f.o.viewer, task.id, {
      linkKind: "collection",
      collectionUrl: `https://example.invalid/m5/${task.id}`,
      reportedEpisodeCount: 1,
      actualLaunchDate,
    });
  const first = await h.prisma.launchSubmission.findFirstOrThrow({
    where: { launchTaskId: tasks[0]!.id },
    include: { approvalRequest: true },
  });
  await h.deps.publish.approveLaunch(f.qc.ctx, f.qc.staff, first.id, {
    lockVersion: first.approvalRequest.lockVersion,
    confirm: { roundNo: first.roundNo, reportedEpisodeCount: first.reportedEpisodeCount },
    verifiedEpisodeCount: 1,
    ...(await checks(h, "launch.verify")),
  });
  // A reopened verification retains the actual prior live fact. No media/QC or money result is fabricated.
  await h.tx.run(async (tx) => {
    const id = uuidv7(),
      roundNo = first.roundNo + 1;
    const approval = await h.approval.submit(tx, f.o.viewer.ctx, {
      kind: "launch_link",
      subjectType: "launch_submission",
      subjectId: id,
      entityId: f.o.entity.id,
      storeId: f.o.store.id,
      deliveryTicketId: f.id,
      input: { submissionId: id, roundNo, title: "已上线账号重新核验的在途夹具" },
    });
    await tx.launchSubmission.update({
      where: { id: first.id },
      data: { result: "revoked", updatedAt: h.clock.now() },
    });
    await tx.launchSubmission.create({
      data: {
        id,
        entityId: f.o.entity.id,
        storeId: f.o.store.id,
        launchTaskId: first.launchTaskId,
        roundNo,
        linkKind: "collection",
        collectionUrl: first.collectionUrl,
        reportedEpisodeCount: 1,
        actualLaunchDate: first.actualLaunchDate,
        submitActorType: "merchant",
        submitActorId: f.o.user.id,
        submitClient: "weapp",
        submittedAt: h.clock.now(),
        approvalRequestId: approval.approvalId,
        result: "pending",
        reopenOfLaunchSubmissionId: first.id,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    await tx.launchTask.update({
      where: { id: first.launchTaskId },
      data: {
        reviewStatus: "verifying",
        currentRoundNo: roundNo,
        completedAt: null,
        updatedAt: h.clock.now(),
      },
    });
  });
  const pending = await h.prisma.launchSubmission.findMany({
    where: { launchTaskId: { in: tasks.map((t) => t.id) }, result: "pending" },
    orderBy: { id: "asc" },
  });
  return { ...f, tasks, pending, liveTaskId: first.launchTaskId };
}
