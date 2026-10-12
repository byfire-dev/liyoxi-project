import type { Prisma, PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dispatchDue } from "../events/index.js";
import { merchantFactsPort, notifyReadOf, notifyReadPort, uuidv7 } from "../kernel/index.js";
import type { KeyedPort } from "../kernel/index.js";
import { assembleForTest, openTerm, useSeededDatabase } from "../testing/index.js";
import {
  createRuntimeTenantEntitlement,
  createTenantEntitlementAssembly,
} from "./tenant-entitlement-runtime.js";
import {
  entitlementHarness,
  removeOwner,
  transferOwner,
  SCENE,
  SLOW,
  SUBSCRIBER,
} from "./__fixtures__/tenant-entitlement.js";
import type {
  Change,
  EntitlementHarness,
  EntitlementRuntime,
  EntitlementWorld,
} from "./__fixtures__/tenant-entitlement.js";

const db = useSeededDatabase("services", { label: "entitlement" });
let prisma: PrismaClient, h: EntitlementHarness, r: EntitlementRuntime;
beforeAll(async () => {
  prisma = await db.prisma();
  h = entitlementHarness(prisma);
  r = h.runtime();
}, SLOW);
beforeEach(async () => {
  await h.quietTransport();
}, SLOW);
afterAll(async () => {
  await h?.close();
});

async function delivered(w: EntitlementWorld, runtime = r) {
  const ref = await runtime.queue(w.event.id);
  expect(await runtime.consume(ref)).toBe("done");
  return { ref, ...(await h.evidence(w.event.id)) };
}
async function none(w: EntitlementWorld) {
  expect(await r.read(w.event.id)).toBeNull();
  const got = await delivered(w);
  expect(got.notifications).toEqual([]);
  expect(got.messages).toEqual([]);
  expect(got.deliveries).toEqual([]);
}

