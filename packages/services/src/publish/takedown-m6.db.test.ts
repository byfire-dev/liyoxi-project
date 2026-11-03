import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { addDays, atMinuteOfDay, dayRange } from "@liyoxi/shared/time";
import { alertsOf, createIdentityContext } from "../kernel/index.js";
import { ownTaskScope } from "../authz/index.js";
import { createTimers, runTimer } from "../timers/index.js";
import {
  createUsageLifecycleForTest,
  createTakedownFixture,
  claimTakedownTimer,
  useSeededDatabase,
  snapshotTables,
} from "../testing/index.js";
import {
  createContent,
  createContentCopyright,
  createContentLicense,
  DramaPricePort,
} from "../content/index.js";
import {
  findTakedownViolations,
  repairMissingTakedowns,
  repairTakedownTimers,
  TAKEDOWN_INVARIANT_CODES,
} from "./takedown-invariants.js";
import { ensureTakedownTasks, readDeliveryPublishTargets } from "./delivery-lifecycle.js";
import { launchChangedPort } from "./ports.js";

const db = useSeededDatabase("services", { max: 2 });
beforeAll(async () => {
  await db.prisma();
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const h = createTakedownFixture(await db.prisma());
  cleanups.push(() => h.close());
  const wrapper = h.createRuntime();
  cleanups.push(() => wrapper.close());
  const timers = createTimers({ assembly: wrapper.assembly });
  async function fire(id: string) {
    const row = await h.prisma.timer.findUniqueOrThrow({ where: { id } });
    const claimed = await claimTakedownTimer(h.tx, {
      timerId: id,
      subjectId: row.subjectId!,
      now: h.clock.now(),
    });
    const deps = {
      tx: h.tx,
      clock: h.clock,
      assembly: wrapper.assembly,
      registry: timers.registry,
      alerts: alertsOf(wrapper.assembly),
    };
    const result = await runTimer(deps, claimed!);
    if (result === "retry")
      throw new Error(
        (await h.prisma.timer.findUniqueOrThrow({ where: { id } })).lastError ?? "timer failed",
      );
    return { result, repeat: () => runTimer(deps, claimed!) };
  }
  return { ...h, wrapper, timers, fire };
}
it.each([29, 30, 31])("推包距止日%d天走唯一生成writer，真实timer只建每账号一行", async (days) => {
  const h = await fixture(),
    f = await h.ready({ twoAccounts: true, daysBeforeEnd: days });
  expect(f.takedowns).toHaveLength(days <= 30 ? 2 : 0);
  const end = f.item.usageEndDate.toISOString().slice(0, 10);
  if (days > 30) {
    const timer = await h.prisma.timer.findFirstOrThrow({
      where: { kind: "takedown.create", subjectId: f.item.id, status: "scheduled" },
    });
    h.clock.set(dayRange(addDays(end, -30)).start);
    const fired = await h.fire(timer.id);
    expect(fired.result).toBe("fired");
    expect(await fired.repeat()).toBe("stale");
  }
  const ensure = () =>
    h.tx.run(async (tx) => {
      await h.assembly.port(launchChangedPort)(tx, {
        orderItemId: f.item.id,
        deliveryTicketId: f.id,
        phase: "prelock",
      });
      await ensureTakedownTasks(
        tx,
        h.takedownDeps,
        createIdentityContext({ actor: { type: "system", job: "takedown.test" } }),
        await readDeliveryPublishTargets(tx, [f.item.id]),
        { deliveryTicketId: f.id, now: h.clock.now() },
      );
    });
  await Promise.all([ensure(), ensure()]);
  const tasks = await h.prisma.takedownTask.findMany({
    where: { deliveryTicketId: f.id, status: { not: "void" } },
  });
  expect(tasks).toHaveLength(2);
  expect(
    await h.prisma.statusTransition.count({
      where: { subjectId: { in: tasks.map((t) => t.id) }, event: "takedown.create" },
    }),
  ).toBe(2);
  expect(
    await h.prisma.timer.count({
      where: {
        kind: "takedown.overdue",
        subjectId: { in: tasks.map((t) => t.id) },
        status: "scheduled",
      },
    }),
  ).toBe(2);
});
it("I16检测真实缺项并经唯一writer自愈，I17–I20逐项查询反例且恢复后零违规", async () => {
  const h = await fixture(),
    f = await h.ready({ twoAccounts: true, daysBeforeEnd: 31 });
  h.clock.set(dayRange(addDays(f.item.usageEndDate.toISOString().slice(0, 10), -30)).start);
  expect(
    (await h.tx.run((tx) => findTakedownViolations(tx, "I16", h.clock.now()))).some(
      (v) => v.subject && "id" in v.subject && v.subject.id === f.item.id,
    ),
  ).toBe(true);
  expect(
    (await h.tx.run((tx) => repairMissingTakedowns(tx, h.takedownDeps, h.clock.now()))).some(
      (v) => v.subject && "id" in v.subject && v.subject.id === f.item.id && v.healed,
    ),
  ).toBe(true);
  const row = await h.prisma.takedownTask.findFirstOrThrow({ where: { deliveryTicketId: f.id } });
  // Fault injection is confined to invariants; no injected success states are accepted.
  await h.prisma.takedownTask.update({
    where: { id: row.id },
    data: { basis: "live", dueDate: new Date(addDays(row.dueDate.toISOString().slice(0, 10), 1)) },
  });
  for (const code of ["I17", "I19"])
    expect(
      (await h.tx.run((tx) => findTakedownViolations(tx, code, h.clock.now()))).some(
        (v) => v.subject && "id" in v.subject && v.subject.id === row.id,
      ),
    ).toBe(true);
  await h.prisma.takedownTask.update({
    where: { id: row.id },
    data: { basis: row.basis, dueDate: row.dueDate },
  });
  const other = f.tasks.find((task) => task.id !== row.launchTaskId)!;
  await h.prisma.takedownTask.update({ where: { id: row.id }, data: { launchTaskId: other.id } });
  expect(
    (await h.tx.run((tx) => findTakedownViolations(tx, "I18", h.clock.now()))).some(
      (v) => v.subject && "id" in v.subject && v.subject.id === row.id,
    ),
  ).toBe(true);
  await h.prisma.takedownTask.update({
    where: { id: row.id },
    data: { launchTaskId: row.launchTaskId },
  });
  const body = await h.checkBody(f, row.id);
  await h.takedown.check(f.qc.ctx, f.qc.staff, row.id, body);
  const ref = await h.prisma.fileRef.findFirstOrThrow({
    where: { refType: "takedown_task", refId: row.id },
  });
  await h.prisma.fileRef.delete({ where: { id: ref.id } });
  expect(
    (await h.tx.run((tx) => findTakedownViolations(tx, "I20", h.clock.now()))).some(
      (v) => v.subject && "id" in v.subject && v.subject.id === row.id,
    ),
  ).toBe(true);
  await h.prisma.fileRef.create({ data: ref });
  for (const code of TAKEDOWN_INVARIANT_CODES)
    expect(await h.tx.run((tx) => findTakedownViolations(tx, code, h.clock.now())), code).toEqual(
      [],
    );
});
it("I7补缺并取消孤儿，逾期timer真升级且不制造系统跟进", async () => {
  const h = await fixture(),
    f = await h.ready(),
    row = f.takedowns[0]!;
  await h.tx.run((tx) =>
    h.timers.cancel(tx, {
      subject: { type: "takedown_task", id: row.id },
      kinds: ["takedown.overdue"],
    }),
  );
  expect(
    (await h.tx.run((tx) => repairTakedownTimers(tx, h.takedownDeps, h.clock.now()))).some(
      (v) => v.subject && "id" in v.subject && v.subject.id === row.id && v.healed,
    ),
  ).toBe(true);
  expect(await h.tx.run((tx) => repairTakedownTimers(tx, h.takedownDeps, h.clock.now()))).toEqual(
    [],
  );
  const timer = await h.prisma.timer.findFirstOrThrow({
    where: { kind: "takedown.overdue", subjectId: row.id, status: "scheduled" },
  });
  h.clock.set(atMinuteOfDay(addDays(row.dueDate.toISOString().slice(0, 10), 1), 540));
  const fired = await h.fire(timer.id);
  expect(fired.result).toBe("fired");
  expect(await fired.repeat()).toBe("stale");
  expect(await h.prisma.takedownTask.findUnique({ where: { id: row.id } })).toMatchObject({
    status: "pending_merchant",
    escalatedAt: h.clock.now(),
  });
  expect(
    await h.prisma.followUp.count({
      where: { subjectType: "takedown_task", subjectId: row.id, actorType: "system" },
    }),
  ).toBe(0);
  await h.takedown.confirm(f.o.viewer, row.id, { method: "not_published" });
  const orphan = await h.tx.run((tx) =>
    h.timers.arm(tx, {
      kind: "takedown.overdue",
      subject: { type: "takedown_task", id: row.id },
      key: `takedown.overdue:takedown_task:${row.id}:2099-01-01`,
      fireAt: new Date("2099-01-02T01:00:00Z"),
      entityId: row.entityId,
      storeId: row.storeId,
      payload: { dueDate: "2099-01-01" },
    }),
  );
  expect(await h.tx.run((tx) => repairTakedownTimers(tx, h.takedownDeps, h.clock.now()))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        subject: { type: "timer", id: orphan.id },
        detail: { orphan: true },
      }),
    ]),
  );
  expect(await h.prisma.timer.findUnique({ where: { id: orphan.id } })).toMatchObject({
    status: "cancelled",
  });
  expect(await h.tx.run((tx) => repairTakedownTimers(tx, h.takedownDeps, h.clock.now()))).toEqual(
    [],
  );
});
async function rescheduledFixture() {
  const h = await fixture(),
    f = await h.ready({ daysBeforeEnd: 31 });
  const oldCreate = await h.prisma.timer.findFirstOrThrow({
    where: { kind: "takedown.create", subjectId: f.item.id, status: "scheduled" },
  });
  h.clock.set(oldCreate.fireAt);
  expect((await h.fire(oldCreate.id)).result).toBe("fired");
  const task = await h.prisma.takedownTask.findFirstOrThrow({ where: { deliveryTicketId: f.id } });
  const oldOverdue = await h.prisma.timer.findFirstOrThrow({
    where: { kind: "takedown.overdue", subjectId: task.id },
  });
  const license = createContentLicense({ ...h.deps, timers: h.timers }),
    content = createContent({ ...h.deps, media: h.media, license });
  await h.tx.run((tx) =>
    content.delist(tx, f.qc.ctx, f.item.dramaId, {
      reasonCode: "ops_strategy",
      note: "隔离用例真实顺延",
    }),
  );
  const old = await h.prisma.dramaCopyright.findUniqueOrThrow({
    where: { dramaId: f.item.dramaId },
  });
  const end = addDays(f.item.usageEndDate.toISOString().slice(0, 10), 90);
  const proof = await h.make.fileObject({
    category: "drama_license_doc",
    bucket: "secure",
    ext: "pdf",
    mime: "application/pdf",
  });
  await h.tx.run((tx) =>
    createContentCopyright({
      ...h.deps,
      media: h.media,
      prices: h.assembly.port(DramaPricePort),
      license,
    }).revise(tx, f.qc.ctx, f.item.dramaId, {
      lockVersion: old.lockVersion,
      changeKind: "extend",
      reason: "旧代timer隔离验证",
      confirm: { prevEndDate: old.licenseEndDate!.toISOString().slice(0, 10) },
      revisionProofFileIds: [proof.id],
      copyright: {
        source: "licensed",
        platforms: ["douyin", "wechat_channels"],
        territory: "中国大陆",
        hasNetworkRight: true,
        canSublicense: true,
        canEditEmbed: true,
        canAdapt: true,
        licenseStartDate: "2020-01-01",
        licenseEndDate: end,
        proofFileIds: [proof.id],
      },
    }),
  );
  const event = await h.prisma.outboxEvent.findFirstOrThrow({
    where: { eventType: "drama.license_extended", aggregateId: f.item.dramaId },
    orderBy: { seq: "desc" },
  });
  const life = createUsageLifecycleForTest(h.deps);
  await h.tx.run((tx) =>
    life.onLicenseExtended(tx, {
      id: event.id,
      type: event.eventType,
      payload: event.payload as Record<string, unknown>,
    }),
  );
  const resync = await h.prisma.timer.findFirstOrThrow({
    where: { kind: "usage.resync", subjectId: f.item.id, status: "scheduled" },
  });
  expect(
    await h.tx.run((tx) =>
      life.handle(tx, { ...resync, payload: resync.payload as Record<string, unknown> }),
    ),
  ).toBe("fired");
  return { h, f, task, oldCreate, oldOverdue, end };
}

