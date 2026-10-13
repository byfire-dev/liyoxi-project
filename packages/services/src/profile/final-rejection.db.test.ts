import { beforeAll, describe, expect, it } from "vitest";
import type { FinalRejectImpact, QualificationRejectBody } from "@liyoxi/contract";
import { createIdempotencyContext, createIdentityContext, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { previewReturn } from "../billing/index.js";
import { scopeOf } from "../authz/index.js";
import {
  assertSnapshotsEqual,
  assembleForTest,
  sampleStaffContext,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";
import { complete, harness, submit } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { branchReady, changeName, newStoreReady, qualified } from "./__fixtures__/rounds.js";
import { impactFixture } from "./__fixtures__/final-rejection.js";
import { createProfile } from "./service.js";
import { QualificationImpactPort } from "./ports.js";

const db = useSeededDatabase("services", { max: 1 });
let h: Harness;
async function readPreview(tx: Tx, holdId: string, qty: number, at: Date) {
  const { arbitrageHint: _hint, ...preview } = await previewReturn(
    tx,
    { holdId, qty, reasonClass: "merchant" },
    at,
  );
  return preview;
}
const tables = [
  "entity",
  "store",
  "store_profile",
  "qualification_submission",
  "qualification_doc",
  "approval_request",
  "status_transition",
  "audit_log",
  "outbox_event",
  "timer",
  "file_ref",
  "billing_account",
  "point_hold",
  "point_hold_alloc",
  "point_lot",
  "point_ledger_entry",
  "ledger_operation",
  "drama_order",
  "order_item",
  "ad",
  "cancel_request",
  "cancel_request_line",
];
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
async function pending() {
  const w = await h.owner(),
    ready = await complete(h, w.viewer);
  await submit(h, w.viewer, ready.submissionId);
  return { ...w, ...ready };
}
async function reviewer() {
  const row = await h.make.staff({ staffRoleKey: "super_admin" });
  return {
    row,
    staff: await sampleStaffContext(h.prisma, row.id),
    ctx: createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" } }),
  };
}
function body(impact: FinalRejectImpact): QualificationRejectBody {
  return {
    isFinal: true,
    reasonCodes: ["R01"],
    note: "无法补正",
    confirm: {
      pendingStartOrderCount: impact.pendingStartOrderCount,
      pendingAssignAdCount: impact.pendingAssignAdCount,
      heldPoints: impact.heldPoints,
    },
  };
}
describe("W2-11终局驳回真实影响与决定", { timeout: 60000 }, () => {
  it("真实port只读统计待开工及pending_assign/对应returned，排除在途取消及制作中广告", async () => {
    const w = await pending(),
      r = await reviewer(),
      f = await impactFixture(h, w.viewer, readPreview);
    const order = await f.order(),
      excluded = await f.order();
    const ad = await f.ad(),
      returned = await f.ad("returned", "pending_assign");
    const excludedAd = await f.ad();
    await f.ad("returned", "producing");
    await f.inflight({ id: excluded.row.id, points: excluded.points }, "order_cancel");
    await f.inflight({ id: excludedAd.id, points: excludedAd.chargePoints }, "ad_cancel");
    const before = await snapshotTables(h.prisma, tables);
    for (let n = 0; n < 2; n++) {
      const impact = await h.profile.admin.rejectQuote(r.staff, w.submissionId);
      expect(impact).toEqual({
        pendingStartOrderCount: 1,
        pendingAssignAdCount: 2,
        heldPoints: order.points + ad.chargePoints + returned.chargePoints,
        orders: [{ orderId: order.row.id, orderNo: order.row.orderNo, heldPoints: order.points }],
        ads: expect.arrayContaining([
          { adId: ad.id, adNo: ad.adNo, heldPoints: ad.chargePoints },
          { adId: returned.id, adNo: returned.adNo, heldPoints: returned.chargePoints },
        ]),
        computedAt: h.clock.now().toISOString(),
      });
    }
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
    expect(() =>
      assembleForTest({ entry: "api", withoutRealPorts: [QualificationImpactPort] }),
    ).toThrow(/profile.qualification_impact/);
  });

  it("缺任一回显、逐项漂移及预览后新订购均回滚；非终局仍核roundNo", async () => {
    const w = await pending(),
      r = await reviewer(),
      f = await impactFixture(h, w.viewer, readPreview);
    const impact = await h.profile.admin.rejectQuote(r.staff, w.submissionId);
    const before = await snapshotTables(h.prisma, tables);
    for (const field of ["pendingStartOrderCount", "pendingAssignAdCount", "heldPoints"] as const) {
      const input = body(impact);
      input.confirm![field] = impact[field] + 1;
      await expect(
        h.profile.admin.reject(r.ctx, r.staff, w.submissionId, input),
      ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
      delete input.confirm![field];
      await expect(
        h.profile.admin.reject(r.ctx, r.staff, w.submissionId, input),
      ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
    }
    await expect(
      h.profile.admin.reject(r.ctx, r.staff, w.submissionId, {
        isFinal: false,
        reasonCodes: ["R01"],
        note: "非终局",
        confirm: impact,
      }),
    ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
    await f.order();
    const afterOrder = await snapshotTables(h.prisma, tables);
    await expect(
      h.profile.admin.reject(r.ctx, r.staff, w.submissionId, body(impact)),
    ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
    assertSnapshotsEqual(afterOrder, await snapshotTables(h.prisma, tables));
  });

  it("initial终局写齐时间/真实事件/三链历史，原证据保留，重放一次且不执行M5取消", async () => {
    const w = await pending(),
      r = await reviewer(),
      f = await impactFixture(h, w.viewer, readPreview);
    await f.order();
    await f.ad();
    const impact = await h.profile.admin.rejectQuote(r.staff, w.submissionId),
      input = body(impact);
    const moneyTables = [
      "billing_account",
      "point_hold",
      "point_hold_alloc",
      "point_lot",
      "point_ledger_entry",
      "ledger_operation",
      "drama_order",
      "order_item",
      "ad",
      "cancel_request",
      "file_ref",
    ];
    const before = await snapshotTables(h.prisma, moneyTables),
      key = uuidv7();
    const idem = () =>
      createIdempotencyContext({
        mode: "required",
        scope: "admin.qualificationSubmission.reject",
        key,
        actor: r.ctx.actor,
        request: { method: "POST", body: input },
      });
    const result = await h.profile.admin.reject(r.ctx, r.staff, w.submissionId, input, {
      idem: idem(),
    });
    expect(result).toMatchObject({
      outcome: "rejected",
      finalRejectedAt: h.clock.now().toISOString(),
      closedAt: h.clock.now().toISOString(),
      store: { qualificationStatus: "rejected" },
      entity: { verificationStatus: "rejected" },
      approval: { status: "rejected" },
    });
    expect(
      await h.profile.admin.reject(r.ctx, r.staff, w.submissionId, input, { idem: idem() }),
    ).toEqual(result);
    const round = await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: w.submissionId },
    });
    const profile = await h.prisma.storeProfile.findUniqueOrThrow({
      where: { storeId: w.store.id },
    });
    expect(profile.finalRejectedAt).toEqual(round.finalRejectedAt);
    expect(profile.lastDecidedAt).toEqual(round.closedAt);
    for (const id of [w.entity.id, w.store.id, round.approvalRequestId!])
      expect(await h.prisma.statusTransition.count({ where: { subjectId: id } })).toBe(2);
    const events = await h.prisma.outboxEvent.findMany({
      where: {
        eventType: "store.qualification.rejected",
        aggregateId: w.store.id,
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      submissionId: w.submissionId,
      isFinal: true,
      reasonCodes: ["R01"],
    });
    expect(
      await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: w.docId } }),
    ).toMatchObject({ verdict: "accepted", effectiveAt: null, removedAt: null });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, moneyTables));
    expect(await h.profile.qualification(w.viewer)).toMatchObject({
      isFinalRejected: true,
      actions: [],
    });
    await expect(
      h.profile.updateQualification(w.viewer, { lockVersion: null }),
    ).rejects.toMatchObject({ error: "QUALIFICATION_CLOSED" });
    await expect(
      h.tx.run((tx) =>
        h.tenant.setStoreQualification(tx, w.viewer.ctx, {
          storeId: w.store.id,
          round: "initial",
          action: "submit",
        }),
      ),
    ).rejects.toMatchObject({ error: "QUALIFICATION_CLOSED" });
  });

  it("new_store终局只拒绝本店；主体/首店合法字段证照不变且真实终局事实阻断绕过缓存重提", async () => {
    const w = await qualified(h),
      next = await newStoreReady(h, w.viewer),
      r = await reviewer();
    const doc = await branchReady(h, next.viewer);
    await submit(h, next.viewer, next.roundId);
    const entity = await h.prisma.entity.findUniqueOrThrow({ where: { id: w.entity.id } });
    const primary = await h.prisma.store.findUniqueOrThrow({ where: { id: w.store.id } });
    const legal = await h.prisma.qualificationDoc.findUniqueOrThrow({
      where: { id: w.ready.docId },
    });
    const impact = await h.profile.admin.rejectQuote(r.staff, next.roundId);
    const result = await h.profile.admin.reject(r.ctx, r.staff, next.roundId, {
      ...body(impact),
      rejectedDocIds: [doc.doc.qualificationDocId],
    });
    expect(result).toMatchObject({
      kind: "new_store",
      outcome: "rejected",
      entity: { verificationStatus: "verified" },
    });
    expect(await h.prisma.entity.findUniqueOrThrow({ where: { id: w.entity.id } })).toEqual(entity);
    expect(await h.prisma.store.findUniqueOrThrow({ where: { id: w.store.id } })).toEqual(primary);
    expect(
      await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: w.ready.docId } }),
    ).toEqual(legal);
    expect(
      await h.prisma.qualificationDoc.findUniqueOrThrow({
        where: { id: doc.doc.qualificationDocId },
      }),
    ).toMatchObject({ verdict: "rejected", effectiveAt: null });
    await expect(submit(h, next.viewer, next.roundId)).rejects.toMatchObject({
      error: "STATE_NOT_ALLOWED",
    });
    await expect(
      h.profile.updateQualification(next.viewer, { lockVersion: null }),
    ).rejects.toMatchObject({ error: "QUALIFICATION_CLOSED" });
    await h.prisma.storeProfile.update({
      where: { storeId: next.store.id },
      data: { finalRejectedAt: null },
    });
    const before = await snapshotTables(h.prisma, tables);
    await expect(
      h.tx.run((tx) =>
        h.flow.transition(tx, next.viewer.ctx, {
          machine: "store",
          stateField: "qualification_status",
          id: next.store.id,
          entityId: w.entity.id,
          storeId: next.store.id,
          event: "qualification.submit",
          emit: { none: true, primary: "store.qualification.submitted" },
        }),
      ),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });

  it("scope/权限/在审/禁止自审及change不能终局守卫保留，非法原因证照零写", async () => {
    const w = await qualified(h),
      changed = await changeName(h, w.viewer),
      r = await reviewer();
    const id = changed.pendingChange!.qualificationSubmissionId;
    await submit(h, w.viewer, id);
    const before = await snapshotTables(h.prisma, tables);
    await expect(h.profile.admin.rejectQuote(r.staff, id)).rejects.toMatchObject({
      error: "QUALIFICATION_FINAL_NOT_ALLOWED",
    });
    await expect(
      h.profile.admin.reject(
        r.ctx,
        r.staff,
        id,
        body({
          pendingStartOrderCount: 0,
          pendingAssignAdCount: 0,
          heldPoints: 0,
          orders: [],
          ads: [],
          computedAt: h.clock.now().toISOString(),
        }),
      ),
    ).rejects.toMatchObject({ error: "QUALIFICATION_FINAL_NOT_ALLOWED" });
    await expect(h.profile.admin.rejectQuote(r.staff, w.ready.submissionId)).rejects.toMatchObject({
      error: "APPROVAL_NOT_PENDING",
    });
    await expect(h.profile.admin.rejectQuote(r.staff, uuidv7())).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    const narrow = {
      ...r.staff,
      scope: scopeOf({ id: r.row.id, isLead: false }, { dataScope: "own" }, [], new Set()),
    };
    await expect(h.profile.admin.rejectQuote(narrow, id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
    const p = await pending(),
      impact = await h.profile.admin.rejectQuote(r.staff, p.submissionId);
    for (const input of [
      { ...body(impact), reasonCodes: ["NO_SUCH_REASON"] },
      { ...body(impact), rejectedDocIds: [w.ready.docId] },
    ]) {
      await expect(
        h.profile.admin.reject(r.ctx, r.staff, p.submissionId, input),
      ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    }
    const self = await h.make.staff({ id: p.user.id, staffRoleKey: "super_admin" });
    await expect(
      h.profile.admin.reject(
        createIdentityContext({ actor: { type: "staff", id: self.id, client: "admin" } }),
        await sampleStaffContext(h.prisma, self.id),
        p.submissionId,
        body(impact),
      ),
    ).rejects.toMatchObject({ error: "APPROVAL_SELF_FORBIDDEN" });
    const noPermission = await h.make.staff({ staffRoleKey: "editor" });
    await expect(
      h.profile.admin.rejectQuote(
        await sampleStaffContext(h.prisma, noPermission.id),
        p.submissionId,
      ),
    ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
  });

  it("晚期事件失败整笔回滚终局/审批/历史/审计，系统决定不能冒充人工终局", async () => {
    const w = await pending(),
      r = await reviewer(),
      impact = await h.profile.admin.rejectQuote(r.staff, w.submissionId);
    const profile = createProfile({
      tx: h.tx,
      clock: h.clock,
      assembly: assembleForTest({ entry: "api" }),
      tenant: h.tenant,
      approval: h.approval,
      events: {
        ...h.events,
        emit: async (tx, ctx, event) => {
          if (event.type === "store.qualification.rejected")
            throw new Error("final rollback fixture");
          return h.events.emit(tx, ctx, event);
        },
      },
      media: h.media,
      keyring: () => TEST_KEYRING,
      wechat: h.fake.wechat,
      currentOpenid: async () => "test",
    });
    const before = await snapshotTables(h.prisma, tables);
    await expect(
      profile.admin.reject(r.ctx, r.staff, w.submissionId, body(impact)),
    ).rejects.toThrow("final rollback fixture");
    await expect(
      h.profile.reject(
        createIdentityContext({ actor: { type: "system", job: "lyxtest.final" } }),
        w.submissionId,
        body(impact),
      ),
    ).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });
});
