import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AdPricingSnapshotSchema,
  CalendarImportBodySchema,
  FollowUpListQuerySchema,
} from "@liyoxi/contract";
import { calendarDate, addDays } from "@liyoxi/shared/time";
import { quoteDramaItem } from "@liyoxi/shared/pricing";
import { SYSTEM_SCOPE } from "../authz/index.js";
import { record } from "../audit/index.js";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import type { DeliveredEvent } from "../kernel/index.js";
import { createCalendarAdmin } from "../sla/index.js";
import { createStaffFollowUps } from "../staff/index.js";
import {
  assertSnapshotsEqual,
  snapshotTables,
  useSeededDatabase,
  sampleStaffContext,
} from "../testing/index.js";
import { MONEY_TABLES, REQUEST_TABLES, requestsHarness } from "./__fixtures__/cancel-requests.js";
import type { RequestsHarness } from "./__fixtures__/cancel-requests.js";
import { createEvents, claimDeliveries, consumeDelivery } from "../events/index.js";
import { onOrderCalendarImported } from "./calendar-facts.js";
import { onOrderLicenseShortened } from "./license-shortened.js";
const db = useSeededDatabase("services", { max: 1 });
let h: RequestsHarness;
beforeAll(async () => {
  h = requestsHarness(await db.prisma());
}, 120000);
afterAll(async () => h?.close());
const event = (type: string, payload: Record<string, unknown>) =>
  ({ type, payload, id: uuidv7() }) as DeliveredEvent;
const deliver = async (e: DeliveredEvent) => {
  const events = createEvents({
    tx: h.tx,
    clock: h.clock,
    assembly: {
      subscribers: h.assembly.subscribers.filter((r) =>
        ["order.onCalendarImported", "order.onLicenseShortened"].includes(r.name),
      ),
    },
  });
  const ctx = createIdentityContext({ actor: { type: "system", job: "lyxtest.w505.dispatch" } });
  await h.tx.run((tx) =>
    events.emit(tx, ctx, {
      type: e.type,
      payload: e.payload,
      ...(e.type === "drama.license_shortened"
        ? { aggregate: { type: "drama", id: String(e.payload.dramaId) } }
        : {}),
    }),
  );
  await events.expand(200);
  const refs = await h.tx.run((tx) => claimDeliveries(tx, 200));
  for (const ref of refs.claimed)
    expect(
      await consumeDelivery(
        {
          tx: h.tx,
          subscribers: events.subscribers,
          alerts: {
            raise: async (input) => {
              h.alerts.push(input);
            },
          },
        },
        ref,
      ),
    ).toBe("done");
};

