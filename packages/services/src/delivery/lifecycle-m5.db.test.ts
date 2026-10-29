import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PlanContentSchema } from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { closeExpiredDeliveryPublish, readDeliveryPublishTargets } from "../publish/index.js";
import { createTimers } from "../timers/index.js";
import { workHoursAt } from "../sla/index.js";
import { ownTaskScope, scopeOf } from "../authz/index.js";
import { createIdempotencyContext, staffWorkPort, uuidv7 } from "../kernel/index.js";
import type { IdentityContext } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { findDeliveryViolations } from "./invariants.js";
import { prepareReevaluation } from "./reevaluate-locks.js";
import {
  holdCancelReviewPauses,
  readCancelReviewHoldTargets,
  readCancelReviewPauseTargets,
  releaseCancelReviewPauses,
} from "./index.js";
import {
  cancellationCause,
  checks,
  confirmedPlacementAd,
  m5Harness,
  m5Service,
  prepared,
  pendingTwoAccountLaunches,
  productionFile,
  released,
} from "./__fixtures__/m5.js";

import type { M5Harness } from "./__fixtures__/m5.js";

const db = useSeededDatabase("services", { max: 1 });
let h: M5Harness;
beforeAll(async () => {
  h = m5Harness(await db.prisma());
}, 120_000);
beforeEach(() => h.clock.set(new Date("2026-01-05T04:00:00Z")));
afterAll(async () => {
  await h?.close();
});
const m5 = () => m5Service(h);
const reissueBody = {
  episodeNos: [1],
  reasonCode: "content_fix",
  note: "商家确认需要修正第一集内容",
};
async function reason() {
  await h.prisma.dictItem.upsert({
    where: { dictTypeKey_code: { dictTypeKey: "reissue_reason", code: reissueBody.reasonCode } },
    create: {
      id: uuidv7(),
      dictTypeKey: "reissue_reason",
      code: reissueBody.reasonCode,
      name: "内容修正",
      isEnabled: true,
      position: 1,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
    update: { isEnabled: true },
  });
}
function idem(scope: string, actor: IdentityContext["actor"], body: unknown, key = uuidv7()) {
  return () =>
    createIdempotencyContext({
      mode: "required",
      scope,
      actor,
      key,
      request: { method: "POST", body },
    });
}
async function snapshot(id: string) {
  return {
    ticket: await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } }),
    stages: await h.prisma.deliveryTicketStage.findMany({
      where: { deliveryTicketId: id },
      orderBy: { id: "asc" },
    }),
    history: await h.prisma.statusTransition.findMany({
      where: { subjectId: id },
      orderBy: { seq: "asc" },
    }),
    audit: await h.prisma.auditLog.findMany({ where: { targetId: id }, orderBy: { seq: "asc" } }),
    events: await h.prisma.outboxEvent.findMany({
      where: { aggregateId: id },
      orderBy: { id: "asc" },
    }),
    ledger: await h.prisma.ledgerOperation.findMany({ orderBy: { id: "asc" } }),
    entries: await h.prisma.pointLedgerEntry.findMany({ orderBy: { id: "asc" } }),
    accounts: await h.prisma.billingAccount.findMany({ orderBy: { entityId: "asc" } }),
  };
}

