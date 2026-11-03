import { ChecklistItemsSchema } from "@liyoxi/contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, dayRange } from "@liyoxi/shared/time";
import { createIdempotencyContext, fileRefTypePort, uuidv7 } from "../kernel/index.js";
import { ownTaskScope } from "../authz/index.js";
import {
  createCancelRequestsFixture,
  createTakedownFixture,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import { createLaunchRevoke } from "./launch-revoke.js";
import { createPublishTakedown } from "./takedown-service.js";
const db = useSeededDatabase("services", { max: 2 });
let h: ReturnType<typeof createTakedownFixture>;
beforeAll(async () => {
  h = createTakedownFixture(await db.prisma());
});
beforeEach(() => h.clock.set(new Date("2026-01-05T04:00:00Z")));
afterAll(async () => {
  await h?.close();
});
const tables = [
  "takedown_task",
  "delivery_ticket",
  "order_item",
  "drama_order",
  "status_transition",
  "outbox_event",
  "audit_log",
  "timer",
  "file_ref",
  "manual_reminder_log",
  "download_grant",
  "delivery_release",
];
const snapshot = () => snapshotTables(h.prisma, tables);

describe("W6-04 下架确认、核查与真实归档", { timeout: 60_000 }, () => {
  it("两个真实上线账号部分确认保持服务，全部确认进入下架，逐条核查归档并保存原授权、历史与成片留存", async () => {
    const f = await h.ready({ twoAccounts: true, live: true }),
      [a, b] = f.takedowns;
    const originalEnd = f.item.usageEndDate.toISOString().slice(0, 10);
    const historicalLaunch = await h.prisma.launchSubmission.findMany({
      where: { launchTaskId: { in: f.tasks.map((r) => r.id) } },
      orderBy: { id: "asc" },
    });
    const grants = await h.prisma.downloadGrant.findMany({ where: { orderItemId: f.item.id } });
    await expect(
      h.takedown.confirm(f.o.viewer, a!.id, { method: "not_published" }),
    ).rejects.toMatchObject({
      error: "TAKEDOWN_METHOD_NOT_ALLOWED",
      details: { allowedMethods: ["delete", "private"] },
    });
    await h.takedown.confirm(f.o.viewer, a!.id, { method: "delete" });
    expect(await h.prisma.deliveryTicket.findUnique({ where: { id: f.id } })).toMatchObject({
      step: "in_service",
    });
    await h.takedown.confirm(f.o.viewer, b!.id, { method: "private" });
    expect(await h.prisma.deliveryTicket.findUnique({ where: { id: f.id } })).toMatchObject({
      step: "takedown",
    });
    const first = await h.takedown.check(f.qc.ctx, f.qc.staff, a!.id, await h.checkBody(f, a!.id));
    expect(first).toMatchObject({ status: "checked", checkMethod: "evidence" });
    expect(await h.prisma.deliveryTicket.findUnique({ where: { id: f.id } })).toMatchObject({
      step: "takedown",
    });
    const second = await h.takedown.check(f.qc.ctx, f.qc.staff, b!.id, await h.checkBody(f, b!.id));
    expect(second.ticket.step).toBe("archived");
    expect(await h.prisma.orderItem.findUnique({ where: { id: f.item.id } })).toMatchObject({
      phase: "ended",
      usageEndDate: f.item.usageEndDate,
    });
    expect(await h.prisma.dramaOrder.findUnique({ where: { id: f.o.order.id } })).toMatchObject({
      status: "ended",
    });
    expect(await h.prisma.downloadGrant.findMany({ where: { orderItemId: f.item.id } })).toEqual(
      grants.map((g) => expect.objectContaining({ id: g.id, state: "revoked" })),
    );
    expect(
      await h.prisma.launchSubmission.findMany({
        where: { launchTaskId: { in: f.tasks.map((r) => r.id) } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(historicalLaunch);
    expect(
      await h.prisma.deliveryRelease.findUnique({ where: { id: f.release.deliveryReleaseId } }),
    ).toMatchObject({ state: "closed", closeReason: "usage_ended" });
    const refs = await h.prisma.fileRef.findMany({
      where: { refType: "delivery_release", refId: f.release.deliveryReleaseId, role: "ep" },
    });
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs)
      expect(ref).toMatchObject({
        state: "released",
        keepUntil: dayRange(addDays(originalEnd, 91)).start,
      });
    for (const id of [a!.id, b!.id]) {
      expect(
        await h.prisma.fileRef.count({
          where: { refType: "takedown_task", refId: id, state: "live" },
        }),
      ).toBe(2);
      expect(
        await h.prisma.timer.count({
          where: {
            subjectId: id,
            kind: "takedown.overdue",
            status: { in: ["scheduled", "dispatched"] },
          },
        }),
      ).toBe(0);
    }
    const policy = h.assembly.portEntries(fileRefTypePort).get("takedown_task")!.roles!.evidence!;
    expect(policy.retentionDays).toBe(1095);
    expect(await h.tx.run((tx) => policy.canRelease!(tx, a!.id))).toBe(false);
  });

  it("跨工单整批预锁；任一错误全批零写，写中异常也回滚，成功保持请求顺序", async () => {
    const a = await h.ready({ live: true });
    h.clock.set(new Date("2026-01-05T04:00:00Z"));
    const b = await h.ready({ live: true }),
      ta = a.takedowns[0]!,
      tb = b.takedowns[0]!;
    await h.takedown.confirm(a.o.viewer, ta.id, { method: "delete" });
    await h.takedown.confirm(b.o.viewer, tb.id, { method: "delete" });
    const items = [
      { takedownTaskId: tb.id, ...(await h.checkBody(b, tb.id)) },
      { takedownTaskId: ta.id, ...(await h.checkBody(a, ta.id)) },
    ];
    const before = await snapshot();
    await expect(
      h.takedown.batchCheck(a.qc.ctx, a.qc.staff, {
        items: [items[0]!, { ...items[1]!, checklistCode: "takedown.absence_check" }],
      }),
    ).rejects.toMatchObject({
      error: "TAKEDOWN_BATCH_REJECTED",
      details: { items: [{ index: 1, takedownTaskId: ta.id, error: "PRECONDITION_CHANGED" }] },
    });
    expect(await snapshot()).toEqual(before);
    let calls = 0;
    const broken = createPublishTakedown({
      ...h.takedownDeps,
      media: {
        signRead: h.media.signRead,
        link: async (...args) => {
          const result = await h.media.link(...args);
          if (++calls === 3) throw new Error("lyxtest.batch.rollback");
          return result;
        },
      },
    });
    await expect(broken.batchCheck(a.qc.ctx, a.qc.staff, { items })).rejects.toThrow(
      "lyxtest.batch.rollback",
    );
    expect(await snapshot()).toEqual(before);
    const competing = await Promise.allSettled(
      [items, [...items].reverse()].map((command) => {
        const body = { items: command };
        const idem = createIdempotencyContext({
          mode: "required",
          scope: "admin.takedownTask.batchCheck",
          actor: a.qc.ctx.actor,
          key: uuidv7(),
          request: { method: "POST", body },
        });
        return h.takedown.batchCheck(a.qc.ctx, a.qc.staff, body, { idem });
      }),
    );
    expect(competing.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(competing.filter((r) => r.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          error: "TAKEDOWN_BATCH_REJECTED",
          details: {
            items: [
              expect.objectContaining({ index: 0, error: "STATE_NOT_ALLOWED" }),
              expect.objectContaining({ index: 1, error: "STATE_NOT_ALLOWED" }),
            ],
          },
        }),
      }),
    ]);
    for (const [index, outcome] of competing.entries())
      if (outcome.status === "fulfilled") {
        expect(outcome.value.items.map((i) => i.takedownTaskId)).toEqual(
          index === 0 ? [tb.id, ta.id] : [ta.id, tb.id],
        );
        expect(outcome.value.archivedTicketIds).toEqual([a.id, b.id].sort());
      }
  });

  it("未发布确认后真实上线重开依据；仍在线不回退已下架工单；逾期升级与违约提醒日限频", async () => {
    const f = await h.ready({ twoAccounts: true }),
      [a, b] = f.takedowns;
    await h.takedown.confirm(f.o.viewer, a!.id, { method: "not_published" });
    await h.launch(f, a!.launchTaskId);
    expect(await h.prisma.takedownTask.findUnique({ where: { id: a!.id } })).toMatchObject({
      status: "pending_merchant",
      basis: "live",
      merchantMethod: null,
      checkDueAt: null,
    });
    await h.takedown.confirm(f.o.viewer, a!.id, { method: "delete" });
    await h.takedown.confirm(f.o.viewer, b!.id, { method: "not_published" });
    expect(await h.prisma.deliveryTicket.findUnique({ where: { id: f.id } })).toMatchObject({
      step: "takedown",
    });
    await h.takedown.markOnline(f.qc.ctx, f.qc.staff, a!.id, { note: "核查仍能看到作品" });
    expect(await h.prisma.deliveryTicket.findUnique({ where: { id: f.id } })).toMatchObject({
      step: "takedown",
    });
    await expect(h.takedown.escalate(f.qc.ctx, f.qc.staff, a!.id, {})).rejects.toMatchObject({
      error: "TAKEDOWN_NOT_OVERDUE",
    });
    h.clock.set(dayRange(addDays(a!.dueDate.toISOString().slice(0, 10), 1)).start);
    await h.takedown.escalate(f.qc.ctx, f.qc.staff, a!.id, { note: "已超过应完成日" });
    await h.takedown.sendBreachNotice(f.qc.ctx, f.qc.staff, a!.id);
    const before = await snapshot();
    await expect(h.takedown.sendBreachNotice(f.qc.ctx, f.qc.staff, a!.id)).rejects.toMatchObject({
      error: "REMINDED_TODAY",
    });
    expect(await snapshot()).toEqual(before);
    const detail = await h.takedown.get(f.qc.staff, a!.id);
    expect(detail.timeline.map((e) => e.kind)).toEqual(
      expect.arrayContaining([
        "created",
        "merchant_confirmed",
        "basis_reopened",
        "found_online",
        "escalated",
        "breach_notified",
      ]),
    );
    expect(detail.timeline.filter((e) => e.kind === "breach_notified")).toHaveLength(1);
    expect(
      await h.prisma.followUp.count({
        where: { subjectType: "takedown_task", subjectId: a!.id, actorType: "system" },
      }),
    ).toBe(0);
  });

  it("门店筛选与任务scope相交、老板/店员边界、读零写和失去范围后的幂等重放拒绝", async () => {
    const f = await h.ready(),
      id = f.takedowns[0]!.id,
      stranger = await h.staff("publisher");
    const scoped = { ...stranger.staff, scope: ownTaskScope(stranger.row) };
    const before = await snapshot();
    expect(
      await h.takedown.list(scoped, {
        storeId: f.o.store.id,
        tab: "waiting",
        page: 1,
        pageSize: 20,
      }),
    ).toMatchObject({ total: 0, items: [] });
    expect(await h.takedown.summary(scoped, { storeId: f.o.store.id })).toMatchObject({
      pending: 0,
      waiting: 0,
      checked: 0,
    });
    await expect(h.takedown.get(scoped, id)).rejects.toMatchObject({ error: "NOT_FOUND" });
    const member = {
      ...f.o.viewer,
      membership: { ...f.o.viewer.membership, role: "clerk" as const },
    };
    await expect(
      h.takedown.merchantList(member, { tab: "pending", limit: 20 }),
    ).rejects.toMatchObject({ error: "ROLE_FORBIDDEN" });
    const list = await h.takedown.merchantList(f.o.viewer, { tab: "pending", limit: 20 });
    expect(list.items.map((i) => i.takedownTaskId)).toContain(id);
    expect(await h.takedown.merchantSummary(f.o.viewer)).toMatchObject({ pending: 1, done: 0 });
    await h.takedown.get(f.qc.staff, id);
    expect(await snapshot()).toEqual(before);
    const body = await h.checkBody(f, id),
      key = uuidv7();
    const idem = () =>
      createIdempotencyContext({
        mode: "required",
        scope: "admin.takedownTask.check",
        actor: f.qc.ctx.actor,
        key,
        request: { method: "POST", pathParams: { takedownTaskId: id }, body },
      });
    await h.takedown.check(f.qc.ctx, f.qc.staff, id, body, { idem: idem() });
    await expect(
      h.takedown.check(f.qc.ctx, { ...f.qc.staff, scope: ownTaskScope(stranger.row) }, id, body, {
        idem: idem(),
      }),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
  });
  it("同键并发确认只抽一次，历史冻结真实参数；重放封面脱敏且不重抽", async () => {
    const f = await h.ready({ live: true }),
      id = f.takedowns[0]!.id;
    await h.prisma.paramValue.create({
      data: {
        id: uuidv7(),
        key: "takedown.check_mode",
        value: { mode: "sampled", sampleBp: 1 },
        effectiveAt: h.clock.now(),
        createdAt: h.clock.now(),
        createdByStaffId: f.qc.row.id,
      },
    });
    let draws = 0;
    const sampled = createPublishTakedown({
      ...h.takedownDeps,
      sampleDraw: () => {
        draws++;
        return 10000;
      },
    });
    const key = uuidv7(),
      body = { method: "delete" as const };
    const idem = () =>
      createIdempotencyContext({
        mode: "required",
        scope: "m.takedownTask.confirm",
        actor: f.o.viewer.ctx.actor,
        key,
        request: {
          method: "POST",
          pathParams: { takedownTaskId: id },
          body,
          storeId: f.o.store.id,
        },
        redact: ["posterUrl"],
      });
    const results = await Promise.all(
      [0, 1].map(() => sampled.confirm(f.o.viewer, id, body, { idem: idem() })),
    );
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(results.find((r) => r.replayed)?.posterUrl).toBeNull();
    expect(draws).toBe(1);
    expect(results[0]!.status).toBe("checked");
    const stored = await h.prisma.takedownTask.findUniqueOrThrow({ where: { id } });
    expect(stored).toMatchObject({
      checkMethod: "sampled_out",
      checkedByStaffId: null,
      checklistCode: null,
      evidenceFileIds: [],
    });
    expect(
      await h.prisma.statusTransition.findFirstOrThrow({
        where: { subjectId: id, event: "takedown.merchant_confirm" },
      }),
    ).toMatchObject({
      payload: {
        checkMode: { mode: "sampled", sampleBp: 1 },
        draw: 10000,
        selectedForCheck: false,
      },
    });
    expect(await h.prisma.deliveryTicket.findUnique({ where: { id: f.id } })).toMatchObject({
      step: "archived",
    });
  });

  it("真实撤销上线、取消申请/审批/执行形成terminated后仍可核查且不复活工单", async () => {
    const c = createCancelRequestsFixture(h.prisma);
    try {
      const p = await c.atStage("live", "platform_fault"),
        submission = await c.prisma.launchSubmission.findFirstOrThrow({
          where: { launchTask: { orderItemId: p.items[0]!.id }, result: "passed" },
          include: { approvalRequest: true },
        });
      await createLaunchRevoke({
        ...c.core,
        approval: c.cancelDeps.approval,
        media: c.media,
      }).revoke(p.qc.ctx, p.qc.staff!, submission.id, {
        reason: "真实复核发现作品并未在线",
        confirm: {
          roundNo: submission.roundNo,
          verifiedEpisodeCount: submission.verifiedEpisodeCount!,
        },
      });
      const input = { reasonCode: "platform_fault" as const },
        quote = await c.requests.quote(p.actor, p.out.orderId, input);
      const created = await c.requests.create(p.actor, p.out.orderId, {
        ...input,
        note: "真实交付后未上线取消下架验收",
        expect: quote.expect,
      });
      const approver = await c.staff();
      await c.requests.approve(
        approver,
        created.cancelRequestId,
        await c.approveBody(created.cancelRequestId),
      );
      const saved = await c.saved(created.cancelRequestId);
      await c.execute(await c.staff(), {
        id: saved.id,
        confirm: {
          requestNo: saved.approvalRequest.requestNo!,
          totalRefundPoints: saved.totalRefundPoints,
        },
      });
      const task = await c.prisma.takedownTask.findFirstOrThrow({
        where: { orderItemId: p.items[0]!.id, status: { not: "void" } },
      });
      const terminal = await c.prisma.deliveryTicket.findUniqueOrThrow({
        where: { id: task.deliveryTicketId },
      });
      expect(terminal.step).toBe("terminated");
      const takedown = createPublishTakedown({
        ...c.core,
        approval: c.cancelDeps.approval,
        media: c.media,
        timers: c.cancelDeps.timers,
      });
      const template = await c.prisma.checklistTemplate.findFirstOrThrow({
        where: { code: "takedown.absence_check", status: "active" },
      });
      const evidenceFileIds = [];
      for (let i = 0; i < 2; i++)
        evidenceFileIds.push(
          (
            await c.make.fileObject({
              category: "evidence",
              bucket: "asset",
              scopeType: "store",
              entityId: task.entityId,
              storeId: task.storeId,
              uploadActorType: "staff",
              uploadActorId: p.qc.staff!.staff.id,
              uploadClient: "admin",
            })
          ).id,
        );
      const result = await takedown.check(p.qc.ctx, p.qc.staff!, task.id, {
        checklistCode: "takedown.absence_check",
        checklistVersionNo: template.versionNo,
        results: ChecklistItemsSchema.parse(template.items).map((item) => ({
          key: item.key,
          result: "pass" as const,
        })),
        evidenceFileIds,
      });
      expect(result).toMatchObject({
        status: "checked",
        checkMethod: "evidence",
        ticket: { step: "terminated" },
        merchantMethod: null,
      });
      expect(await c.prisma.deliveryTicket.findUnique({ where: { id: terminal.id } })).toEqual(
        terminal,
      );
      expect(
        await c.prisma.statusTransition.count({
          where: { subjectId: terminal.id, event: "takedown.all_checked" },
        }),
      ).toBe(0);
    } finally {
      await c.close();
    }
  });
});
