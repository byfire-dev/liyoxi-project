import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, loadEnv } from "../index.js";
import { claimDeliveries, consumeDelivery, createEvents } from "../events/index.js";
import type { DeliveryRef } from "../events/index.js";
import { alertsOf, lockRows, uuidv7 } from "../kernel/index.js";
import { createProfileTenantLifecycle } from "../profile/index.js";
import { createTenant } from "../tenant/index.js";
import { fakeKeyEnv, useSeededDatabase, useTestRedis } from "../testing/index.js";
import { DAY } from "./__fixtures__/profile-lifecycle.js";
import { deleteHarness, deleteIdem, SLOW } from "./__fixtures__/store-delete.js";
import type { DeleteHarness } from "./__fixtures__/store-delete.js";
import { createProfileLifecycleAssembly } from "./profile-lifecycle-runtime.js";
import { readStoreDraftFacts } from "./store-draft-facts.js";

const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
let h: DeleteHarness,
  runtime: ReturnType<typeof createRuntime>,
  scope: ReturnType<typeof createProfileLifecycleAssembly>;
let events: ReturnType<typeof createEvents>, tenant: ReturnType<typeof createTenant>;
const refs = new Map<string, DeliveryRef>(),
  subscriber = "profile.onTenantLifecycle";
beforeAll(async () => {
  h = deleteHarness(await db.prisma());
  await redis.raw();
  runtime = createRuntime({
    entry: "api",
    version: "lyxtest-store-delete-profile",
    clock: h.clock,
    providers: h.fake,
    redisKeyPrefix: redis.prefix,
    env: {
      ...loadEnv({
        APP_ENV: "test",
        DATABASE_URL: await db.url(),
        REDIS_URL: process.env.REDIS_URL,
      }),
      ...fakeKeyEnv(),
    },
  });
  scope = createProfileLifecycleAssembly(runtime.assembly);
  events = createEvents({ tx: runtime.tx, clock: h.clock, assembly: scope.assembly });
  tenant = createTenant({
    tx: runtime.tx,
    clock: h.clock,
    flow: runtime.flow,
    assembly: scope.assembly,
    events,
    archiveTimers: runtime.timers,
    readStoreDraftFacts,
  });
  scope.attach(
    createProfileTenantLifecycle({
      clock: h.clock,
      tenant,
      approval: runtime.approval,
      events,
      media: runtime.media,
    }),
  );
}, SLOW);
afterAll(async () => {
  scope?.close();
  await runtime?.close();
  h?.close();
}, SLOW);
const deliveryDeps = () => ({
  tx: runtime.tx,
  subscribers: events.subscribers,
  alerts: alertsOf(scope.assembly),
});
async function world() {
  const w = await h.world(),
    assets = await h.assets(w),
    draft = await h.draft(w, "new_store");
  const original = await h.asset({ ...w, store: w.primary }),
    copied = await h.asset(w, { sourceStoreAssetId: original.id });
  return { ...w, assets, draft, copied };
}
type World = Awaited<ReturnType<typeof world>>;
async function remove(w: World) {
  await tenant.deleteStore(w.ctx, { storeId: w.store.id }, { idem: deleteIdem(w.ctx, w.store.id) });
  const rows = await h.prisma.outboxEvent.findMany({
    where: {
      aggregateId: w.store.id,
      eventType: { in: ["store.archived", "store.draft_deleted"] },
    },
    orderBy: { seq: "asc" },
  });
  expect(rows.map((e) => e.eventType)).toEqual(["store.archived", "store.draft_deleted"]);
  while ((await events.expand()).events > 0) {
    /* 原 outbox 真实展开。 */
  }
  const batch = await runtime.tx.run((tx) => claimDeliveries(tx));
  for (const ref of batch.claimed) if (ref.subscriber === subscriber) refs.set(ref.eventId, ref);
  return rows.map((row) => {
    const ref = refs.get(row.id);
    if (!ref) throw new Error("没有真实 profile 投递");
    return ref;
  });
}
async function released(w: World) {
  const now = h.clock.now();
  const round = await h.prisma.qualificationSubmission.findUniqueOrThrow({
    where: { id: w.draft.round.id },
  });
  expect(round).toMatchObject({ outcome: "discarded", closedAt: now, submittedAt: null });
  expect(
    await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: w.draft.doc.id } }),
  ).toMatchObject({ removedAt: now });
  const anchor = (await h.prisma.store.findUniqueOrThrow({ where: { id: w.store.id } }))
    .archivedAt!;
  expect(await h.readRef(w.draft.input)).toMatchObject({
    state: "released",
    keepUntil: new Date(Math.max(anchor.getTime() + 7 * DAY, now.getTime() + 7 * DAY)),
  });
  for (const input of w.assets.inputs)
    expect(await h.readRef(input)).toMatchObject({
      state: "released",
      keepUntil: new Date(Math.max(anchor.getTime() + 180 * DAY, now.getTime() + 30 * DAY)),
    });
  expect(await h.prisma.storeAsset.findUniqueOrThrow({ where: { id: w.copied.id } })).toEqual(
    w.copied,
  );
}

