import { AdPricingSnapshotSchema, ChecklistItemsSchema, COMPARE_FIELDS } from "@liyoxi/contract";
import type { PlanContentInput } from "@liyoxi/contract";
import type { PrismaClient } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import { createApproval } from "../../approval/index.js";
import { createFlow } from "../../flow/index.js";
import { readAdminFlowStaff } from "../../staff/index.js";
import { bindDelivery, createDeliveryM5 } from "../index.js";
import { createBizNoIssuer, createIdentityContext, uuidv7 } from "../../kernel/index.js";
import { createLedgerHarness } from "../../testing/index.js";
import type { Harness } from "./harness.js";
import { draft } from "./harness.js";
import { productionHarness } from "./production-tools.js";
import type { ProductionHarness } from "./production-tools.js";

/** Preserve shared fixtures while supplying actual approval withdrawal to lifecycle effects. */
export function m5Harness(prisma: PrismaClient) {
  const h = productionHarness(prisma);
  const flow = createFlow({
    assembly: h.assembly,
    clock: h.clock,
    events: h.events,
    adminStaffReader: readAdminFlowStaff,
  });
  const approval = createApproval({
    assembly: h.assembly,
    clock: h.clock,
    flow,
    events: h.events,
    bizNo: createBizNoIssuer({ clock: h.clock, appEnv: "test" }),
  });
  const deps = { ...h.deps, flow, approval },
    unbind = bindDelivery(deps);
  return {
    ...h,
    flow,
    approval,
    deps,
    async close() {
      unbind();
      await h.close();
    },
  };
}
export type M5Harness = ReturnType<typeof m5Harness>;

export function m5Service(h: Harness) {
  return createDeliveryM5({
    ...h.deps,
    flow: createFlow({
      assembly: h.assembly,
      clock: h.clock,
      events: h.events,
      adminStaffReader: readAdminFlowStaff,
    }),
  });
}

export type M5Order = Awaited<ReturnType<Harness["order"]>>;
export type M5Staff = Awaited<ReturnType<Harness["staff"]>>;

export async function checks(h: Harness, code: string) {
  const template = await h.prisma.checklistTemplate.findFirstOrThrow({
    where: { code, status: "active" },
  });
  return {
    checklistVersionNo: template.versionNo,
    results: ChecklistItemsSchema.parse(template.items).map(({ key }) => ({
      key,
      result: "pass" as const,
    })),
  };
}

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

export async function prepared(
  h: Harness,
  twoAccounts = false,
  withPlacement?: (o: M5Order, editor: M5Staff) => ReturnType<typeof confirmedPlacementAd>,
) {
  const poster = await h.make.fileObject();
  const o = await h.order(true, 1, poster.id, 1);
  const editor = await h.staff("editor"),
    qc = await h.staff();
  await h.prisma.drama.update({
    where: { id: o.items[0]!.dramaId },
    data: { synopsis: "补发真实制作链路的虚构短剧简介" },
  });
  const content: PlanContentInput = draft(o),
    placement = await withPlacement?.(o, editor);
  if (placement) content.items[0]!.placements.push({ slot: "opening", adId: placement.ad.id });
  if (twoAccounts) {
    const screenshot = await h.make.fileObject({
      category: "channel_screenshot",
      bucket: "asset",
      scopeType: "store",
      entityId: o.entity.id,
      storeId: o.store.id,
      uploadActorType: "merchant",
      uploadActorId: o.user.id,
      uploadClient: "weapp",
    });
    const bound = await h.deps.publish.bind(o.viewer, {
      platform: "wechat_channels",
      accountName: "第二个真实核验号",
      accountUid: `M5${uuidv7()}`,
      accountType: "none",
      screenshotFileIds: [screenshot.id],
    });
    const submission = await h.prisma.channelAccountSubmission.findFirstOrThrow({
      where: { channelAccountId: bound.channelAccountId },
      include: { approvalRequest: true, channelAccount: true },
    });
    await h.deps.publish.approveAccount(qc.ctx, qc.staff, submission.id, {
      lockVersion: submission.approvalRequest.lockVersion,
      confirm: { roundNo: submission.roundNo, accountUid: submission.channelAccount.accountUid },
      accountType: "none",
      certSubjectName: null,
      compareRows: COMPARE_FIELDS.map((field) => ({ field, recognized: null, match: true })),
      ...(await checks(h, "account.verify")),
    });
    content.items[0]!.channelAccountIds.push(bound.channelAccountId);
  }
  await h.delivery.replaceDraft(qc.ctx, qc.staff, o.deliveryPlanId, {
    draftLockVersion: 0,
    content,
  });
  await h.delivery.push(qc.ctx, qc.staff, o.deliveryPlanId, { draftLockVersion: 1 });
  await h.delivery.confirm(o.viewer, o.deliveryPlanId, { versionNo: 1 });
  await m5Service(h).assignEditor(qc.ctx, qc.staff, o.deliveryTicketIds[0]!, {
    staffId: editor.row.id,
  });
  return {
    o,
    editor,
    qc,
    id: o.deliveryTicketIds[0]!,
    item: o.items[0]!,
    accountIds: content.items[0]!.channelAccountIds,
    placement,
  };
}

