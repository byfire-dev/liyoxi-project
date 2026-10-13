import { afterAll, expect, it } from "vitest";
import { FollowUpListQuerySchema } from "@liyoxi/contract";
import type { PrismaClient } from "@liyoxi/db";
import { createIdentityContext, createIdempotencyContext, uuidv7 } from "../kernel/index.js";
import type { Tx, TxRunOptions, TxRunner } from "../kernel/index.js";
import {
  fullStaffWorld,
  notificationFixture,
  sampleStaffContext,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import type { FullStaffWorld } from "../testing/index.js";
import { createStaffFollowUps } from "./follow-ups.js";

const db = useSeededDatabase("services", { max: 2, label: "followups" });
const worlds: FullStaffWorld[] = [];
afterAll(async () => {
  for (const w of worlds) await w.scope.close();
});
async function world() {
  const w = await fullStaffWorld(await db.prisma());
  worlds.push(w);
  return { ...w, followUps: createStaffFollowUps(w) };
}
type World = Awaited<ReturnType<typeof world>>;
async function actor(prisma: PrismaClient, id: string) {
  return {
    ctx: await sampleStaffContext(prisma, id),
    identity: createIdentityContext({ actor: { type: "staff", id, client: "admin" } }),
  };
}
const next = (w: { clock: { now(): Date } }, ms = 60000) =>
  new Date(w.clock.now().getTime() + ms).toISOString();
const query = (raw: unknown) => FollowUpListQuerySchema.parse(raw);
const tables = ["follow_up", "audit_log", "outbox_event", "timer"];
const error = (promise: Promise<unknown>, symbol: string) =>
  expect(promise).rejects.toMatchObject({ error: symbol });
async function graph(w: World, managerId?: string) {
  const own = await w.make.subscribedMerchant();
  if (managerId)
    await w.prisma.store.update({
      where: { id: own.store.id },
      data: { deliveryManagerId: managerId },
    });
  const order = await w.make.dramaOrder({
    entityId: own.entity.id,
    storeId: own.store.id,
    subscriptionTermId: own.term.id,
  });
  const item = await w.make.orderItem({ dramaOrderId: order.id });
  return { ...own, order, item };
}
const input = (id: string, at?: string) => ({
  subjectType: "order_item",
  subjectId: id,
  content: "虚构沟通记录",
  ...(at ? { nextFollowAt: at } : {}),
});
const idem = (
  who: ReturnType<typeof createIdentityContext>,
  scope: string,
  body: unknown,
  key: string,
  id?: string,
) => ({
  idem: createIdempotencyContext({
    mode: "required",
    scope,
    actor: who.actor,
    key,
    request: { method: "POST", body, ...(id ? { pathParams: { followUpId: id } } : {}) },
  }),
});

it("真实对象归属/当前模块与own范围；主体查询只含可见店和主体续费，稳定分页GET零写", async () => {
  const w = await world(),
    manager = await w.person("delivery_manager", false),
    who = await actor(w.prisma, manager.id),
    g = await graph(w, manager.id);
  const first = await w.followUps.create(who.ctx, who.identity, input(g.item.id, next(w)));
  const term = await w.followUps.create(who.ctx, who.identity, {
    subjectType: "subscription_term",
    subjectId: g.term.id,
    content: "续费意向",
    intent: "considering",
  });
  expect(first).toMatchObject({
    entityId: g.entity.id,
    storeId: g.store.id,
    owner: { staffId: manager.id },
    recorder: { actorType: "staff", staff: { staffId: manager.id } },
    actions: ["update", "complete"],
  });
  expect(term).toMatchObject({
    entityId: g.entity.id,
    storeId: null,
    intent: "considering",
    isOpen: false,
    actions: [],
  });
  const sibling = await w.make.store({ entityId: g.entity.id, isPrimary: false });
  const foreignOrder = await w.make.dramaOrder({
    entityId: g.entity.id,
    storeId: sibling.id,
    subscriptionTermId: g.term.id,
  });
  const foreign = await w.make.orderItem({ dramaOrderId: foreignOrder.id });
  await w.followUps.create(w.ctx, w.actor, input(foreign.id, next(w)));
  const before = await snapshotTables(w.prisma, tables);
  const page1 = await w.followUps.list(who.ctx, query({ entityId: g.entity.id, pageSize: 1 }));
  const page2 = await w.followUps.list(
    who.ctx,
    query({ entityId: g.entity.id, pageSize: 1, page: 2 }),
  );
  expect(page1.total).toBe(2);
  expect(page2.total).toBe(2);
  expect(new Set([...page1.items, ...page2.items].map((r) => r.followUpId))).toEqual(
    new Set([first.followUpId, term.followUpId]),
  );
  expect(
    (await w.followUps.list(who.ctx, query({ mine: "true", isOpen: "true" }))).items.map(
      (r) => r.followUpId,
    ),
  ).toEqual([first.followUpId]);
  expect(
    (await w.followUps.list(who.ctx, query({ entityId: g.entity.id, isOpen: "false" }))).items.map(
      (r) => r.followUpId,
    ),
  ).toEqual([term.followUpId]);
  await error(
    w.followUps.list(who.ctx, query({ subjectType: "order_item", subjectId: foreign.id })),
    "NOT_FOUND",
  );
  await error(w.followUps.create(who.ctx, who.identity, input(foreign.id)), "NOT_FOUND");
  const editor = await actor(w.prisma, (await w.person("editor", false)).id);
  await error(
    w.followUps.list(editor.ctx, query({ subjectType: "subscription_term", subjectId: g.term.id })),
    "PERMISSION_DENIED",
  );
  await w.prisma.staff.update({
    where: { id: manager.id },
    data: { staffRoleKey: "editor", staffGroupId: null },
  });
  await error(
    w.followUps.list(who.ctx, query({ subjectType: "order_item", subjectId: g.item.id })),
    "PERMISSION_DENIED",
  );
  expect(await snapshotTables(w.prisma, tables)).toEqual(before);
});

it("双客户端同对象create仅留一个open，逾期旧待办原子关闭且不误关别的对象；末审计后失败全部回滚", async () => {
  const w = await world(),
    g = await graph(w),
    otherItem = await w.make.orderItem({ dramaOrderId: g.order.id, itemNo: 2 });
  await w.prisma.dramaOrder.update({
    where: { id: g.order.id },
    data: { itemCount: 2, totalChargePoints: 200 },
  });
  const old = await w.followUps.create(w.ctx, w.actor, input(g.item.id, next(w)));
  await w.prisma.followUp.update({
    where: { id: old.followUpId },
    data: { nextFollowAt: new Date(w.clock.now().getTime() - 1000) },
  });
  const untouched = await w.followUps.create(w.ctx, w.actor, input(otherItem.id, next(w)));
  const peer = await actor(w.prisma, (await w.person("cs", false)).id),
    before = await snapshotTables(w.prisma, ["outbox_event", "timer"]);
  const pair = await Promise.all([
    w.followUps.create(w.ctx, w.actor, input(g.item.id, next(w))),
    w.followUps.create(peer.ctx, peer.identity, input(g.item.id, next(w))),
  ]);
  const rows = await w.prisma.followUp.findMany({
    where: { subjectType: "order_item", subjectId: g.item.id },
  });
  expect(rows).toHaveLength(3);
  expect(rows.filter((r) => r.nextFollowAt !== null && r.doneAt === null)).toHaveLength(1);
  expect(rows.find((r) => r.id === old.followUpId)).toMatchObject({
    doneAt: w.clock.now(),
    lockVersion: 1,
  });
  expect(pair.map((r) => r.followUpId)).toEqual(
    expect.arrayContaining(rows.filter((r) => r.id !== old.followUpId).map((r) => r.id)),
  );
  expect(
    await w.prisma.followUp.findUniqueOrThrow({ where: { id: untouched.followUpId } }),
  ).toMatchObject({ doneAt: null, lockVersion: 0 });
  expect(
    await w.prisma.auditLog.count({
      where: {
        targetType: "follow_up",
        targetId: { in: rows.map((r) => r.id) },
        stream: "activity",
        category: "follow_up",
        action: "staff.follow_up.create",
      },
    }),
  ).toBe(3);
  expect(await snapshotTables(w.prisma, ["outbox_event", "timer"])).toEqual(before);
  const fault: TxRunner = {
    run<T>(fn: (tx: Tx) => Promise<T>, options?: TxRunOptions) {
      return w.tx.run(async (tx) => {
        const result = await fn(tx);
        if (typeof result === "object" && result !== null && "followUpId" in result)
          throw new Error("虚构末审计后故障");
        return result;
      }, options);
    },
  };
  const frozen = await snapshotTables(w.prisma, tables),
    failing = createStaffFollowUps({ ...w, tx: fault });
  await expect(failing.create(w.ctx, w.actor, input(g.item.id, next(w)))).rejects.toThrow(
    "末审计后故障",
  );
  expect(await snapshotTables(w.prisma, tables)).toEqual(frozen);
});

it("本人/同组主管/all与实际scope，update/complete只一CAS赢家；真实禁用移交递增版本、幂等与撤权", async () => {
  const w = await world(),
    g = await graph(w),
    from = await w.person("publisher", false),
    to = await w.person("publisher", false),
    lead = await w.person("publisher", true);
  const fromActor = await actor(w.prisma, from.id),
    toActor = await actor(w.prisma, to.id),
    leadActor = await actor(w.prisma, lead.id);
  await w.make.deliveryTicket({ orderItemId: g.item.id, publisherId: from.id });
  const otherItem = await w.make.orderItem({ dramaOrderId: g.order.id, itemNo: 2 });
  await w.prisma.dramaOrder.update({
    where: { id: g.order.id },
    data: { itemCount: 2, totalChargePoints: 200 },
  });
  await w.make.deliveryTicket({ orderItemId: otherItem.id, publisherId: to.id });
  const row = await w.followUps.create(
    fromActor.ctx,
    fromActor.identity,
    input(g.item.id, next(w)),
  );
  await error(
    w.followUps.update(toActor.ctx, toActor.identity, row.followUpId, {
      lockVersion: 0,
      nextFollowAt: next(w, 120000),
    }),
    "PERMISSION_DENIED",
  );
  const edited = await w.followUps.update(leadActor.ctx, leadActor.identity, row.followUpId, {
    lockVersion: 0,
    nextFollowAt: next(w, 120000),
  });
  expect(edited.lockVersion).toBe(1);
  const all = await w.followUps.update(w.ctx, w.actor, row.followUpId, {
    lockVersion: 1,
    nextFollowAt: next(w, 180000),
  });
  expect(all.lockVersion).toBe(2);
  const race = await Promise.allSettled([
    w.followUps.update(fromActor.ctx, fromActor.identity, row.followUpId, {
      lockVersion: 2,
      nextFollowAt: next(w, 240000),
    }),
    w.followUps.complete(fromActor.ctx, fromActor.identity, row.followUpId, {
      lockVersion: 2,
      doneNote: "已沟通",
    }),
  ]);
  expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(race.find((r) => r.status === "rejected")).toMatchObject({
    reason: { error: "VERSION_CONFLICT" },
  });
  const payload = input(g.item.id, next(w)),
    createKey = uuidv7();
  const current = await w.followUps.create(
    fromActor.ctx,
    fromActor.identity,
    payload,
    idem(fromActor.identity, "admin.followUp.create", payload, createKey),
  );
  expect(
    await w.followUps.create(
      fromActor.ctx,
      fromActor.identity,
      payload,
      idem(fromActor.identity, "admin.followUp.create", payload, createKey),
    ),
  ).toEqual(current);
  const count = (await w.service.openWork(w.ctx, from.id)).total;
  await w.service.disable(w.ctx, w.actor, from.id, {
    reason: "resigned",
    handoverToStaffId: to.id,
    confirm: { staffNo: from.staffNo, openWorkCount: count },
  });
  const moved = await w.prisma.followUp.findUniqueOrThrow({ where: { id: current.followUpId } });
  expect(moved).toMatchObject({ ownerStaffId: to.id, actorId: from.id, lockVersion: 1 });
  expect(
    await w.prisma.assignmentHistory.count({
      where: {
        subjectType: "follow_up",
        subjectId: moved.id,
        fromStaffId: from.id,
        toStaffId: to.id,
      },
    }),
  ).toBe(1);
  await error(
    w.followUps.create(
      fromActor.ctx,
      fromActor.identity,
      payload,
      idem(fromActor.identity, "admin.followUp.create", payload, createKey),
    ),
    "PERMISSION_DENIED",
  );
  await error(
    w.followUps.complete(w.ctx, w.actor, moved.id, { lockVersion: 0 }),
    "VERSION_CONFLICT",
  );
  const body = { lockVersion: 1, doneNote: "移交后完成" },
    key = uuidv7();
  const done = await w.followUps.complete(
    toActor.ctx,
    toActor.identity,
    moved.id,
    body,
    idem(toActor.identity, "admin.followUp.complete", body, key, moved.id),
  );
  expect(done).toMatchObject({
    isOpen: false,
    lockVersion: 2,
    owner: { staffId: to.id },
    recorder: { staff: { staffId: from.id } },
    actions: [],
  });
  expect(
    await w.followUps.complete(
      toActor.ctx,
      toActor.identity,
      moved.id,
      body,
      idem(toActor.identity, "admin.followUp.complete", body, key, moved.id),
    ),
  ).toEqual(done);
  expect(
    await w.prisma.auditLog.count({
      where: { targetId: moved.id, action: "staff.follow_up.complete" },
    }),
  ).toBe(1);
  await error(
    w.followUps.update(toActor.ctx, toActor.identity, moved.id, {
      lockVersion: 2,
      nextFollowAt: next(w),
    }),
    "STATE_NOT_ALLOWED",
  );
});

it("V1/内容/意向/时间严格零写，system不能清期；真实人工记录进入09:00提醒，改期/完成自然退出", async () => {
  const h = notificationFixture(await db.prisma());
  try {
    h.clock.set(new Date("2026-10-08T00:59:58.000Z"));
    const own = await h.make.subscribedMerchant(),
      user = await h.make.staff({ staffRoleKey: "super_admin" }),
      who = await actor(h.prisma, user.id);
    const service = createStaffFollowUps({ tx: h.tx, clock: h.clock, assembly: h.deps.assembly });
    const valid = {
      subjectType: "subscription_term",
      subjectId: own.term.id,
      content: "人工续费沟通",
      nextFollowAt: "2026-10-08T06:00:00.000Z",
    };
    const before = await snapshotTables(h.prisma, tables);
    for (const bad of [
      { ...valid, subjectType: "store", subjectId: own.store.id },
      { ...valid, channel: "system" },
      { ...valid, content: " " },
      { ...valid, content: "字".repeat(201) },
      { ...valid, ownerStaffId: user.id },
      { ...valid, nextFollowAt: h.clock.now().toISOString() },
      { ...valid, nextFollowAt: "invalid" },
      { ...valid, subjectType: "order_item", intent: "confirmed" },
    ])
      await error(service.create(who.ctx, who.identity, bad), "VALIDATION_FAILED");
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
    const row = await service.create(who.ctx, who.identity, valid);
    expect(await snapshotTables(h.prisma, ["outbox_event", "timer"])).toEqual({
      outbox_event: before.outbox_event,
      timer: before.timer,
    });
    await h.service.remindScan({ scheduledFor: h.clock.now() });
    expect(await h.prisma.notification.count({ where: { bizId: row.followUpId } })).toBe(0);
    h.clock.advance(2000);
    await h.service.remindScan({ scheduledFor: h.clock.now() });
    await h.service.remindScan({ scheduledFor: h.clock.now() });
    expect(
      await h.prisma.notification.count({ where: { bizId: row.followUpId, staffId: user.id } }),
    ).toBe(1);
    await service.update(who.ctx, who.identity, row.followUpId, {
      lockVersion: 0,
      nextFollowAt: "2026-10-09T01:00:00.000Z",
    });
    await h.service.remindScan({ scheduledFor: h.clock.now() });
    expect(await h.prisma.notification.count({ where: { bizId: row.followUpId } })).toBe(1);
    const system = await h.prisma.followUp.create({
      data: {
        id: uuidv7(),
        subjectType: "subscription_term",
        subjectId: own.term.id,
        entityId: own.entity.id,
        channel: "system",
        actorType: "system",
        content: "系统待办",
        ownerStaffId: user.id,
        nextFollowAt: new Date("2026-10-09T01:00:00.000Z"),
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const unchanged = await snapshotTables(h.prisma, tables);
    await error(
      service.update(who.ctx, who.identity, system.id, { lockVersion: 0, nextFollowAt: null }),
      "VALIDATION_FAILED",
    );
    await error(
      service.update(who.ctx, who.identity, row.followUpId, {
        lockVersion: 1,
        nextFollowAt: "2026-10-08T00:00:00.000Z",
      }),
      "VALIDATION_FAILED",
    );
    await error(
      service.complete(who.ctx, who.identity, system.id, {
        lockVersion: 0,
        doneNote: "字".repeat(201),
      }),
      "VALIDATION_FAILED",
    );
    expect(await snapshotTables(h.prisma, tables)).toEqual(unchanged);
    await service.complete(who.ctx, who.identity, row.followUpId, { lockVersion: 1, doneNote: "" });
    h.clock.set(new Date("2026-10-09T01:00:00.000Z"));
    await h.service.remindScan({ scheduledFor: h.clock.now() });
    expect(await h.prisma.notification.count({ where: { bizId: row.followUpId } })).toBe(1);
    expect(FollowUpListQuerySchema.safeParse({ mine: "false" }).success).toBe(false);
    expect(FollowUpListQuerySchema.safeParse({ subjectType: "subscription_term" }).success).toBe(
      false,
    );
  } finally {
    await h.service.close();
  }
});
