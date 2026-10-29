import type { CancelQuote, OrderCancelQuoteBody } from "@liyoxi/contract";
import { ChecklistItemsSchema } from "@liyoxi/contract";
import type { Prisma, PrismaClient } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import { createApproval } from "../approval/index.js";
import { SYSTEM_SCOPE } from "../authz/index.js";
import {
  createDelivery,
  bindDelivery,
  createProductionChecked,
  holdCancelReviewPauses,
  readCancelReviewHoldTargets,
} from "../delivery/index.js";
import { createBizNoIssuer, createIdentityContext, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx, TxRunner } from "../kernel/index.js";
import { createMedia } from "../media/index.js";
import { assignDeliveryManager } from "../profile/index.js";
import { createTenant } from "../tenant/index.js";
import {
  createDeliveryProductionTools,
  createW501Publish,
  sampleStaffContext,
} from "../testing/index.js";
import { startHarness } from "./__fixtures__/start-harness.js";
import { buyer, body, drama, version } from "./__fixtures__/harness.js";
import { executeCancel } from "./ad-cancel.js";
import type { CancelActor, CancelDeps } from "./cancel-context.js";
import { quoteOrderCancel } from "./cancel-quote.js";
import { startOrder } from "./start.js";

export const CANCEL_TABLES = [
  "billing_account",
  "point_lot",
  "point_hold",
  "point_hold_alloc",
  "ledger_operation",
  "point_ledger_entry",
  "approval_request",
  "cancel_request",
  "cancel_request_line",
  "drama_order",
  "order_item",
  "delivery_ticket",
  "delivery_ticket_pause",
  "delivery_release",
  "download_grant",
  "launch_task",
  "status_transition",
  "audit_log",
  "outbox_event",
  "timer",
];
export const ORDER_STAGES = [
  "pending_start",
  "plan_confirm",
  "ad_and_sample",
  "sample_pending",
  "post_sample",
  "live",
] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];
let sequence = 50100;