describe("真实版权顺延后的作废下架任务", () => {
  let prepared: Awaited<ReturnType<typeof rescheduledFixture>>;
  beforeAll(async () => {
    prepared = await rescheduledFixture();
  });
  it("旧代失效、新T-30生成；作废写返回状态冲突，混批零写且读取和外范围隐藏", async () => {
    const { h, f, task, oldCreate, oldOverdue, end } = prepared;
    expect(await h.prisma.takedownTask.findUnique({ where: { id: task.id } })).toMatchObject({
      status: "void",
    });
    expect(await h.prisma.timer.findUnique({ where: { id: oldOverdue.id } })).toMatchObject({
      status: "cancelled",
    });
    for (const timer of [oldCreate, oldOverdue])
      expect(
        await h.tx.run((tx) =>
          h.wrapper.assembly
            .timerHandler(timer.kind)!
            .handle(tx, { ...timer, payload: timer.payload as Record<string, unknown> }),
        ),
      ).toBe("skipped");
    const next = await h.prisma.timer.findFirstOrThrow({
      where: { kind: "takedown.create", subjectId: f.item.id, status: "scheduled" },
    });
    h.clock.set(next.fireAt);
    expect((await h.fire(next.id)).result).toBe("fired");
    const active = await h.prisma.takedownTask.findMany({
      where: { deliveryTicketId: f.id, status: { not: "void" } },
    });
    expect(active).toEqual([
      expect.objectContaining({
        status: "pending_merchant",
        usageEndDate: new Date(end),
        dueDate: new Date(end),
      }),
    ]);
    const current = active[0]!,
      oldBody = await h.checkBody(f, task.id),
      currentBody = await h.checkBody(f, current.id),
      stranger = await h.staff("publisher"),
      scoped = { ...stranger.staff, scope: ownTaskScope(stranger.row) },
      foreign = await h.make.merchant({ verified: true });
    const foreignMember = await h.prisma.entityMember.findFirstOrThrow({
      where: { entityId: foreign.entity.id, merchantUserId: foreign.user.id },
    });
    const outsider = {
      ctx: createIdentityContext({
        actor: { type: "merchant", id: foreign.user.id, client: "weapp" },
      }),
      membership: {
        memberId: foreignMember.id,
        entityId: foreign.entity.id,
        storeId: foreign.store.id,
        role: "owner" as const,
        storeMode: "active" as const,
      },
    };
    const snapshot = () =>
      snapshotTables(h.prisma, [
        "takedown_task",
        "delivery_ticket",
        "delivery_ticket_stage",
        "order_item",
        "drama_order",
        "status_transition",
        "outbox_event",
        "audit_log",
        "timer",
        "file_ref",
        "file_object",
        "manual_reminder_log",
        "download_grant",
        "delivery_release",
        "follow_up",
        "launch_task",
        "launch_submission",
        "approval_request",
      ]);
    const before = await snapshot();
    const oldItem = { takedownTaskId: task.id, ...oldBody },
      currentItem = { takedownTaskId: current.id, ...currentBody };
    for (const items of [
      [currentItem, oldItem],
      [oldItem, currentItem],
    ]) {
      await expect(h.takedown.batchCheck(f.qc.ctx, f.qc.staff, { items })).rejects.toMatchObject({
        error: "TAKEDOWN_BATCH_REJECTED",
        details: {
          items: [
            {
              index: items.findIndex((item) => item.takedownTaskId === task.id),
              takedownTaskId: task.id,
              error: "STATE_NOT_ALLOWED",
            },
          ],
        },
      });
      expect(await snapshot()).toEqual(before);
    }
    for (const write of [
      () => h.takedown.confirm(f.o.viewer, task.id, { method: "not_published" }),
      () => h.takedown.check(f.qc.ctx, f.qc.staff, task.id, oldBody),
      () => h.takedown.markOnline(f.qc.ctx, f.qc.staff, task.id, {}),
      () => h.takedown.escalate(f.qc.ctx, f.qc.staff, task.id, {}),
      () => h.takedown.sendBreachNotice(f.qc.ctx, f.qc.staff, task.id),
    ])
      await expect(write()).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    await expect(h.takedown.get(f.qc.staff, task.id)).rejects.toMatchObject({ error: "NOT_FOUND" });
    const list = await h.takedown.list(f.qc.staff, {
      orderItemId: f.item.id,
      tab: "waiting",
      page: 1,
      pageSize: 20,
    });
    expect(list.items.map((item) => item.takedownTaskId)).toEqual([current.id]);
    const merchantList = await h.takedown.merchantList(f.o.viewer, {
      tab: "pending",
      orderId: f.o.order.id,
      limit: 20,
    });
    expect(merchantList.items.map((item) => item.takedownTaskId)).toEqual([current.id]);
    for (const write of [
      () => h.takedown.confirm(outsider, task.id, { method: "not_published" }),
      () => h.takedown.check(stranger.ctx, scoped, task.id, oldBody),
      () => h.takedown.batchCheck(stranger.ctx, scoped, { items: [currentItem, oldItem] }),
      () => h.takedown.markOnline(stranger.ctx, scoped, task.id, {}),
      () => h.takedown.escalate(stranger.ctx, scoped, task.id, {}),
      () => h.takedown.sendBreachNotice(stranger.ctx, scoped, task.id),
      () => h.takedown.get(scoped, task.id),
    ])
      await expect(write()).rejects.toMatchObject({ error: "NOT_FOUND" });
    expect(await snapshot()).toEqual(before);
  });
});