describe("M5显式指派与纠偏真实事务", { timeout: 60_000 }, () => {
  it.each(["editor", "publisher"] as const)(
    "%s首指派无空来源历史，改派保存真实from且原key重放",
    async (role) => {
      const o = await h.order(),
        id = o.deliveryTicketIds[0]!,
        actor = await h.staff();
      const first = await h.make.staff({ staffRoleKey: role }),
        second = await h.make.staff({ staffRoleKey: role });
      // A valid unassigned ticket also exercises first publisher assignment despite the optional automatic picker.
      await h.prisma.deliveryTicket.update({
        where: { id },
        data: { editorId: null, publisherId: null },
      });
      const assign = role === "editor" ? m5().assignEditor : m5().assignPublisher;
      const firstBody = { staffId: first.id },
        firstIdem = idem(`admin.deliveryTicket.assign${role}`, actor.ctx.actor, firstBody);
      await assign(actor.ctx, actor.staff, id, firstBody, { idem: firstIdem() });
      expect(await h.prisma.assignmentHistory.count({ where: { subjectId: id } })).toBe(0);
      const before = await snapshot(id);
      expect(
        await assign(actor.ctx, actor.staff, id, firstBody, { idem: firstIdem() }),
      ).toMatchObject({ replayed: true });
      expect(await snapshot(id)).toEqual(before);
      await expect(
        assign(actor.ctx, actor.staff, id, { staffId: second.id }),
      ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
      const body = {
        staffId: second.id,
        reasonCode: "workload" as const,
        note: "调整真实在办工作量",
      };
      await assign(actor.ctx, actor.staff, id, body);
      expect(await h.prisma.assignmentHistory.findMany({ where: { subjectId: id } })).toMatchObject(
        [
          {
            source: `ticket_${role}`,
            subjectType: "delivery_ticket",
            fromStaffId: first.id,
            toStaffId: second.id,
            reasonCode: "workload",
            actorId: actor.row.id,
          },
        ],
      );
      expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } })).toMatchObject({
        [role === "editor" ? "editorId" : "publisherId"]: second.id,
      });
      const source = h.assembly.portEntries(staffWorkPort).get("delivery")!;
      const currentWork = await h.tx.run((tx) =>
        source.listOpen(tx, { staffId: second.id, now: h.clock.now() }),
      );
      expect(currentWork).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: `ticket_${role}`, subjectId: id }),
        ]),
      );
      expect(
        await h.tx.run((tx) => source.listOpen(tx, { staffId: first.id, now: h.clock.now() })),
      ).toEqual([]);
    },
  );

  it("真实员工角色、启用状态、资源scope与被指派人scope分别核验", async () => {
    const o = await h.order(),
      id = o.deliveryTicketIds[0]!,
      actor = await h.staff();
    const editor = await h.make.staff({ staffRoleKey: "editor" });
    const publisher = await h.make.staff({ staffRoleKey: "publisher" });
    const disabled = await h.make.staff({
      staffRoleKey: "editor",
      status: "disabled",
      disabledAt: h.clock.now(),
      disabledReason: "other",
    });
    const current = await h.make.staff({ staffRoleKey: "editor" });
    await h.prisma.deliveryTicket.update({ where: { id }, data: { editorId: current.id } });
    const staff = {
      ...actor.staff,
      scope: scopeOf(
        actor.staff.staff,
        { dataScope: "group" },
        [current.id],
        actor.staff.permissions,
      ),
    };
    const before = await snapshot(id);
    await expect(
      m5().assignEditor(actor.ctx, staff, id, { staffId: editor.id, reasonCode: "workload" }),
    ).rejects.toMatchObject({ error: "ASSIGNEE_INVALID", details: { reason: "out_of_scope" } });
    await expect(
      m5().assignEditor(actor.ctx, actor.staff, id, {
        staffId: publisher.id,
        reasonCode: "workload",
      }),
    ).rejects.toMatchObject({ error: "ASSIGNEE_INVALID", details: { reason: "role_mismatch" } });
    await expect(
      m5().assignEditor(actor.ctx, actor.staff, id, {
        staffId: disabled.id,
        reasonCode: "workload",
      }),
    ).rejects.toMatchObject({ error: "ASSIGNEE_INVALID", details: { reason: "not_active" } });
    const outsider = await h.staff();
    await expect(
      m5().assignEditor(
        outsider.ctx,
        { ...outsider.staff, scope: ownTaskScope(outsider.staff.staff) },
        id,
        { staffId: editor.id, reasonCode: "workload" },
      ),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    expect(await snapshot(id)).toEqual(before);
  });

  it("中央stepup、确认与白名单先拒绝；结构失败回滚新visit/历史/审计/事件且无账", async () => {
    const f = await prepared(h),
      actor = f.qc;
    const ticket = await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: f.id } });
    const staff = { ...actor.staff, stepUpAt: h.clock.now() };
    const body = {
      toStep: "plan_confirm" as const,
      note: "核验事实后进行人工环节回退",
      confirm: { ticketNo: ticket.ticketNo, fromStep: "sample_making" as const },
    };
    const before = await snapshot(f.id);
    await expect(
      m5().forceTransition(actor.ctx, { ...staff, stepUpAt: null }, f.id, body),
    ).rejects.toMatchObject({ error: "STEP_UP_REQUIRED" });
    await expect(
      m5().forceTransition(actor.ctx, staff, f.id, {
        ...body,
        confirm: { ...body.confirm, ticketNo: "wrong" },
      }),
    ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
    await expect(
      m5().forceTransition(actor.ctx, staff, f.id, { ...body, toStep: "in_service" }),
    ).rejects.toMatchObject({ error: "CORRECTION_NOT_ALLOWED" });
    await expect(
      m5().forceTransition(actor.ctx, staff, f.id, { ...body, note: "短原因" }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    expect(await snapshot(f.id)).toEqual(before);
    const confirmed = await h.prisma.deliveryPlanVersion.findUniqueOrThrow({
      where: { deliveryPlanId_versionNo: { deliveryPlanId: f.o.deliveryPlanId, versionNo: 1 } },
    });
    // Each row satisfies its SQL checks, but the unpointed v2 deliberately violates delivery.I6.
    await h.prisma.deliveryPlanVersion.create({
      data: {
        id: uuidv7(),
        deliveryPlanId: f.o.deliveryPlanId,
        entityId: f.o.entity.id,
        storeId: f.o.store.id,
        versionNo: 2,
        contentSnapshot: PlanContentSchema.parse(confirmed.contentSnapshot),
        pushedByStaffId: actor.row.id,
        pushedAt: h.clock.now(),
        createdAt: h.clock.now(),
      },
    });
    const corrupted = await snapshot(f.id);
    await expect(m5().forceTransition(actor.ctx, staff, f.id, body)).rejects.toMatchObject({
      error: "CORRECTION_NOT_ALLOWED",
      details: {
        reason: "structural_invariant",
        failedInvariants: expect.arrayContaining(["delivery.I6"]),
      },
    });
    expect(await snapshot(f.id)).toEqual(corrupted);
    // Preserve the immutable bad-version counterexample and prove success with a clean order.
    const clean = await prepared(h),
      cleanTicket = await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: clean.id } });
    const stableBefore = await snapshot(clean.id);
    await expect(
      m5().forceTransition(clean.qc.ctx, { ...clean.qc.staff, stepUpAt: h.clock.now() }, clean.id, {
        ...body,
        confirm: { ...body.confirm, ticketNo: cleanTicket.ticketNo },
      }),
    ).rejects.toMatchObject({
      error: "CORRECTION_NOT_ALLOWED",
      details: {
        reason: "structural_invariant",
        failedInvariants: expect.arrayContaining(["delivery.I3.plan"]),
      },
    });
    expect(await snapshot(clean.id)).toEqual(stableBefore);
    const fileId = await productionFile(h, clean.o, clean.editor, "sample_video");
    const sample = await h.delivery.sampleCreate(clean.editor.ctx, clean.editor.staff, clean.id, {
      fileId,
      adSlots: [],
    });
    await h.delivery.sampleInspect(
      clean.qc.ctx,
      clean.qc.staff,
      sample.sampleId,
      await checks(h, "qc.sample"),
    );
    await h.delivery.samplePush(clean.qc.ctx, clean.qc.staff, sample.sampleId, {});
    const cleanBody = {
      ...body,
      toStep: "sample_making" as const,
      confirm: { ticketNo: cleanTicket.ticketNo, fromStep: "sample_confirm" as const },
    };
    const cleanStaff = { ...clean.qc.staff, stepUpAt: h.clock.now() },
      cleanBefore = await snapshot(clean.id);
    await m5().forceTransition(clean.qc.ctx, cleanStaff, clean.id, cleanBody);
    expect(
      await h.prisma.statusTransition.findFirstOrThrow({
        where: { subjectId: clean.id, isForced: true },
      }),
    ).toMatchObject({
      event: "admin.force",
      fromState: "sample_confirm",
      toState: "sample_making",
      note: body.note,
    });
    const after = await snapshot(clean.id);
    expect(after.ledger).toEqual(cleanBefore.ledger);
    expect(after.entries).toEqual(cleanBefore.entries);
    expect(after.accounts).toEqual(cleanBefore.accounts);
  });

  it("重复正式求值没有新迁移、副作用或卡死，仍各记运维审计", async () => {
    const f = await prepared(h),
      actor = f.qc;
    const first = await m5().reevaluate(actor.ctx, actor.staff, f.id, {});
    const before = await snapshot(f.id);
    const second = await m5().reevaluate(actor.ctx, actor.staff, f.id, {});
    expect(first.transitions).toEqual([]);
    expect(second.transitions).toEqual([]);
    const after = await snapshot(f.id);
    expect(after.ticket).toEqual(before.ticket);
    expect(after.stages).toEqual(before.stages);
    expect(after.history).toEqual(before.history);
    expect(after.events).toEqual(before.events);
    expect(after.audit).toHaveLength(before.audit.length + 1);
    expect(after.audit.at(-1)).toMatchObject({
      stream: "ops",
      action: "delivery.ticket.reevaluate",
    });
  });
});