/** Money and delivery facts use the production services; only unavailable W5-02 inputs are seeded. */
export function cancelHarness(prisma: PrismaClient) {
  const h = startHarness(prisma),
    tools = createDeliveryProductionTools(h.fake);
  const orderHarness = { ...h, deps: h.orderDeps },
    tenant = createTenant(h.core);
  const media = createMedia({
    ...h.core,
    storage: h.fake.storage,
    production: {
      tool: tools.tool,
      workspace: tools.workspace,
      cloud: h.fake.media,
      config: {
        aigc: {
          Label: "1",
          ContentProducer: "TEST-SYSTEM",
          ReservedCode1: "",
          ContentPropagator: "",
          ReservedCode2: "",
        },
        templates: {
          normalize: "normalize",
          sample: "sample",
          sd: "sd",
          hd: "hd",
          brand: "brand",
          ai: "ai",
        },
      },
      parameters: async () => ({
        finalMaxMb: 200,
        softDurationMs: 180000,
        ruleVersion: 1,
        specVersion: 1,
      }),
      readStoreFacts: async (tx, id) => {
        const s = await tx.store.findUnique({ where: { id } });
        return s?.name ? { name: s.name } : null;
      },
      readMasterFacts: async (tx, id) => {
        const m = await tx.dramaEpisodeMaster.findUnique({ where: { id } }),
          info = m ? await tx.mediaInfo.findUnique({ where: { fileId: m.fileId } }) : null;
        return m && info?.durationMs && info.displayWidth && info.displayHeight
          ? {
              id,
              durationMs: info.durationMs,
              displayWidth: info.displayWidth,
              displayHeight: info.displayHeight,
              isCurrent: m.isCurrent,
            }
          : null;
      },
    },
  });
  const approval = createApproval({
    ...h.core,
    timers: h.deps.timers,
    bizNo: createBizNoIssuer({ clock: h.clock, appEnv: "test" }),
  });
  const deps: CancelDeps = { ...h.core, approval, ledger: h.ledger, timers: h.deps.timers };
  const { publish, unbindPublish } = createW501Publish({ ...h.core, approval, media });
  const delivery = createDelivery({
    ...h.core,
    media,
    publish,
    profile: {
      assignDeliveryManager: (tx, ctx, input) =>
        assignDeliveryManager(tx, { ...h.core, tenant }, ctx, input),
    },
    samplePlayback: async () => true,
  });
  const unbindDelivery = bindDelivery({ ...h.core, media });
  const checked = createProductionChecked({ clock: h.clock, flow: h.flow, media });
  async function staff(): Promise<CancelActor> {
    const group = await prisma.staffGroup.findFirstOrThrow({
      where: { staffRoleKey: "super_admin", isDefault: true },
    });
    const s = await h.make.staff({
      staffRoleKey: "super_admin",
      staffGroupId: group.id,
      isLead: true,
    });
    return {
      ctx: createIdentityContext({ actor: { type: "staff", id: s.id, client: "admin" } }),
      staff: await sampleStaffContext(prisma, s.id, { stepUpAt: h.clock.now() }),
    };
  }
  async function param(key: string, value: Prisma.InputJsonValue, actor: CancelActor) {
    h.clock.advance(1);
    await prisma.paramValue.create({
      data: {
        id: uuidv7(),
        key,
        value,
        effectiveAt: h.clock.now(),
        createdAt: h.clock.now(),
        createdByStaffId: actor.staff!.staff.id,
        reason: "W5-01机制测试",
      },
    });
  }
  async function checks(code: string) {
    const t = await prisma.checklistTemplate.findFirstOrThrow({
      where: { code, status: "active" },
    });
    return {
      checklistVersionNo: t.versionNo,
      results: ChecklistItemsSchema.parse(t.items).map((i) => ({
        key: i.key,
        result: "pass" as const,
      })),
    };
  }
  async function probe(fileId: string) {
    const jobId = await h.tx.run((tx) => media.enqueueProbe(tx, fileId));
    await media.jobs.run({ jobId });
  }
  async function finish(fileId: string, watermark = false) {
    await probe(fileId);
    const e = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: "media.production.checked", aggregateId: fileId },
      orderBy: { id: "desc" },
    });
    await h.tx.run((tx) =>
      checked(tx, { id: e.id, type: e.eventType, payload: e.payload as Record<string, unknown> }),
    );
    if (watermark) {
      const job = await prisma.mediaJob.findFirstOrThrow({
        where: { subjectId: fileId, kind: "watermark_sample" },
      });
      await media.jobs.run({ jobId: job.id });
      h.clock.advance(5000);
      await media.jobs.run({ jobId: job.id });
    }
  }
  async function pending(count = 1) {
    h.clock.set(new Date(Date.parse("2026-01-05T04:00:00Z") + ++sequence));
    await version(orderHarness);
    const b = await buyer(orderHarness),
      manager = await h.pool("delivery_manager"),
      ds = [];
    await prisma.store.update({
      where: { id: b.store.id },
      data: { deliveryManagerId: manager.id },
    });
    for (let n = 0; n < count; n++) {
      const d = await drama(orderHarness, 101 + n);
      await prisma.drama.update({
        where: { id: d.id },
        data: { totalEpisodes: 1, synopsis: "虚构门店短剧" },
      });
      ds.push(d);
    }
    const out = await h.order.create(
      b.actor,
      await body(
        orderHarness,
        b,
        ds.map((d) => d.id),
      ),
    );
    const items = await prisma.orderItem.findMany({
      where: { dramaOrderId: out.orderId },
      orderBy: { id: "asc" },
    });
    return { b, out, items, ds, manager };
  }
  type Pending = Awaited<ReturnType<typeof pending>>;
  async function file(p: Pending, actor: CancelActor) {
    const item = p.items[0]!,
      bytes = new Uint8Array(1234);
    bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
    const master = await h.make.fileObject({
      category: "drama_master",
      bucket: "media",
      ext: "mp4",
      mime: "video/mp4",
      declaredMime: "video/mp4",
      sizeBytes: bytes.length,
      declaredSize: bytes.length,
    });
    const etag = h.fake.storage.put({ bucket: "media", key: master.objectKey }, bytes, "video/mp4");
    await prisma.fileObject.update({ where: { id: master.id }, data: { etag } });
    await probe(master.id);
    await h.tx.run(async (tx) => {
      const m = await tx.dramaEpisodeMaster.create({
        data: {
          id: uuidv7(),
          dramaId: item.dramaId,
          episodeNo: 1,
          revNo: 1,
          fileId: master.id,
          state: "ready",
          isCurrent: true,
          durationMs: 60000,
          createdByStaffId: actor.staff!.staff.id,
          activatedAt: h.clock.now(),
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
      await media.link(tx, {
        fileId: master.id,
        entityId: null,
        storeId: null,
        refType: "drama_episode_master",
        refId: m.id,
        role: "main",
      });
    });
    const a = { identity: actor.ctx, staff: actor.staff! };
    const r = await media.register(a, {
      category: "sample_video",
      storeId: p.b.store.id,
      production: {
        kind: "sample",
        orderItemId: item.id,
        episodeNo: 1,
        aiUsage: { used: false, tools: [] },
      },
      files: [{ fileName: "sample.mp4", sizeBytes: String(bytes.length), clientToken: uuidv7() }],
    });
    const f = r.items[0]!;
    h.fake.storage.put({ bucket: "media", key: f.key }, bytes, "video/mp4");
    await media.completeAdmin(a, f.fileId);
    const job = await prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${f.fileId}` },
    });
    await media.promote({ jobId: job.id });
    await finish(f.fileId, true);
    return f.fileId;
  }
  async function atStage(
    stage: OrderStage,
    reasonCode: "merchant_request" | "platform_fault" = "merchant_request",
    count = 1,
  ) {
    const p = await pending(count),
      actor = await staff(),
      qc = await staff();
    if (stage !== "pending_start") {
      await h.tx.run((tx) => startOrder(tx, h.deps, p.out.orderId));
      if (stage !== "plan_confirm") {
        const plan = await prisma.deliveryPlan.findUniqueOrThrow({
          where: { dramaOrderId: p.out.orderId },
        });
        await delivery.replaceDraft(actor.ctx, actor.staff!, plan.id, {
          draftLockVersion: 0,
          content: {
            focusCodes: ["W115F"],
            referenceAssetIds: [],
            launchMode: "merchant_self",
            note: "取消机制公共履约前置",
            items: p.items.map((i) => ({
              orderItemId: i.id,
              channelAccountIds: [p.b.accountId],
              placements: [],
              agreedLaunchDate: "2026-01-20",
              expectedDeliveryDate: null,
            })),
          },
        });
        await delivery.push(actor.ctx, actor.staff!, plan.id, { draftLockVersion: 1 });
        await delivery.confirm(p.b.actor, plan.id, { versionNo: 1 });
        if (stage !== "ad_and_sample") {
          const ticket = await prisma.deliveryTicket.findUniqueOrThrow({
            where: { orderItemId: p.items[0]!.id },
          });
          const sample = await delivery.sampleCreate(actor.ctx, actor.staff!, ticket.id, {
            fileId: await file(p, actor),
            adSlots: [],
          });
          await delivery.sampleInspect(
            qc.ctx,
            qc.staff!,
            sample.sampleId,
            await checks("qc.sample"),
          );
          await delivery.samplePush(qc.ctx, qc.staff!, sample.sampleId, {});
          if (stage !== "sample_pending") {
            await delivery.sampleConfirm(p.b.actor, sample.sampleId, {
              versionNo: 1,
              viewedVia: "weapp",
              hasViewed: true,
            });
            if (stage === "live") {
              const episodes = await delivery.episodeRegister(actor.ctx, actor.staff!, ticket.id, {
                items: [{ episodeNo: 1, sampleId: sample.sampleId }],
              });
              const q = await checks("qc.episode");
              await delivery.episodeInspect(qc.ctx, qc.staff!, ticket.id, {
                episodeOutputIds: episodes.items.map((e) => e.episodeOutputId),
                checklistVersionNo: q.checklistVersionNo,
                defaultResults: q.results,
              });
              await delivery.packageInspect(
                qc.ctx,
                qc.staff!,
                ticket.id,
                await checks("qc.package"),
              );
              await delivery.packagePush(qc.ctx, qc.staff!, ticket.id, {
                precheck: await checks("delivery.precheck"),
              });
              const task = await prisma.launchTask.findFirstOrThrow({
                where: { orderItemId: p.items[0]!.id },
              });
              await publish.submitLaunch(p.b.actor, task.id, {
                linkKind: "collection",
                collectionUrl: "https://example.invalid/w501",
                reportedEpisodeCount: 1,
                actualLaunchDate: calendarDate(h.clock.now()),
              });
              const r = await prisma.launchSubmission.findFirstOrThrow({
                where: { launchTaskId: task.id },
                include: { approvalRequest: true },
              });
              await publish.approveLaunch(qc.ctx, qc.staff!, r.id, {
                lockVersion: r.approvalRequest.lockVersion,
                confirm: { roundNo: r.roundNo, reportedEpisodeCount: r.reportedEpisodeCount },
                verifiedEpisodeCount: 1,
                ...(await checks("launch.verify")),
              });
            }
          }
        }
      }
    }
    const input: OrderCancelQuoteBody = {
      reasonCode,
      ...(stage === "post_sample" && reasonCode === "merchant_request"
        ? {
            manualDeducts: p.items.map((i) => ({
              orderItemId: i.id,
              deductPoints: 37,
              deductNote: "真实已完成样片成本",
            })),
          }
        : {}),
    };
    return {
      ...p,
      actor,
      qc,
      input,
      quote: await h.tx.run((tx) =>
        quoteOrderCancel(
          tx,
          { scope: SYSTEM_SCOPE, orderId: p.out.orderId, body: input },
          h.clock.now(),
        ),
      ),
    };
  }
  /** W5-02 producer is out of scope: legal approved input, never successful cancellation state. */
  async function request(
    p: Pending,
    q: CancelQuote,
    requester: CancelActor,
    approver: CancelActor,
    runner: TxRunner = h.tx,
  ) {
    return runner.run(async (tx) => {
      const id = uuidv7(),
        approvalId = uuidv7(),
        now = h.clock.now(),
        no = `TK20260105${++sequence}`;
      await tx.approvalRequest.create({
        data: {
          id: approvalId,
          requestNo: no,
          kind: "order_cancel",
          category: "approval",
          subjectType: "drama_order",
          subjectId: p.out.orderId,
          entityId: p.b.entity.id,
          storeId: p.b.store.id,
          status: "pending",
          summarySnapshot: {
            title: "待执行取消前置",
            points: q.totalRefundPoints,
            domain: { type: "cancel_request", id },
          },
          requesterStaffId: requester.staff!.staff.id,
          requesterStaffGroupId: requester.staff!.staff.staffGroupId,
          submitActorType: "staff",
          submitActorId: requester.staff!.staff.id,
          submitClient: "admin",
          submittedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
      await tx.cancelRequest.create({
        data: {
          id,
          approvalRequestId: approvalId,
          kind: "order_cancel",
          entityId: p.b.entity.id,
          storeId: p.b.store.id,
          dramaOrderId: p.out.orderId,
          reasonCode: q.reasonCode,
          note: "W5-02合法输入；执行与资金由真实服务写",
          lineCount: q.lines.length,
          totalBasePoints: q.totalBasePoints,
          totalDeductPoints: q.totalDeductPoints,
          totalRefundPoints: q.totalRefundPoints,
          status: "pending_approval",
          createdAt: now,
          updatedAt: now,
        },
      });
      for (const l of q.lines) {
        const i = p.items.find((i) => i.id === l.targetId)!;
        await tx.cancelRequestLine.create({
          data: {
            id: uuidv7(),
            cancelRequestId: id,
            entityId: p.b.entity.id,
            storeId: p.b.store.id,
            targetType: "order_item",
            targetId: l.targetId,
            pointHoldId: i.pointHoldId,
            mode: l.mode,
            stage: l.stage,
            stepAtSubmit: l.stepAtSubmit,
            reasonClass: l.reasonClass,
            chargePoints: l.chargePoints,
            priorRequestedPoints: l.priorRequestedPoints,
            ratioBp: l.ratioBp,
            deductPoints: l.deductPoints,
            deductNote: l.deductNote,
            refundPoints: l.refundPoints,
            terminationDate: l.terminationDate ? new Date(l.terminationDate) : null,
            usageStartDate: l.usageStartDate ? new Date(l.usageStartDate) : null,
            usageEndDate: l.usageEndDate ? new Date(l.usageEndDate) : null,
            usageEndSource: l.usageEndSource,
            previewSnapshot: l.preview,
            createdAt: now,
          },
        });
      }
      await lockRows(tx, "approval_request", [approvalId]);
      await lockRows(tx, "cancel_request", [id]);
      const lines = await tx.cancelRequestLine.findMany({ where: { cancelRequestId: id } });
      await lockRows(
        tx,
        "cancel_request_line",
        lines.map((l) => l.id),
      );
      await lockRows(tx, "entity", [p.b.entity.id]);
      await lockRows(tx, "store", [p.b.store.id]);
      await lockRows(
        tx,
        "drama",
        p.items.map((i) => i.dramaId),
      );
      await lockRows(tx, "drama_order", [p.out.orderId]);
      await lockRows(
        tx,
        "order_item",
        p.items.map((i) => i.id),
      );
      await tx.dramaOrder.update({
        where: { id: p.out.orderId },
        data: { status: "after_sale", subStatus: "cancel_reviewing", openCancelRequestId: id },
      });
      const targets = await readCancelReviewHoldTargets(tx, h.assembly, approvalId);
      await lockRows(tx, "delivery_ticket", targets.deliveryTicketIds);
      await holdCancelReviewPauses(tx, h.core, requester.ctx, targets);
      // Complete the unavailable W5-02 input fixture only after its genuine submission pause exists.
      await tx.approvalRequest.update({
        where: { id: approvalId },
        data: { status: "approved", decidedAt: now, decidedByStaffId: approver.staff!.staff.id },
      });
      await tx.cancelRequest.update({
        where: { id },
        data: {
          status: "pending_execution",
          execDueAt: new Date(now.getTime() + 86400000),
          slaSnapshot: {
            policy: "review.refund_execute",
            amount: 1,
            unit: "work_days",
            calendarVersion: 1,
            computedAt: now.toISOString(),
          },
        },
      });
      return {
        id,
        approvalRequestId: approvalId,
        confirm: { requestNo: no, totalRefundPoints: q.totalRefundPoints },
      };
    });
  }
  return {
    ...h,
    media,
    publish,
    delivery,
    cancelDeps: deps,
    staff,
    param,
    pending,
    atStage,
    request,
    execute: (
      actor: CancelActor,
      r: { id: string; confirm: { requestNo: string; totalRefundPoints: number } },
      overrides: Partial<CancelDeps> = {},
    ) =>
      (overrides.tx ?? h.tx).run((tx) =>
        executeCancel(tx, { ...deps, ...overrides }, actor, r.id, {
          confirm: r.confirm,
          confirmChecks: ["order_points_checked"],
        }),
      ),
    async close() {
      await media.jobs.shutdown();
      unbindPublish();
      unbindDelivery();
      h.clear();
      await tools.tools.close();
    },
  };
}
export type CancelHarness = ReturnType<typeof cancelHarness>;
export type CancelFixture = Awaited<ReturnType<CancelHarness["atStage"]>>;
export async function readCancelRequest(tx: Tx, id: string) {
  return tx.cancelRequest.findUniqueOrThrow({
    where: { id },
    include: { approvalRequest: true, cancelRequestLines: { orderBy: { id: "asc" } } },
  });
}