describe("权益变动：真实账本出站与当前额度/老板", () => {
  it.each(["expired", "rolled_over"] as const)(
    "tenant.onEntitlementChanged：%s 经真实 advance/expand/dispatch/consume 原子写唯一老板站内提醒",
    async (change) => {
      const w = await h.world({ change });
      const expected =
        change === "expired" ? { storesOver: 2, seatsOver: 1 } : { storesOver: 1, seatsOver: 2 };
      expect(w.row).toMatchObject({
        eventType: `billing.subscription.${change}`,
        entityId: w.entity.id,
        storeId: null,
        aggregateType: "subscription_term",
        aggregateId: w.next?.term.id ?? w.first.term.id,
        actorType: "system",
        actorId: null,
      });
      expect(r.events.subscribers.forEvent(w.event.type).map((entry) => entry.name)).toEqual([
        SUBSCRIBER,
      ]);
      const before = await prisma.entity.findUniqueOrThrow({ where: { id: w.entity.id } });
      const got = await delivered(w);
      expect(got.notifications).toHaveLength(1);
      expect(got.notifications[0]).toMatchObject({
        notifySceneKey: SCENE,
        sourceOutboxEventId: w.event.id,
        dedupeKey: `${SCENE}:${w.event.id}:${w.user.id}`,
        node: "N0",
        bizType: "entity",
        bizId: w.entity.id,
        merchantUserId: w.user.id,
        entityId: w.entity.id,
        storeId: null,
        createdAt: h.clock.now(),
        vars: {
          sourceId: w.event.id,
          sourceType: w.event.type,
          entityId: w.entity.id,
          merchantUserId: w.user.id,
          ...expected,
        },
      });
      expect(got.messages).toHaveLength(1);
      expect(got.messages[0]).toMatchObject({
        notificationId: got.notifications[0]!.id,
        merchantUserId: w.user.id,
        entityId: w.entity.id,
        storeId: null,
        isOwnerOnly: true,
        category: "store",
        title: "名额超限提醒",
        ctaText: "查看套餐",
        link: { route: "wallet.home", params: {} },
        readAt: null,
        createdAt: h.clock.now(),
        body: `名额已超出当前上限，请停用${expected.storesOver}家门店、减少${expected.seatsOver}个店员或待接受邀请名额。`,
      });
      expect(got.deliveries).toHaveLength(1);
      expect(got.deliveries[0]).toMatchObject({
        notificationId: got.notifications[0]!.id,
        channel: "inbox",
        status: "sent",
        origin: "primary",
        dueAt: h.clock.now(),
        sentAt: h.clock.now(),
        finishedAt: h.clock.now(),
        smsTemplateKey: null,
      });
      expect(
        await prisma.notifyScene.findUniqueOrThrow({ where: { sceneKey: SCENE } }),
      ).toMatchObject({
        sceneEnabled: true,
        audience: "merchant",
        sendWindow: "immediate",
        smsPolicy: "never",
        smsTemplateKey: null,
        wxTemplateSlotKey: null,
        collapseWindowSec: 0,
      });
      expect(await prisma.entity.findUniqueOrThrow({ where: { id: w.entity.id } })).toEqual(before);
      expect(
        await prisma.entityMember.count({ where: { entityId: w.entity.id, status: "active" } }),
      ).toBe(4);
      expect(
        await prisma.outboxDelivery.findUniqueOrThrow({
          where: {
            outboxEventId_subscriber: { outboxEventId: w.event.id, subscriber: SUBSCRIBER },
          },
        }),
      ).toMatchObject({ status: "done", attempts: 0, dispatchNo: 1 });
      expect(await runtimeNotificationOwners(w)).toEqual([w.user.id]);
      expect(h.providers.sms.calls).toEqual([]);
      expect(h.providers.wechat.calls).toEqual([]);
    },
    SLOW,
  );

  it.each([
    {
      name: "inactive defaults",
      change: "expired",
      stores: 3,
      clerks: 3,
      pending: 1,
      storesOver: 2,
      seatsOver: 1,
    },
    {
      name: "plan snapshot",
      change: "rolled_over",
      stores: 3,
      clerks: 3,
      pending: 1,
      storesOver: 1,
      seatsOver: 2,
    },
    {
      name: "plan null unlimited",
      change: "rolled_over",
      stores: 3,
      clerks: 6,
      pending: 1,
      maxMembers: null,
      storesOver: 1,
      seatsOver: 0,
    },
    {
      name: "store override",
      change: "rolled_over",
      stores: 3,
      clerks: 1,
      pending: 0,
      storeOverride: 1,
      storesOver: 2,
      seatsOver: 0,
    },
    {
      name: "member zero override",
      change: "rolled_over",
      stores: 1,
      clerks: 1,
      pending: 1,
      memberOverride: 0,
      storesOver: 0,
      seatsOver: 2,
    },
    {
      name: "override inactive defaults",
      change: "expired",
      stores: 3,
      clerks: 3,
      pending: 1,
      storeOverride: 2,
      memberOverride: 5,
      storesOver: 1,
      seatsOver: 0,
    },
    {
      name: "exact default boundary",
      change: "expired",
      stores: 1,
      clerks: 2,
      pending: 1,
      storesOver: 0,
      seatsOver: 0,
    },
    {
      name: "exact plan boundary",
      change: "rolled_over",
      stores: 2,
      clerks: 1,
      pending: 1,
      storesOver: 0,
      seatsOver: 0,
    },
    {
      name: "override larger than use",
      change: "expired",
      stores: 3,
      clerks: 3,
      pending: 1,
      storeOverride: 8,
      memberOverride: 8,
      storesOver: 0,
      seatsOver: 0,
    },
  ] as const)(
    "唯一当前额度公式：$name",
    async (c) => {
      const w = await h.world({ ...c, change: c.change as Change });
      await prisma.entity.update({
        where: { id: w.entity.id },
        data: {
          storeLimitOverride: "storeOverride" in c ? c.storeOverride : null,
          memberLimitOverride: "memberOverride" in c ? c.memberOverride : null,
        },
      });
      const got = await delivered(w);
      if (c.storesOver === 0 && c.seatsOver === 0) {
        expect(got.notifications).toEqual([]);
        expect(got.messages).toEqual([]);
        expect(got.deliveries).toEqual([]);
      } else {
        expect(got.notifications).toHaveLength(1);
        expect(got.notifications[0]!.vars).toMatchObject({
          storesOver: c.storesOver,
          seatsOver: c.seatsOver,
        });
        expect(got.messages).toHaveLength(1);
        expect(got.messages[0]!.body.includes("停用")).toBe(c.storesOver > 0);
        expect(got.messages[0]!.body.includes("减少")).toBe(c.seatsOver > 0);
        expect(got.messages[0]!.body).not.toContain("停用0");
        expect(got.messages[0]!.body).not.toContain("减少0");
      }
    },
    SLOW,
  );

  it(
    "老板不占席位，removed/停用门店/已过期邀请及恰好到期邀请均不占当前用量",
    async () => {
      const w = await h.world({ stores: 1, clerks: 2, pending: 1 });
      const old = await h.make.entityMember({ entityId: w.entity.id });
      await prisma.entityMember.update({
        where: { id: old.id },
        data: {
          status: "removed",
          removedAt: h.clock.now(),
          removeReason: "by_owner",
          removeActorType: "system",
          removeActorId: null,
        },
      });
      await h.make.store({
        entityId: w.entity.id,
        lifecycle: "archived",
        archiveReason: "by_owner",
        archivedAt: h.clock.now(),
        archiveActorType: "system",
      });
      await h.invitation(w, new Date(h.clock.now().getTime() - 1));
      await h.invitation(w, h.clock.now());
      await none(w);
    },
    SLOW,
  );

  it(
    "晚到的过期事件读取后来重新开通套餐，当前未超额即不发",
    async () => {
      const w = await h.world();
      const resumed = await openTerm(h, { entityId: w.entity.id });
      await prisma.subscriptionTerm.update({
        where: { id: resumed.term.id },
        data: { maxStores: 8, maxMembers: null },
      });
      await none(w);
    },
    SLOW,
  );

  it(
    "晚到的接续事件不沿旧快照放宽，当前周期已到期则使用默认1/3",
    async () => {
      const w = await h.world({
        change: "rolled_over",
        maxStores: 8,
        maxMembers: null,
        pending: 0,
        clerks: 4,
      });
      h.clock.set(w.next!.term.endsAt);
      // 不再 advance 也已不生效；读时公式不能只信 active 缓存。
      const got = await delivered(w);
      expect(got.notifications).toHaveLength(1);
      expect(got.notifications[0]!.vars).toMatchObject({ storesOver: 2, seatsOver: 1 });
    },
    SLOW,
  );

  it(
    "事件发出后老板移交，只给此刻有效owner，不给创建人/原老板/普通店员/其他主体",
    async () => {
      const w = await h.world();
      const replacement = w.clerks[0]!;
      const outsider = await h.make.merchant();
      await h.tx.run((tx) => transferOwner(tx, w, replacement.id, h.clock.now()));
      const got = await delivered(w);
      expect(got.notifications.map((row) => row.merchantUserId)).toEqual([
        replacement.merchantUserId,
      ]);
      expect(got.messages.map((row) => row.merchantUserId)).toEqual([replacement.merchantUserId]);
      expect(got.notifications[0]!.vars).toMatchObject({
        merchantUserId: replacement.merchantUserId,
        seatsOver: 0,
      });
      expect(
        await prisma.merchantMessage.count({
          where: {
            notificationId: { in: got.notifications.map((row) => row.id) },
            merchantUserId: { in: [w.user.id, outsider.user.id, w.clerks[1]!.merchantUserId] },
          },
        }),
      ).toBe(0);
    },
    SLOW,
  );

  it.each(["closed", "abandoned", "removed", "disabled", "deleted"] as const)(
    "当前%s不可接收权益提醒",
    async (state) => {
      const w = await h.world();
      if (state === "closed" || state === "abandoned")
        await prisma.entity.update({
          where: { id: w.entity.id },
          data: { lifecycle: state, closedAt: h.clock.now() },
        });
      else if (state === "removed") await h.tx.run((tx) => removeOwner(tx, w, h.clock.now()));
      else if (state === "disabled")
        await prisma.merchantUser.update({
          where: { id: w.user.id },
          data: { status: "disabled" },
        });
      else
        await prisma.merchantUser.update({
          where: { id: w.user.id },
          data: {
            status: "deleted",
            deletedAt: h.clock.now(),
            phoneEnc: null,
            phoneBidx: null,
            phoneMask: null,
            phoneLast4: null,
            displayName: null,
          },
        });
      await none(w);
    },
    SLOW,
  );
});