describe("M5补发沿真实媒体/QC/原包", { timeout: 120_000 }, () => {
  it("真实广告位贯穿计划确认、取消恢复、样片成片登记体检与整包发布，不发生回锁", async () => {
    const f = await prepared(h, false, (o, editor) => confirmedPlacementAd(h, o, editor));
    const ad = f.placement!;
    expect(
      await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: ad.probeJobId } }),
    ).toMatchObject({ kind: "probe", state: "succeeded" });
    expect(
      await h.prisma.mediaCheck.findUniqueOrThrow({ where: { fileId: ad.file.id } }),
    ).toMatchObject({ profile: "ad", gate: "pass" });
    expect(
      await h.prisma.mediaInfo.findUniqueOrThrow({ where: { fileId: ad.file.id } }),
    ).toMatchObject({ durationMs: 3000, displayWidth: 1080, displayHeight: 1920 });
    expect(
      await h.prisma.pointHold.findUniqueOrThrow({ where: { id: ad.held.pointHoldId } }),
    ).toMatchObject({ status: "captured", capturedAt: expect.any(Date) });
    expect(
      await h.prisma.orderItemPlacement.findMany({ where: { orderItemId: f.item.id } }),
    ).toEqual([expect.objectContaining({ slot: "opening", adId: ad.ad.id, durationSec: 3 })]);
    expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
      step: "sample_making",
      waitingOn: "staff",
    });
    const ledgerBefore = await h.prisma.ledgerOperation.findMany({
      where: { entityId: f.o.entity.id },
      orderBy: { id: "asc" },
    });
    const cause = await cancellationCause(h, f.o);
    await h.tx.run(async (tx) =>
      holdCancelReviewPauses(
        tx,
        h.deps,
        cause.ctx,
        await readCancelReviewHoldTargets(tx, h.assembly, cause.approvalId),
      ),
    );
    expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
      step: "sample_making",
      pauseCount: 1,
    });
    await h.prisma.cancelRequest.update({
      where: { id: cause.id },
      data: { status: "not_executed", closedAt: h.clock.now(), closeReason: "withdrawn" },
    });
    await h.tx.run(async (tx) =>
      releaseCancelReviewPauses(tx, h.deps, cause.ctx, {
        targets: await readCancelReviewPauseTargets(tx, [cause.approvalId]),
        releaseEvent: "withdrawn",
      }),
    );
    expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
      step: "sample_making",
      pauseCount: 0,
    });
    const fileId = await productionFile(h, f.o, f.editor, "sample_video"),
      sample = await h.delivery.sampleCreate(f.editor.ctx, f.editor.staff, f.id, {
        fileId,
        adSlots: [{ slot: "opening", startMs: 0, endMs: 3000, label: "真实片头广告" }],
      });
    expect(await h.prisma.mediaCheck.findUniqueOrThrow({ where: { fileId } })).toMatchObject({
      gate: "pass",
      contextSnapshot: { headAdMs: 3000, tailAdMs: 0 },
    });
    expect(await h.prisma.productionRecord.findUniqueOrThrow({ where: { fileId } })).toMatchObject({
      headAdVersionId: ad.version.id,
      pipelineState: "ready",
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
    expect(pushed.release).toMatchObject({ releaseNo: 1 });
    expect(
      await h.prisma.sample.findUniqueOrThrow({ where: { id: sample.sampleId } }),
    ).toMatchObject({
      status: "confirmed",
      adVersionsUsed: [{ slot: "opening", adId: ad.ad.id, versionNo: 1 }],
    });
    expect(
      await h.prisma.episodeOutput.findUniqueOrThrow({
        where: { id: episodes.items[0]!.episodeOutputId },
      }),
    ).toMatchObject({ status: "qc_passed", isCurrent: true });
    expect(
      await h.prisma.orderItemPlacement.findFirstOrThrow({ where: { orderItemId: f.item.id } }),
    ).toMatchObject({ adId: ad.ad.id, boundVersionNo: 1 });
    expect(
      await h.prisma.ledgerOperation.findMany({
        where: { entityId: f.o.entity.id },
        orderBy: { id: "asc" },
      }),
    ).toEqual(ledgerBefore);
  });

  it("真实显式指派后主管代登记样片及成片，保留剪辑师且无隐式认领或改派历史", async () => {
    const f = await prepared(h),
      inspector = await h.staff();
    expect(f.editor.row.staffRoleKey).toBe("editor");
    const owner = async () =>
      (await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: f.id } })).editorId;
    expect(await owner()).toBe(f.editor.row.id);
    const fileId = await productionFile(h, f.o, f.qc, "sample_video");
    const sample = await h.delivery.sampleCreate(f.qc.ctx, f.qc.staff, f.id, {
      fileId,
      adSlots: [],
    });
    expect(
      await h.prisma.sample.findUniqueOrThrow({ where: { id: sample.sampleId } }),
    ).toMatchObject({ uploadedByStaffId: f.qc.row.id, status: "uploaded" });
    expect(await owner()).toBe(f.editor.row.id);
    await h.delivery.sampleInspect(
      inspector.ctx,
      inspector.staff,
      sample.sampleId,
      await checks(h, "qc.sample"),
    );
    await h.delivery.samplePush(inspector.ctx, inspector.staff, sample.sampleId, {});
    await h.delivery.merchantSample(f.o.viewer, f.item.id);
    await h.delivery.sampleConfirm(f.o.viewer, sample.sampleId, {
      versionNo: 1,
      viewedVia: "weapp",
      hasViewed: true,
    });
    const registered = await h.delivery.episodeRegister(f.qc.ctx, f.qc.staff, f.id, {
      items: [{ episodeNo: 1, sampleId: sample.sampleId }],
    });
    expect(
      await h.prisma.episodeOutput.findUniqueOrThrow({
        where: { id: registered.items[0]!.episodeOutputId },
      }),
    ).toMatchObject({ uploadedByStaffId: f.qc.row.id, status: "uploaded" });
    expect(await owner()).toBe(f.editor.row.id);
    expect(await h.prisma.assignmentHistory.count({ where: { subjectId: f.id } })).toBe(0);
    expect(
      await h.prisma.auditLog.count({
        where: { targetId: f.id, action: "delivery.ticket.editor_claimed" },
      }),
    ).toBe(0);
    expect(
      await h.prisma.auditLog.count({
        where: { targetId: f.id, action: "delivery.ticket.assign_editor" },
      }),
    ).toBe(1);
  });
  it("错误步骤拒绝且无补发副作用", async () => {
    const o = await h.order(),
      actor = await h.staff();
    await reason();
    const id = o.deliveryTicketIds[0]!,
      before = await snapshot(id);
    await expect(m5().reissueCreate(actor.ctx, actor.staff, id, reissueBody)).rejects.toMatchObject(
      { error: "REISSUE_NOT_ALLOWED", details: { reason: "step" } },
    );
    expect(await h.prisma.deliveryReissue.count({ where: { deliveryTicketId: id } })).toBe(0);
    expect(await snapshot(id)).toEqual(before);
  });

  it("合法期内唯一open；未齐不可发布、取消收尾、替换QC发布与原key重放一致", async () => {
    const f = await released(h);
    await reason();
    const end = f.item.usageEndDate;
    h.clock.set(new Date(end.getTime() + 86_400_000));
    await expect(m5().reissueCreate(f.qc.ctx, f.qc.staff, f.id, reissueBody)).rejects.toMatchObject(
      { error: "REISSUE_NOT_ALLOWED", details: { reason: "usage_ended" } },
    );
    h.clock.set(new Date("2026-01-05T04:10:00Z"));
    const cancelled = await m5().reissueCreate(f.qc.ctx, f.qc.staff, f.id, reissueBody);
    await expect(m5().reissueCreate(f.qc.ctx, f.qc.staff, f.id, reissueBody)).rejects.toMatchObject(
      {
        error: "REISSUE_NOT_ALLOWED",
        details: { reason: "open_reissue_exists", openReissueId: cancelled.reissueId },
      },
    );
    const precheck = await checks(h, "delivery.precheck");
    await expect(
      m5().reissuePublish(f.qc.ctx, f.qc.staff, cancelled.reissueId, { precheck }),
    ).rejects.toMatchObject({ error: "REISSUE_INCOMPLETE", details: { missingEpisodeNos: [1] } });
    const fileId = await productionFile(h, f.o, f.editor, "final_episode");
    const cancelledOutput = await h.delivery.episodeRegister(f.editor.ctx, f.editor.staff, f.id, {
      reissueId: cancelled.reissueId,
      items: [{ episodeNo: 1, fileId }],
    });
    expect(
      await m5().reissueCancel(f.qc.ctx, f.qc.staff, cancelled.reissueId, {
        note: "商家取消本次修正",
      }),
    ).toMatchObject({ status: "cancelled", closedAt: h.clock.now().toISOString() });
    expect(
      await h.prisma.episodeOutput.findUniqueOrThrow({
        where: { id: cancelledOutput.items[0]!.episodeOutputId },
      }),
    ).toMatchObject({
      status: "replaced",
      isCurrent: false,
      deliveryReissueId: cancelled.reissueId,
    });
    expect(
      await h.prisma.episodeOutput.findUniqueOrThrow({ where: { id: f.original.episodeOutputId } }),
    ).toMatchObject({ status: "qc_passed", isCurrent: true });
    await expect(
      m5().reissueCancel(f.qc.ctx, f.qc.staff, cancelled.reissueId, {}),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    const reissue = await m5().reissueCreate(f.qc.ctx, f.qc.staff, f.id, reissueBody);
    const replacement = await h.delivery.episodeRegister(f.editor.ctx, f.editor.staff, f.id, {
      reissueId: reissue.reissueId,
      items: [{ episodeNo: 1, fileId }],
    });
    const output = replacement.items[0]!;
    expect(output).toMatchObject({
      deliveryReissueId: reissue.reissueId,
      isCurrent: false,
      status: "uploaded",
    });
    expect(
      await h.prisma.episodeOutput.findUniqueOrThrow({ where: { id: f.original.episodeOutputId } }),
    ).toMatchObject({ isCurrent: true, status: "qc_passed" });
    await expect(
      m5().reissuePublish(f.qc.ctx, f.qc.staff, reissue.reissueId, { precheck }),
    ).rejects.toMatchObject({ error: "REISSUE_INCOMPLETE" });
    const qc = await checks(h, "qc.episode");
    await h.delivery.episodeInspect(f.qc.ctx, f.qc.staff, f.id, {
      episodeOutputIds: [output.episodeOutputId],
      checklistVersionNo: qc.checklistVersionNo,
      defaultResults: qc.results,
    });
    expect(
      await h.prisma.episodeOutput.findUniqueOrThrow({ where: { id: output.episodeOutputId } }),
    ).toMatchObject({ isCurrent: false, status: "qc_passed", qcRecordId: expect.any(String) });
    const body = { precheck, note: "第一集修正已经双人质检通过" },
      publishIdem = idem("admin.reissue.publish", f.qc.ctx.actor, body);
    const result = await m5().reissuePublish(f.qc.ctx, f.qc.staff, reissue.reissueId, body, {
      idem: publishIdem(),
    });
    expect(result).toMatchObject({ reissue: { status: "published" }, release: { releaseNo: 2 } });
    const newReleaseId = result.release.deliveryReleaseId;
    expect(
      await h.prisma.deliveryRelease.findUniqueOrThrow({ where: { id: newReleaseId } }),
    ).toMatchObject({
      state: "pushed",
      kind: "reissue",
      changedEpisodeNos: [1],
      manifestSnapshot: [expect.objectContaining({ fileId, episodeNo: 1 })],
    });
    expect(
      await h.prisma.deliveryRelease.findUniqueOrThrow({
        where: { id: f.release.deliveryReleaseId },
      }),
    ).toMatchObject({ state: "superseded" });
    expect(
      await h.prisma.episodeOutput.findUniqueOrThrow({ where: { id: f.original.episodeOutputId } }),
    ).toMatchObject({ status: "replaced", isCurrent: false });
    expect(
      await h.prisma.episodeOutput.findUniqueOrThrow({ where: { id: output.episodeOutputId } }),
    ).toMatchObject({ status: "qc_passed", isCurrent: true });
    expect(
      await h.prisma.downloadGrant.count({
        where: { deliveryReleaseId: newReleaseId, state: "active" },
      }),
    ).toBe(1);
    expect(
      await h.prisma.downloadGrant.count({
        where: { deliveryReleaseId: f.release.deliveryReleaseId, state: "active" },
      }),
    ).toBe(0);
    const before = await snapshot(f.id),
      counts = await Promise.all([
        h.prisma.deliveryRelease.count(),
        h.prisma.downloadGrant.count(),
        h.prisma.qcRecord.count(),
      ]);
    expect(
      await m5().reissuePublish(f.qc.ctx, f.qc.staff, reissue.reissueId, body, {
        idem: publishIdem(),
      }),
    ).toMatchObject({ replayed: true, release: { deliveryReleaseId: newReleaseId } });
    expect(await snapshot(f.id)).toEqual(before);
    expect(
      await Promise.all([
        h.prisma.deliveryRelease.count(),
        h.prisma.downloadGrant.count(),
        h.prisma.qcRecord.count(),
      ]),
    ).toEqual(counts);
    expect(await h.tx.run((tx) => findDeliveryViolations(tx, "I14"))).toEqual([]);
    await h.prisma.deliveryReissue.update({
      where: { id: reissue.reissueId },
      data: { episodeNos: [2] },
    });
    expect(await h.tx.run((tx) => findDeliveryViolations(tx, "I14"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: { type: "delivery_reissue", id: reissue.reissueId },
          entityId: f.o.entity.id,
        }),
      ]),
    );
    await h.prisma.deliveryReissue.update({
      where: { id: reissue.reissueId },
      data: { episodeNos: [1] },
    });
    await h.prisma.deliveryReissue.update({
      where: { id: reissue.reissueId },
      data: { publishedDeliveryReleaseId: f.release.deliveryReleaseId },
    });
    expect(await h.tx.run((tx) => findDeliveryViolations(tx, "I14"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: { type: "delivery_reissue", id: reissue.reissueId } }),
      ]),
    );
    await h.prisma.deliveryReissue.update({
      where: { id: reissue.reissueId },
      data: { publishedDeliveryReleaseId: newReleaseId },
    });
    expect(await h.tx.run((tx) => findDeliveryViolations(tx, "I14"))).toEqual([]);
  });
});