describe("草稿删除：原 profile 订阅、两个真实事件与保留期", { timeout: SLOW }, () => {
  it.each(["archived_first", "draft_deleted_first"] as const)(
    "%s 任意次序恰一次草稿丢弃与留存，重复完全零旁写",
    async (order) => {
      const w = await world(),
        before = await h.snapshot(w.entity.id),
        delivery = await remove(w);
      // HTTP 提交不越界修改档案；真正消费才改变 round/doc/ref。
      expect((await h.snapshot(w.entity.id)).rounds).toEqual(before.rounds);
      if (order === "draft_deleted_first") delivery.reverse();
      for (const ref of delivery) expect(await consumeDelivery(deliveryDeps(), ref)).toBe("done");
      await released(w);
      const snapshot = await h.snapshot(w.entity.id);
      const deliveries = await h.prisma.outboxDelivery.findMany({
        where: { outboxEventId: { in: delivery.map((r) => r.eventId) } },
        orderBy: [{ outboxEventId: "asc" }, { subscriber: "asc" }],
      });
      h.clock.advance(DAY);
      for (const ref of delivery) expect(await consumeDelivery(deliveryDeps(), ref)).toBe("stale");
      // 新 delivery id 的真实原事件重复也不能令当前 clock 顺延已足够的目标。
      for (const ref of delivery) {
        const row = await h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: ref.eventId } });
        await runtime.tx.run((tx) =>
          events.subscribers.get(subscriber)!.handle(tx, {
            id: uuidv7(),
            type: row.eventType,
            payload: row.payload as Record<string, unknown>,
          }),
        );
      }
      expect(await h.snapshot(w.entity.id)).toEqual(snapshot);
      expect(
        await h.prisma.outboxDelivery.findMany({
          where: { outboxEventId: { in: delivery.map((r) => r.eventId) } },
          orderBy: [{ outboxEventId: "asc" }, { subscriber: "asc" }],
        }),
      ).toEqual(deliveries);
      await expect(tenant.restoreStore(w.ctx, { storeId: w.store.id })).rejects.toMatchObject({
        error: "NOT_FOUND",
      });
      expect(h.fake.storage.calls).toEqual([]);
    },
  );

  it("首次迟消费服从原 release 当前时钟最低期，后续重复不继续顺延", async () => {
    const w = await world(),
      delivery = await remove(w);
    h.clock.advance(2 * DAY);
    for (const ref of delivery) expect(await consumeDelivery(deliveryDeps(), ref)).toBe("done");
    await released(w);
    const before = await h.snapshot(w.entity.id);
    h.clock.advance(DAY);
    const row = await h.prisma.outboxEvent.findUniqueOrThrow({
      where: { id: delivery[0]!.eventId },
    });
    await runtime.tx.run((tx) =>
      events.subscribers.get(subscriber)!.handle(tx, {
        id: uuidv7(),
        type: row.eventType,
        payload: row.payload as Record<string, unknown>,
      }),
    );
    expect(await h.snapshot(w.entity.id)).toEqual(before);
  });

  it("原更长 released 事实保持，原文件清理时间不缩短", async () => {
    const w = await world(),
      keepUntil = new Date(h.clock.now().getTime() + 500 * DAY);
    await h.tx.run(async (tx) => {
      await lockRows(tx, "file_object", [...new Set(w.assets.inputs.map((r) => r.fileId))].sort());
      for (const input of w.assets.inputs) await h.media.release(tx, { ...input, keepUntil });
    });
    const before = await h.prisma.fileRef.findMany({
      where: { fileId: { in: w.assets.inputs.map((r) => r.fileId) } },
      orderBy: { id: "asc" },
    });
    for (const ref of await remove(w))
      expect(await consumeDelivery(deliveryDeps(), ref)).toBe("done");
    expect(
      await h.prisma.fileRef.findMany({
        where: { fileId: { in: w.assets.inputs.map((r) => r.fileId) } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
  });

  it.each(["missing_ref", "foreign_scope", "after_real_handle"] as const)(
    "%s 真消费 retry 且所有档案写入同事务回滚",
    async (mode) => {
      const w = await world();
      if (mode === "missing_ref")
        await h.prisma.fileRef.deleteMany({
          where: {
            fileId: w.assets.logo.id,
            refType: "store_profile",
            refId: w.store.id,
            role: "logo",
          },
        });
      if (mode === "foreign_scope") {
        const foreign = await h.world(),
          file = await h.file(foreign);
        await h.prisma.storeProfile.update({
          where: { storeId: w.store.id },
          data: { logoFileId: file.id },
        });
      }
      const delivery = await remove(w),
        before = await h.snapshot(w.entity.id);
      const original = events.subscribers.get(subscriber)!;
      let error: unknown;
      const subscribers = {
        ...events.subscribers,
        get(name: string) {
          const entry = events.subscribers.get(name);
          return name === subscriber && entry
            ? {
                ...entry,
                async handle(
                  tx: Parameters<typeof original.handle>[0],
                  event: Parameters<typeof original.handle>[1],
                ) {
                  try {
                    await original.handle(tx, event);
                    if (mode === "after_real_handle") throw new Error("真实处理结束后故障");
                  } catch (caught) {
                    error = caught;
                    throw caught;
                  }
                },
              }
            : entry;
        },
      };
      expect(await consumeDelivery({ ...deliveryDeps(), subscribers }, delivery[0]!)).toBe("retry");
      if (mode === "after_real_handle") expect(error).toEqual(new Error("真实处理结束后故障"));
      else expect(error).toMatchObject({ error: "FILE_NOT_AVAILABLE" });
      expect(await h.snapshot(w.entity.id)).toEqual(before);
      expect(
        await h.prisma.outboxDelivery.findUniqueOrThrow({
          where: { outboxEventId_subscriber: { outboxEventId: delivery[0]!.eventId, subscriber } },
        }),
      ).toMatchObject({ status: "retry", attempts: 1, consumedAt: null });
    },
  );
});