async function runtimeNotificationOwners(w: EntitlementWorld) {
  return (await h.evidence(w.event.id)).notifications.map((row) => row.merchantUserId);
}

describe("持久化来源、重放与事务", () => {
  it.each(["id", "type", "entity", "term", "extra", "endedAt"] as const)(
    "delivered %s伪造不能直接或通过专用notify入口写提醒",
    async (field) => {
      const w = await h.world();
      const event: { id: string; type: string; payload: Record<string, unknown> } = {
        ...w.event,
        payload: { ...w.event.payload },
        ...(field === "id" ? { id: uuidv7() } : {}),
        ...(field === "type"
          ? {
              type: "billing.subscription.rolled_over",
              payload: { v: 1, termId: w.first.term.id, prevTermId: null, entityId: w.entity.id },
            }
          : {}),
      };
      if (field === "entity") event.payload = { ...event.payload, entityId: uuidv7() };
      if (field === "term") event.payload = { ...event.payload, termId: uuidv7() };
      if (field === "extra") event.payload = { ...event.payload, merchantUserId: w.user.id };
      if (field === "endedAt")
        event.payload = { ...event.payload, endedAt: "2027-01-01T00:00:00.000Z" };
      const before = await h.snapshot();
      await expect(r.handle(event)).rejects.toThrow();
      await expect(h.tx.run((tx) => r.notify.sendQuotaExceeded(tx, event))).rejects.toThrow();
      expect(await h.snapshot()).toEqual(before);
    },
    SLOW,
  );

  it.each([
    "entity",
    "store",
    "aggregateType",
    "aggregateId",
    "actor",
    "foreignTerm",
    "foreignPrev",
    "unknownField",
  ] as const)(
    "持久源%s不符不能借当前有效配额投递",
    async (field) => {
      const w = await h.world({ change: field === "foreignPrev" ? "rolled_over" : "expired" });
      const foreign = await h.make.merchant();
      const foreignTerm = await openTerm(h, { entityId: foreign.entity.id });
      let payload = { ...w.event.payload };
      const data =
        field === "entity"
          ? { entityId: foreign.entity.id }
          : field === "store"
            ? { storeId: w.store.id }
            : field === "aggregateType"
              ? { aggregateType: "entity" }
              : field === "aggregateId"
                ? { aggregateId: foreign.entity.id }
                : field === "actor"
                  ? { actorType: "merchant", actorId: w.user.id }
                  : field === "foreignTerm"
                    ? { aggregateId: foreignTerm.term.id }
                    : {};
      if (field === "foreignTerm") payload = { ...payload, termId: foreignTerm.term.id };
      if (field === "foreignPrev") payload = { ...payload, prevTermId: foreignTerm.term.id };
      if (field === "unknownField") payload = { ...payload, storesOver: 99 };
      // The producer's immutable source stays intact. Insert a distinct counterfeit envelope.
      const { seq: _seq, id: _id, payload: _payload, ...envelope } = w.row;
      const counterfeit = await prisma.outboxEvent.create({
        data: {
          ...envelope,
          ...data,
          id: uuidv7(),
          dedupeKey: null,
          payload: payload as Prisma.InputJsonObject,
        },
      });
      const forged = { ...w.event, id: counterfeit.id, payload };
      const before = await h.snapshot();
      await expect(r.handle(forged)).rejects.toThrow();
      if (field === "unknownField") await expect(r.read(counterfeit.id)).rejects.toThrow();
      else expect(await r.read(counterfeit.id)).toBeNull();
      expect(await h.snapshot()).toEqual(before);
      expect(await h.evidence(counterfeit.id)).toEqual({
        notifications: [],
        messages: [],
        deliveries: [],
      });
    },
    SLOW,
  );

  it(
    "同event反复消费/直接重放只一次，不同真实账本事件各一次",
    async () => {
      const w = await h.world({ pending: 0, clerks: 4 });
      const got = await delivered(w);
      const once = await h.snapshot();
      expect(await r.consume(got.ref)).toBe("stale");
      await r.handle(w.event);
      await r.handle(w.event);
      expect(await h.snapshot()).toEqual(once);
      const resumed = await openTerm(h, { entityId: w.entity.id });
      h.clock.set(resumed.term.endsAt);
      await h.tx.run((tx) => h.ledger.advance(tx, w.entity.id));
      const row = await prisma.outboxEvent.findFirstOrThrow({
        where: {
          entityId: w.entity.id,
          eventType: "billing.subscription.expired",
          id: { not: w.event.id },
        },
      });
      const ref = await r.queue(row.id);
      expect(await r.consume(ref)).toBe("done");
      const both = await prisma.notification.findMany({
        where: { entityId: w.entity.id, notifySceneKey: SCENE },
      });
      expect(both).toHaveLength(2);
      expect(new Set(both.map((entry) => entry.sourceOutboxEventId))).toEqual(
        new Set([row.id, w.event.id]),
      );
      expect(
        await prisma.merchantMessage.count({
          where: { notificationId: { in: both.map((entry) => entry.id) } },
        }),
      ).toBe(2);
    },
    SLOW,
  );

  it(
    "实际notification/message/inbox写后失败连同consume done全回滚，原事件保留且真实重试恢复一次",
    async () => {
      const w = await h.world();
      let fail = true;
      const faulty = h.runtime(h.tx, {
        afterNotify: async (_tx, event, count) => {
          if (fail && event.id === w.event.id) {
            expect(count).toBe(1);
            fail = false;
            throw new Error("entitlement-tail-failure");
          }
        },
      });
      const ref = await faulty.queue(w.event.id);
      const before = await h.snapshot();
      expect(await faulty.consume(ref)).toBe("retry");
      expect(await h.snapshot()).toEqual(before);
      expect(
        await prisma.outboxDelivery.findUniqueOrThrow({
          where: {
            outboxEventId_subscriber: { outboxEventId: w.event.id, subscriber: SUBSCRIBER },
          },
        }),
      ).toMatchObject({
        status: "retry",
        attempts: 1,
        lastError: "Error: entitlement-tail-failure",
        consumedAt: null,
      });
      await prisma.$executeRawUnsafe(
        "UPDATE outbox_delivery SET next_attempt_at=now()-interval '1 second' WHERE outbox_event_id=$1::uuid AND subscriber=$2",
        w.event.id,
        SUBSCRIBER,
      );
      faulty.refs.length = 0;
      await dispatchDue(faulty.dispatch);
      const retry = faulty.refs.find((entry) => entry.eventId === w.event.id)!;
      expect(retry.dispatchNo).toBe(ref.dispatchNo + 1);
      expect(await faulty.consume(retry)).toBe("done");
      expect((await h.evidence(w.event.id)).notifications).toHaveLength(1);
      expect((await h.evidence(w.event.id)).messages).toHaveLength(1);
      expect((await h.evidence(w.event.id)).deliveries).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "场景关闭只停提醒，已消费仍完成且不改主体配额/成员",
    async () => {
      const w = await h.world();
      await prisma.notifyScene.update({
        where: { sceneKey: SCENE },
        data: { sceneEnabled: false },
      });
      try {
        const got = await delivered(w);
        expect(got.notifications).toEqual([]);
        expect(got.messages).toEqual([]);
        expect(
          await prisma.store.count({ where: { entityId: w.entity.id, lifecycle: "active" } }),
        ).toBe(3);
        expect(
          await prisma.entityMember.count({ where: { entityId: w.entity.id, status: "active" } }),
        ).toBe(4);
      } finally {
        await prisma.notifyScene.update({
          where: { sceneKey: SCENE },
          data: { sceneEnabled: true },
        });
      }
    },
    SLOW,
  );
});

describe("scoped subscriber + 所属reader装配", () => {
  it(
    "两个真实runtime共享base仍各用其clock/服务，lookup同数组，关一不串另一",
    async () => {
      const base = assembleForTest({ entry: "worker" });
      const other = entitlementHarness(prisma);
      const a = h.runtime(h.tx, { base }),
        b = other.runtime(other.tx, { base });
      try {
        const one = await h.world(),
          two = await other.world();
        other.clock.advance(60_000);
        for (const scoped of [a, b]) {
          expect(scoped.assembly.subscriber(SUBSCRIBER)).toBe(
            scoped.assembly.subscribers.find((entry) => entry.name === SUBSCRIBER),
          );
          expect(scoped.assembly.subscriber(SUBSCRIBER)).not.toBe(base.subscriber(SUBSCRIBER));
        }
        expect(notifyReadOf(a.assembly).has("termForNotify")).toBe(true);
        for (const [key, reader] of base.portEntries(notifyReadPort))
          if (key !== "tenantQuotaForNotify") {
            expect(a.assembly.portEntries(notifyReadPort).get(key)).toBe(reader);
            expect(b.assembly.portEntries(notifyReadPort).get(key)).toBe(reader);
          }
        await expect(
          h.tx.run((tx) => base.subscriber(SUBSCRIBER)!.handle(tx, one.event)),
        ).rejects.toThrow("本实例");
        await expect(
          h.tx.run((tx) => notifyReadOf(base).read(tx, "tenantQuotaForNotify", one.event.id)),
        ).rejects.toThrow("本实例");
        await a.handle(one.event);
        await b.handle(two.event);
        expect((await h.evidence(one.event.id)).notifications[0]!.createdAt).toEqual(h.clock.now());
        expect((await h.evidence(two.event.id)).notifications[0]!.createdAt).toEqual(
          other.clock.now(),
        );
        const old = a.assembly.subscriber(SUBSCRIBER)!;
        const oldReader = notifyReadOf(a.assembly);
        await a.close();
        await expect(h.tx.run((tx) => old.handle(tx, one.event))).rejects.toThrow("已经关闭");
        await expect(
          h.tx.run((tx) => oldReader.read(tx, "tenantQuotaForNotify", one.event.id)),
        ).rejects.toThrow("已经关闭");
        await b.handle(two.event);
        expect((await h.evidence(two.event.id)).notifications).toHaveLength(1);
      } finally {
        await other.close();
      }
    },
    SLOW,
  );

  it(
    "未attach的subscriber/reader拒绝，attach一次且close后不能复活",
    async () => {
      const w = await h.world(),
        missing = h.runtime(h.tx, { attach: false });
      await expect(missing.handle(w.event)).rejects.toThrow("尚未绑定");
      await expect(missing.read(w.event.id)).rejects.toThrow("尚未绑定");
      missing.scope.attach(missing.service);
      expect(() => missing.scope.attach(missing.service)).toThrow("只能绑定一次");
      await missing.handle(w.event);
      await missing.close();
      expect(() => missing.scope.attach(missing.service)).toThrow("只能绑定一次");
      expect((await h.evidence(w.event.id)).notifications).toHaveLength(1);
    },
    SLOW,
  );

  it.each([
    "missingSubscriber",
    "duplicateSubscriber",
    "incompleteEvents",
    "missingReader",
    "duplicateReader",
  ] as const)("%s装配必须启动失败", (kind) => {
    const base = assembleForTest({ entry: "worker" });
    const subscriber = base.subscriber(SUBSCRIBER)!;
    const reader = base.portImplementations.find(
      (entry) => entry.port === notifyReadPort && entry.key === "tenantQuotaForNotify",
    )!;
    const subscribers =
      kind === "missingSubscriber"
        ? base.subscribers.filter((entry) => entry.name !== SUBSCRIBER)
        : kind === "duplicateSubscriber"
          ? [...base.subscribers, subscriber]
          : kind === "incompleteEvents"
            ? base.subscribers.map((entry) =>
                entry === subscriber
                  ? { ...entry, events: ["billing.subscription.expired"] }
                  : entry,
              )
            : base.subscribers;
    const portImplementations =
      kind === "missingReader"
        ? base.portImplementations.filter((entry) => entry !== reader)
        : kind === "duplicateReader"
          ? [...base.portImplementations, reader]
          : base.portImplementations;
    expect(() =>
      createTenantEntitlementAssembly({ ...base, subscribers, portImplementations }),
    ).toThrow("唯一");
  });

  it.each(["billing", "termForNotify"] as const)(
    "缺失真实%s事实装配必须失败，不能假作未超额",
    async (key) => {
      const w = await h.world();
      const base = assembleForTest({ entry: "worker" });
      const assembly = {
        ...base,
        portEntries<T>(port: KeyedPort<T>) {
          const entries = new Map(base.portEntries(port));
          if (port.name === (key === "billing" ? merchantFactsPort.name : notifyReadPort.name))
            entries.delete(key);
          return entries;
        },
      };
      const construct = () =>
        createRuntimeTenantEntitlement({ clock: h.clock, assembly, notify: r.notify });
      const before = await h.snapshot();
      if (key === "billing") expect(construct).toThrow("真实计费");
      else
        await expect(
          h.tx.run((tx) => construct().onEntitlementChanged(tx, w.event)),
        ).rejects.toThrow("真实周期");
      expect(await h.snapshot()).toEqual(before);
    },
    SLOW,
  );
});