async function lifecycleSnapshot(id: string) {
  const launches = await h.prisma.launchTask.findMany({
    where: { deliveryTicketId: id },
    include: { launchSubmissions: { include: { approvalRequest: true }, orderBy: { id: "asc" } } },
    orderBy: { id: "asc" },
  });
  const takedowns = await h.prisma.takedownTask.findMany({
    where: { deliveryTicketId: id },
    orderBy: { id: "asc" },
  });
  return {
    ...(await snapshot(id)),
    launches,
    takedowns,
    item: await h.prisma.orderItem.findFirstOrThrow({ where: { deliveryTicket: { id } } }),
    timers: await h.prisma.timer.findMany({
      where: { subjectId: { in: [...launches.map((t) => t.id), ...takedowns.map((t) => t.id)] } },
      orderBy: { id: "asc" },
    }),
  };
}

describe("M5使用期收尾与版权续期真实跨域事务", { timeout: 120_000 }, () => {
  it("未到止日的已有下架均获商家确认时，early_end补齐缺失账号且不否定本次授权", async () => {
    const f = await pendingTwoAccountLaunches(h);
    expect(calendarDate(h.clock.now()) < f.item.usageEndDate.toISOString().slice(0, 10)).toBe(true);
    const live = f.tasks.find((t) => t.id === f.liveTaskId)!;
    const missing = f.tasks.find((t) => t.id !== f.liveTaskId)!;
    const due = await h.tx.run(async (tx) =>
      h.deps.sla.dueAt(tx, {
        policy: "takedown.check",
        amount: 1,
        unit: "work_days",
        from: h.clock.now(),
        workHours: await workHoursAt(tx, h.clock.now()),
      }),
    );
    // Only the one pre-existing merchant-confirmed takedown is a fixture; package and live evidence are real.
    const confirmed = await h.prisma.takedownTask.create({
      data: {
        id: uuidv7(),
        entityId: f.o.entity.id,
        storeId: f.o.store.id,
        orderItemId: f.item.id,
        deliveryTicketId: f.id,
        launchTaskId: live.id,
        channelAccountId: live.channelAccountId,
        triggerKind: "early_end",
        basis: "live",
        usageEndDate: f.item.usageEndDate,
        dueDate: f.item.usageEndDate,
        status: "merchant_confirmed",
        merchantMethod: "delete",
        merchantConfirmedAt: h.clock.now(),
        merchantConfirmedByUserId: f.o.user.id,
        checkDueAt: due.dueAt,
        slaSnapshot: { ...due.snapshot },
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    expect(await h.prisma.takedownTask.count({ where: { deliveryTicketId: f.id } })).toBe(1);
    const before = await snapshot(f.id);
    const result = await m5().reevaluate(f.qc.ctx, f.qc.staff, f.id, {});
    expect(result.ticket.step).toBe("takedown");
    expect(result.transitions).toEqual([
      expect.objectContaining({ event: "usage.ended", fromStep: "in_service", toStep: "takedown" }),
    ]);
    const tasks = await h.prisma.takedownTask.findMany({
      where: { deliveryTicketId: f.id },
      orderBy: { id: "asc" },
    });
    expect(tasks).toHaveLength(2);
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: confirmed.id,
          status: "merchant_confirmed",
          merchantConfirmedAt: confirmed.merchantConfirmedAt,
        }),
        expect.objectContaining({
          launchTaskId: missing.id,
          channelAccountId: missing.channelAccountId,
          triggerKind: "early_end",
          basis: "delivered_unverified",
          status: "pending_merchant",
          merchantConfirmedAt: null,
        }),
      ]),
    );
    expect(await h.prisma.orderItem.findUniqueOrThrow({ where: { id: f.item.id } })).toMatchObject({
      usageEndDate: f.item.usageEndDate,
    });
    for (const pending of f.pending)
      expect(
        await h.prisma.approvalRequest.findUniqueOrThrow({
          where: { id: pending.approvalRequestId },
        }),
      ).toMatchObject({ status: "withdrawn", isDecidedBySystem: true });
    const after = await snapshot(f.id);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.entries).toEqual(before.entries);
    expect(after.accounts).toEqual(before.accounts);
    expect((await m5().reevaluate(f.qc.ctx, f.qc.staff, f.id, {})).transitions).toEqual([]);
    expect(
      await h.prisma.takedownTask.findMany({
        where: { deliveryTicketId: f.id },
        orderBy: { id: "asc" },
      }),
    ).toEqual(tasks);
  });
  it("两账号审批union到期系统撤回、未上线void/已上线settle，续期仅同步未核查任务", async () => {
    const f = await pendingTwoAccountLaunches(h);
    expect(f.pending).toHaveLength(2);
    const graph = await h.tx.run((tx) => prepareReevaluation(tx, [f.id]));
    expect(graph.approvalRequestIds).toEqual(f.pending.map((r) => r.approvalRequestId).sort());
    await reason();
    const openReissue = await m5().reissueCreate(f.qc.ctx, f.qc.staff, f.id, reissueBody);
    const followUp = await h.prisma.followUp.create({
      data: {
        id: uuidv7(),
        subjectType: "delivery_reissue",
        subjectId: openReissue.reissueId,
        entityId: f.o.entity.id,
        storeId: f.o.store.id,
        channel: "system",
        content: "到期前尚未完成的补发系统跟进",
        nextFollowAt: h.clock.now(),
        ownerStaffId: f.o.order.deliveryManagerId!,
        actorType: "system",
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const before = await lifecycleSnapshot(f.id);
    await expect(
      h.tx.run(async (tx) => {
        await prepareReevaluation(tx, [f.id]);
        const targets = await readDeliveryPublishTargets(tx, [f.item.id]);
        await closeExpiredDeliveryPublish(
          tx,
          { ...h.deps, approval: h.approval },
          f.qc.ctx,
          targets,
          { deliveryTicketId: f.id, now: h.clock.now() },
        );
      }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    await expect(
      h.tx.run(async (tx) => {
        await prepareReevaluation(tx, [f.id]);
        const targets = await readDeliveryPublishTargets(tx, [f.item.id]);
        await closeExpiredDeliveryPublish(
          tx,
          { ...h.deps, approval: h.approval },
          f.qc.ctx,
          targets,
          { deliveryTicketId: uuidv7(), now: h.clock.now() },
        );
      }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(await lifecycleSnapshot(f.id)).toEqual(before);
    h.clock.set(new Date(f.item.usageEndDate.getTime() + 86_400_000 + 4 * 3_600_000));
    const result = await m5().reevaluate(f.qc.ctx, f.qc.staff, f.id, {});
    expect(result.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "usage.ended",
          fromStep: "in_service",
          toStep: "takedown",
        }),
      ]),
    );
    expect(result.ticket.step).toBe("takedown");
    expect(
      await h.prisma.deliveryReissue.findUniqueOrThrow({ where: { id: openReissue.reissueId } }),
    ).toMatchObject({ status: "open", closedAt: null, publishedDeliveryReleaseId: null });
    expect(await h.prisma.followUp.findUniqueOrThrow({ where: { id: followUp.id } })).toMatchObject(
      { doneAt: h.clock.now(), lockVersion: followUp.lockVersion + 1 },
    );
    const closed = await lifecycleSnapshot(f.id);
    const live = closed.launches.find((t) => t.id === f.liveTaskId)!;
    const neverLive = closed.launches.find((t) => t.id !== f.liveTaskId)!;
    expect(live).toMatchObject({ isLive: true, reviewStatus: "passed", voidReason: null });
    expect(neverLive).toMatchObject({
      isLive: false,
      reviewStatus: "void",
      voidReason: "usage_expired",
    });
    for (const pending of f.pending) {
      expect(
        await h.prisma.launchSubmission.findUniqueOrThrow({ where: { id: pending.id } }),
      ).toMatchObject({ result: "withdrawn" });
      expect(
        await h.prisma.approvalRequest.findUniqueOrThrow({
          where: { id: pending.approvalRequestId },
        }),
      ).toMatchObject({ status: "withdrawn", isDecidedBySystem: true, decidedAt: h.clock.now() });
    }
    expect(closed.takedowns).toHaveLength(2);
    expect(closed.takedowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          launchTaskId: live.id,
          basis: "live",
          triggerKind: "expiry",
          status: "pending_merchant",
          usageEndDate: f.item.usageEndDate,
          dueDate: f.item.usageEndDate,
        }),
        expect.objectContaining({
          launchTaskId: neverLive.id,
          basis: "delivered_unverified",
          triggerKind: "expiry",
          status: "pending_merchant",
        }),
      ]),
    );
    const repeated = await m5().reevaluate(f.qc.ctx, f.qc.staff, f.id, {});
    expect(repeated.transitions).toEqual([]);
    const afterRepeat = await lifecycleSnapshot(f.id);
    expect(afterRepeat.launches).toEqual(closed.launches);
    expect(afterRepeat.takedowns).toEqual(closed.takedowns);
    expect(afterRepeat.history).toEqual(closed.history);
    expect(afterRepeat.events).toEqual(closed.events);
    const beforeForged = await lifecycleSnapshot(f.id);
    await expect(
      h.tx.run(async (tx) => {
        await prepareReevaluation(tx, [f.id]);
        const targets = await readDeliveryPublishTargets(tx, [f.item.id]);
        await closeExpiredDeliveryPublish(
          tx,
          { ...h.deps, approval: h.approval },
          f.qc.ctx,
          { ...targets, channelAccountIds: [] },
          { deliveryTicketId: f.id, now: h.clock.now() },
        );
      }),
    ).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
    expect(await lifecycleSnapshot(f.id)).toEqual(beforeForged);
    const packageBeforeCancel = await h.prisma.deliveryRelease.findUniqueOrThrow({
      where: { id: f.release.deliveryReleaseId },
    });
    const cancelBody = { note: "使用期已结束，取消未发布的补发" },
      cancelIdem = idem("admin.reissue.cancel", f.qc.ctx.actor, cancelBody);
    const cancelled = await m5().reissueCancel(
      f.qc.ctx,
      f.qc.staff,
      openReissue.reissueId,
      cancelBody,
      { idem: cancelIdem() },
    );
    expect(cancelled).toMatchObject({ status: "cancelled", closedAt: h.clock.now().toISOString() });
    const afterCancel = await lifecycleSnapshot(f.id);
    expect(
      await m5().reissueCancel(f.qc.ctx, f.qc.staff, openReissue.reissueId, cancelBody, {
        idem: cancelIdem(),
      }),
    ).toEqual({ ...cancelled, replayed: true });
    expect(await lifecycleSnapshot(f.id)).toEqual(afterCancel);
    expect(
      await h.prisma.deliveryRelease.findUniqueOrThrow({
        where: { id: f.release.deliveryReleaseId },
      }),
    ).toEqual(packageBeforeCancel);
    const unchecked = closed.takedowns.find((t) => t.launchTaskId === live.id)!;
    const checked = closed.takedowns.find((t) => t.launchTaskId === neverLive.id)!;
    const due = await h.tx.run(async (tx) =>
      h.deps.sla.dueAt(tx, {
        policy: "takedown.check",
        amount: 1,
        unit: "work_days",
        from: h.clock.now(),
        workHours: await workHoursAt(tx, h.clock.now()),
      }),
    );
    await h.tx.run(async (tx) => {
      await prepareReevaluation(tx, [f.id]);
      await tx.takedownTask.update({
        where: { id: unchecked.id },
        data: {
          status: "merchant_confirmed",
          merchantMethod: "delete",
          merchantConfirmedAt: h.clock.now(),
          merchantConfirmedByUserId: f.o.user.id,
          checkDueAt: due.dueAt,
          slaSnapshot: { ...due.snapshot },
        },
      });
      await tx.takedownTask.update({
        where: { id: checked.id },
        data: {
          status: "checked",
          merchantMethod: "not_published",
          merchantConfirmedAt: h.clock.now(),
          merchantConfirmedByUserId: f.o.user.id,
          checkedAt: h.clock.now(),
          checkMethod: "sampled_out",
        },
      });
      const timers = createTimers({ assembly: h.assembly });
      for (const id of [unchecked.id, checked.id])
        await timers.cancel(tx, {
          subject: { type: "takedown_task", id },
          kinds: ["takedown.overdue"],
        });
    });
    const checkedBefore = await h.prisma.takedownTask.findUniqueOrThrow({
      where: { id: checked.id },
    });
    const today = calendarDate(h.clock.now()),
      next = addDays(today, 30),
      rightsEnd = addDays(today, 60);
    await h.prisma.dramaCopyright.upsert({
      where: { dramaId: f.item.dramaId },
      create: {
        dramaId: f.item.dramaId,
        source: "own",
        platforms: ["douyin", "wechat_channels"],
        licenseStartDate: new Date("2026-01-01"),
        licenseEndDate: new Date(rightsEnd),
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
      update: { licenseEndDate: new Date(rightsEnd), updatedAt: h.clock.now() },
    });
    const ticket = await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: f.id } });
    const body = {
      toStep: "in_service" as const,
      note: "核实当前剧目版权续期后恢复服务",
      confirm: { ticketNo: ticket.ticketNo, fromStep: "takedown" as const },
    };
    const staff = { ...f.qc.staff, stepUpAt: h.clock.now() },
      beforeRenewal = await lifecycleSnapshot(f.id);
    for (const newUsageEndDate of [undefined, today, addDays(rightsEnd, 1)]) {
      await expect(
        m5().forceTransition(f.qc.ctx, staff, f.id, {
          ...body,
          ...(newUsageEndDate ? { newUsageEndDate } : {}),
        }),
      ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
      expect(await lifecycleSnapshot(f.id)).toEqual(beforeRenewal);
    }
    await m5().forceTransition(f.qc.ctx, staff, f.id, { ...body, newUsageEndDate: next });
    expect(await h.prisma.orderItem.findUniqueOrThrow({ where: { id: f.item.id } })).toMatchObject({
      usageEndDate: new Date(next),
      usageEndSource: "license",
    });
    expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
      step: "in_service",
    });
    const synced = await h.prisma.takedownTask.findUniqueOrThrow({ where: { id: unchecked.id } });
    expect(synced).toMatchObject({
      status: "merchant_confirmed",
      usageEndDate: new Date(next),
      dueDate: new Date(next),
      merchantConfirmedAt: unchecked.merchantConfirmedAt ?? h.clock.now(),
    });
    expect(synced.checkDueAt!.getTime()).toBeGreaterThan(due.dueAt.getTime());
    expect(synced.slaSnapshot).toMatchObject({
      policy: "takedown.check",
      amount: 1,
      unit: "work_days",
    });
    expect(await h.prisma.takedownTask.findUniqueOrThrow({ where: { id: checked.id } })).toEqual(
      checkedBefore,
    );
    const renewed = await lifecycleSnapshot(f.id);
    expect(renewed.ledger).toEqual(beforeRenewal.ledger);
    expect(renewed.entries).toEqual(beforeRenewal.entries);
    expect(renewed.accounts).toEqual(beforeRenewal.accounts);
  });
});