/** Only codecs/storage are doubles. Registration, promote, probe and production facts are real. */
export async function productionFile(
  h: ProductionHarness,
  o: M5Order,
  editor: M5Staff,
  category: "sample_video" | "final_episode",
  episodeNo = 1,
) {
  await h.master(o.items[0]!.dramaId, episodeNo, editor.row.id);
  const actor = { identity: editor.ctx, staff: editor.staff },
    bytes = new Uint8Array(1234);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const result = await h.media.register(actor, {
    category,
    storeId: o.store.id,
    production: {
      kind: category === "sample_video" ? "sample" : "final",
      orderItemId: o.items[0]!.id,
      episodeNo,
      aiUsage: { used: false, tools: [] },
    },
    files: [
      { fileName: `m5-${episodeNo}.mp4`, sizeBytes: String(bytes.length), clientToken: uuidv7() },
    ],
  });
  const file = result.items[0]!;
  h.fake.storage.put({ bucket: "media", key: file.key }, bytes, "video/mp4");
  await h.media.completeAdmin(actor, file.fileId);
  const job = await h.prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.fileId}` },
  });
  await h.media.promote({ jobId: job.id });
  await h.finish(file.fileId, category === "sample_video");
  return file.fileId;
}

export async function released(h: ProductionHarness, twoAccounts = false) {
  const f = await prepared(h, twoAccounts),
    fileId = await productionFile(h, f.o, f.editor, "sample_video");
  const sample = await h.delivery.sampleCreate(f.editor.ctx, f.editor.staff, f.id, {
    fileId,
    adSlots: [],
  });
  await h.delivery.sampleInspect(
    f.qc.ctx,
    f.qc.staff,
    sample.sampleId,
    await checks(h, "qc.sample"),
  );
  await h.delivery.samplePush(f.qc.ctx, f.qc.staff, sample.sampleId, {});
  await h.delivery.merchantSample(f.o.viewer, f.item.id);
  await h.delivery.sampleConfirm(f.o.viewer, sample.sampleId, {
    versionNo: 1,
    viewedVia: "weapp",
    hasViewed: true,
  });
  const episodes = await h.delivery.episodeRegister(f.editor.ctx, f.editor.staff, f.id, {
    items: [{ episodeNo: 1, sampleId: sample.sampleId }],
  });
  const checklist = await checks(h, "qc.episode");
  await h.delivery.episodeInspect(f.qc.ctx, f.qc.staff, f.id, {
    episodeOutputIds: episodes.items.map((e) => e.episodeOutputId),
    checklistVersionNo: checklist.checklistVersionNo,
    defaultResults: checklist.results,
  });
  await h.delivery.packageInspect(f.qc.ctx, f.qc.staff, f.id, await checks(h, "qc.package"));
  const pushed = await h.delivery.packagePush(f.qc.ctx, f.qc.staff, f.id, {
    precheck: await checks(h, "delivery.precheck"),
  });
  return { ...f, sample, original: episodes.items[0]!, release: pushed.release };
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