describe("W5-05 订单后续真实事实", { timeout: 120000 }, () => {
  it("后台报价使用当前版本价目及同一取整函数，草稿未定价/null和未上架套餐可读且零写", async () => {
    const p = await h.pending(),
      id = p.ds[0]!.id;
    const before = await snapshotTables(h.prisma, REQUEST_TABLES);
    const q = await h.order.adminQuote({ dramaId: id, planCode: "pro", isTopModel: true });
    expect(q.chargePoints).toBe(
      quoteDramaItem({
        listPricePoints: q.listPricePoints!,
        discountBp: q.discountBp,
        topModelSurchargeBp: q.surchargeBp,
        isTopModelSelected: true,
        isTopModelIncluded: q.productionModel === "top",
      }).chargePoints,
    );
    expect(q.unorderableReason).toBeNull();
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, REQUEST_TABLES));
    const draft = await h.make.drama({ status: "draft", heatTier: null });
    const result = await h.order.adminQuote({ dramaId: draft.id, planCode: "pro" });
    expect(result).toMatchObject({
      listPricePoints: null,
      chargePoints: null,
      formula: null,
      orderable: false,
    });
    await expect(h.order.adminQuote({ dramaId: id, planCode: "missing" })).rejects.toMatchObject({
      error: "PLAN_NOT_AVAILABLE",
    });
    await expect(h.order.adminQuote({ dramaId: uuidv7(), planCode: "pro" })).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
  });

  it("活动流仅本单真实对象，稳定游标/同请求迁移脱敏、跨scope拒绝，GET零写", async () => {
    const p = await h.atStage("plan_confirm"),
      sibling = await h.pending(),
      actor = await h.staff();
    await h.param("refund.points.auto_approve_before_production", false, actor);
    const request = await h.create(p),
      saved = await h.saved(request.cancelRequestId);
    const ctx = createIdentityContext({ actor: { type: "system", job: "lyxtest.w505.activity" } });
    await h.tx.run(async (tx) => {
      for (const [type, id] of [
        ["approval_request", saved.approvalRequestId],
        ["drama_order", sibling.out.orderId],
      ] as const)
        await record(
          tx,
          ctx.actor,
          {
            requestId: ctx.requestId,
            ip: null,
            userAgent: null,
            authMethod: null,
            sessionId: null,
            jobName: "lyxtest.w505.activity",
          },
          {
            stream: "activity",
            category: "flow",
            action: "order.test.activity",
            summary: "订单实际操作",
            target: { type, id },
            entityId: p.b.entity.id,
            storeId: p.b.store.id,
            before: null,
            after: { privateValue: "never-expose" },
            fields: ["privateValue"],
          },
        );
    });
    const before = await snapshotTables(h.prisma, REQUEST_TABLES);
    const ids = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const page = await h.order.activityList(SYSTEM_SCOPE, p.out.orderId, {
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      for (const row of page.items) {
        expect(ids.has(row.activityId)).toBe(false);
        ids.add(row.activityId);
        expect(row.targetId).not.toBe(sibling.out.orderId);
        expect(row).not.toHaveProperty("after");
      }
      if (!page.hasMore) break;
      cursor = page.nextCursor!;
    }
    expect(ids.size).toBeGreaterThan(2);
    const all = await h.order.activityList(SYSTEM_SCOPE, p.out.orderId, { limit: 100 });
    expect(all.items.some((r) => r.targetId === saved.approvalRequestId)).toBe(true);
    expect(all.items.some((r) => r.transition !== null)).toBe(true);
    const outsider = await h.make.staff({ staffRoleKey: "delivery_manager" }),
      scope = (await sampleStaffContext(h.prisma, outsider.id)).scope;
    await expect(h.order.activityList(scope, p.out.orderId, {})).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    await expect(
      h.order.activityList(SYSTEM_SCOPE, sibling.out.orderId, { cursor }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, REQUEST_TABLES));
  });

  it("日历跨节假日真实重排取消执行及首版广告时限，重复/乱序不新增timer，作废不复活", async () => {
    const actor = await h.staff();
    await h.param("sla.review.refund_execute", { amount: 2, unit: "work_days" }, actor);
    await h.param("refund.points.auto_approve_before_production", false, actor);
    const p = await h.atStage("plan_confirm"),
      request = await h.create(p),
      approver = await h.staff();
    await h.requests.approve(
      approver,
      request.cancelRequestId,
      await h.approveBody(request.cancelRequestId),
    );
    const before = await h.saved(request.cancelRequestId),
      from = before.approvalRequest.decidedAt!;
    // Ad producer belongs to W5-08. Seed only its legal pending fact after a real ledger hold.
    const q = await h.qualificationOrder(),
      ad = await h.unassignedAd(q),
      due = await h.tx.run((tx) =>
        h.deps.sla.dueAt(tx, {
          policy: "ad.first_version",
          amount: 2,
          unit: "work_days",
          from: ad.submittedAt,
          workHours: { start: "09:00", end: "18:00" },
        }),
      );
    await h.prisma.ad.update({
      where: { id: ad.id },
      data: {
        firstDueAt: due.dueAt,
        dueAt: due.dueAt,
        slaSnapshot: { ...due.snapshot },
      },
    });
    const date = addDays(calendarDate(from), 1),
      year = Number(date.slice(0, 4)),
      calendar = createCalendarAdmin(h.core);
    await calendar.import(
      { staff: actor.staff!, identity: actor.ctx },
      CalendarImportBodySchema.parse({
        source: "W505 calendar correction",
        year,
        days: [{ date, kind: "holiday", note: "测试工作日修正" }],
      }),
    );
    const current = await h.prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: "calendar.imported" },
      orderBy: { seq: "desc" },
    });
    const e = event("calendar.imported", current.payload as Record<string, unknown>);
    const money = await snapshotTables(h.prisma, MONEY_TABLES);
    await deliver(e);
    const after = await h.saved(request.cancelRequestId),
      freshAd = await h.prisma.ad.findUniqueOrThrow({ where: { id: ad.id } });
    expect(after.execDueAt!.getTime()).toBeGreaterThan(before.execDueAt!.getTime());
    expect(freshAd.firstDueAt.getTime()).toBeGreaterThan(due.dueAt.getTime());
    const first = await snapshotTables(h.prisma, ["timer", "audit_log", "cancel_request", "ad"]);
    await deliver(e);
    await deliver(
      event("calendar.imported", { v: 1, calendarVersion: 1, year, changedDays: [date] }),
    );
    assertSnapshotsEqual(
      first,
      await snapshotTables(h.prisma, ["timer", "audit_log", "cancel_request", "ad"]),
    );
    assertSnapshotsEqual(money, await snapshotTables(h.prisma, MONEY_TABLES));
    const row = await h.saved(request.cancelRequestId);
    await h.requests.void(p.actor, row.id, {
      note: "撤销本次取消操作",
    });
    const closed = await snapshotTables(h.prisma, ["timer", "cancel_request"]);
    await deliver(e);
    assertSnapshotsEqual(closed, await snapshotTables(h.prisma, ["timer", "cancel_request"]));
    expect(onOrderCalendarImported).toBeTypeOf("function");
    expect(AdPricingSnapshotSchema.safeParse(ad.pricingSnapshot).success).toBe(true);
  });

  it("许可缩短读取当前历史修订；两角色实际可读完成；同修订去重、后续修订同止日仍有新待办，订单零改", async () => {
    const p = await h.pending(),
      operator = await h.make.staff({ staffRoleKey: "content_ops" }),
      item = p.items[0]!;
    // Current content API deliberately rejects shortening. Historical copyright is test precondition only.
    const shorten = async () => {
      const id = uuidv7(),
        end = new Date(item.usageEndDate.getTime() - 86400000);
      const revision = await h.prisma.dramaCopyrightRevision.create({
        data: {
          id,
          dramaId: item.dramaId,
          changeKind: "shorten",
          copyrightSnapshot: {},
          prevEndDate: item.usageEndDate,
          newEndDate: end,
          reason: "历史许可缩短事实",
          proofFileIds: [],
          createdByStaffId: operator.id,
          createdAt: h.clock.now(),
        },
      });
      await h.prisma.dramaCopyright.update({
        where: { dramaId: item.dramaId },
        data: { licenseEndDate: end, currentDramaCopyrightRevisionId: revision.id },
      });
      return event("drama.license_shortened", {
        v: 1,
        dramaId: item.dramaId,
        dramaCopyrightRevisionId: id,
        prevEndDate: calendarDate(item.usageEndDate),
        newEndDate: calendarDate(end),
      });
    };
    const e = await shorten(),
      before = await snapshotTables(h.prisma, [
        ...MONEY_TABLES,
        "drama_order",
        "order_item",
        "delivery_ticket",
      ]);
    await deliver(e);
    const rows = await h.prisma.followUp.findMany({
      where: { subjectType: "order_item", subjectId: item.id, channel: "system" },
    });
    expect(rows.map((r) => r.ownerStaffId)).toEqual(
      expect.arrayContaining([operator.id, p.manager.id]),
    );
    const follow = createStaffFollowUps(h.core),
      staff = await sampleStaffContext(h.prisma, operator.id),
      identity = createIdentityContext({
        actor: { type: "staff", id: operator.id, client: "admin" },
      }),
      query = FollowUpListQuerySchema.parse({ mine: "true" });
    const mine = await follow.list(staff, query),
      own = mine.items.find((r) => r.subjectId === item.id)!;
    expect(own.actions).toContain("complete");
    await follow.complete(staff, identity, own.followUpId, { lockVersion: own.lockVersion });
    await deliver(e);
    expect(
      await h.prisma.followUp.count({ where: { subjectId: item.id, ownerStaffId: operator.id } }),
    ).toBe(1);
    const second = await shorten();
    await deliver(second);
    await deliver(e);
    expect(
      await h.prisma.followUp.count({ where: { subjectId: item.id, ownerStaffId: operator.id } }),
    ).toBe(2);
    assertSnapshotsEqual(
      before,
      await snapshotTables(h.prisma, [
        ...MONEY_TABLES,
        "drama_order",
        "order_item",
        "delivery_ticket",
      ]),
    );
    expect(h.alerts.some((r) => r.rule === "order.license_shortened")).toBe(true);
    expect(onOrderLicenseShortened).toBeTypeOf("function");
  });
});
