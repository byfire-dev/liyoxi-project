import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient, Prisma } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase, priceDrama } from "../testing/index.js";
import { createIdempotencyContext, uuidv7 } from "../kernel/index.js";
import { harness, buyer, drama, version, residual, body } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { createOrderService } from "./service.js";
import { countCartBadge } from "./index.js";
const db = useSeededDatabase("services");
let h: Harness, connections: PrismaClient[], others: Harness[];
beforeAll(async () => {
  h = harness(await db.prisma());
  await version(h);
  const connectionString = await db.url();
  connections = Array.from({ length: 2 }, () => createPrismaClient({ connectionString, max: 1 }));
  others = connections.map((p) => harness(p, { clock: h.clock }));
}, 120000);
afterAll(async () => {
  await Promise.all(connections?.map((p) => p.$disconnect()) ?? []);
});
const idem = (
  b: Awaited<ReturnType<typeof buyer>>,
  scope: string,
  id: string,
  input: unknown,
  key = uuidv7(),
) =>
  createIdempotencyContext({
    mode: "required",
    scope,
    actor: b.actor.ctx.actor,
    key,
    request: {
      method: scope.endsWith("delete") ? "DELETE" : "POST",
      pathParams: { cartItemId: id },
      body: input,
      storeId: b.store.id,
    },
    redact: scope.endsWith("acceptPrice") ? ["drama.posterUrl"] : [],
  });
describe("选剧单真实事务", { timeout: 120000 }, () => {
  it("重复加入已读行后另一PID真实建单删项：返回捕获的旧P，不500或重新加入", async () => {
    const b = await buyer(h),
      d = await drama(h, 101),
      added = await h.order.cartCreate(b.actor, d.id),
      adding = others[0]!,
      submitting = others[1]!;
    h.clock.advance(1);
    const staff = await h.make.staff();
    await priceDrama(h, { dramaId: d.id, points: 211, staffId: staff.id });
    const input = await body(submitting, b, [d.id]),
      pids = await Promise.all(
        connections.map((p) => p.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() as pid`),
      );
    expect(new Set(pids.flat().map((p) => p.pid)).size).toBe(2);
    let arrived!: () => void, release!: () => void;
    const seen = new Promise<void>((r) => {
        arrived = r;
      }),
      fence = new Promise<void>((r) => {
        release = r;
      }),
      original = adding.deps.tx,
      service = createOrderService({
        ...adding.deps,
        tx: {
          ...original,
          run: (fn, options) =>
            original.run(
              (tx) =>
                fn(
                  new Proxy(tx, {
                    get: (target, key) =>
                      key === "cartItem"
                        ? new Proxy(target.cartItem, {
                            get: (delegate, method) =>
                              method === "findUnique"
                                ? async (args: Prisma.CartItemFindUniqueArgs) => {
                                    const row = await delegate.findUnique(args);
                                    arrived();
                                    await fence;
                                    return row;
                                  }
                                : Reflect.get(delegate, method, delegate),
                          })
                        : Reflect.get(target, key, target),
                  }),
                ),
              options,
            ),
        },
      }),
      pending = service.cartCreate(b.actor, d.id);
    await seen;
    try {
      const made = await submitting.order.create(b.actor, input);
      expect(made.totalChargePoints).toBe(190);
      expect(await h.prisma.cartItem.count({ where: { id: added.cartItemId } })).toBe(0);
    } finally {
      release();
    }
    const afterSubmit = await residual(h, b.entity.id),
      duplicate = await pending;
    expect(duplicate).toMatchObject({
      cartItemId: added.cartItemId,
      snapshotPricePoints: 101,
      currentPricePoints: 211,
      discountedPoints: 190,
      state: "price_changed",
    });
    expect(duplicate.drama.posterUrl).not.toBeNull();
    expect(await h.prisma.cartItem.count({ where: { storeId: b.store.id } })).toBe(0);
    expect(await residual(h, b.entity.id)).toEqual(afterSubmit);
    expect(afterSubmit).toEqual({ orders: 1, items: 1, holds: 1, consents: 1 });
  });
  it("保存P而非S；折扣变化重算S不改变state；重复调价保留P；接受的是当前P", async () => {
    const b = await buyer(h),
      d = await drama(h, 101),
      first = await h.order.cartCreate(b.actor, d.id);
    expect(first).toMatchObject({
      state: "valid",
      snapshotPricePoints: 101,
      currentPricePoints: 101,
      discountedPoints: 91,
    });
    expect(first.drama.posterUrl?.url).toEqual(expect.any(String));
    await h.prisma.subscriptionTerm.update({
      where: { id: b.term!.id },
      data: { discountBp: 8000 },
    });
    expect((await h.order.cartList(b.actor)).items[0]).toMatchObject({
      state: "valid",
      discountedPoints: 81,
    });
    h.clock.advance(1);
    const staff = await h.make.staff();
    await priceDrama(h, { dramaId: d.id, points: 211, staffId: staff.id });
    const duplicate = await h.order.cartCreate(b.actor, d.id);
    expect(duplicate).toMatchObject({
      cartItemId: first.cartItemId,
      state: "price_changed",
      snapshotPricePoints: 101,
      currentPricePoints: 211,
      discountedPoints: 169,
    });
    await expect(
      h.order.cartAcceptPrice(b.actor, first.cartItemId, { acceptedPricePoints: 169 }),
    ).rejects.toMatchObject({ error: "CART_PRICE_CHANGED", details: { currentPricePoints: 211 } });
    const input = { acceptedPricePoints: 211 },
      key = uuidv7(),
      accepted = await h.order.cartAcceptPrice(b.actor, first.cartItemId, input, {
        idem: idem(b, "m.cartItem.acceptPrice", first.cartItemId, input, key),
      });
    expect(accepted).toMatchObject({
      state: "valid",
      snapshotPricePoints: 211,
      currentPricePoints: 211,
      replayed: false,
    });
    expect(accepted.drama.posterUrl).not.toBeNull();
    const saved = await h.prisma.cartItem.findUniqueOrThrow({ where: { id: first.cartItemId } }),
      calls = h.fake.storage.callsOf("presignGet").length;
    h.clock.advance(1);
    const replay = await h.order.cartAcceptPrice(b.actor, first.cartItemId, input, {
      idem: idem(b, "m.cartItem.acceptPrice", first.cartItemId, input, key),
    });
    expect(replay).toMatchObject({ replayed: true, drama: { posterUrl: null } });
    expect(h.fake.storage.callsOf("presignGet")).toHaveLength(calls);
    expect(await h.prisma.cartItem.findUniqueOrThrow({ where: { id: first.cartItemId } })).toEqual(
      saved,
    );
    await h.order.cartAcceptPrice(b.actor, first.cartItemId, input);
    expect(await h.prisma.cartItem.findUniqueOrThrow({ where: { id: first.cartItemId } })).toEqual(
      saved,
    );
    expect(await residual(h, b.entity.id)).toEqual({ orders: 0, items: 0, holds: 0, consents: 0 });
  });
  it("49项两独立连接栅栏争第50/51：只一个成功；满额重复仍成功，保留旧快照", async () => {
    const b = await buyer(h),
      ds: Awaited<ReturnType<typeof drama>>[] = [];
    for (let n = 0; n < 51; n++) ds.push(await drama(h, 101 + n));
    await h.prisma.cartItem.createMany({
      data: ds.slice(0, 49).map((d) => ({
        id: uuidv7(),
        entityId: b.entity.id,
        storeId: b.store.id,
        dramaId: d.id,
        addedByUserId: b.user.id,
        listPricePoints: 90,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      })),
    });
    let arrivals = 0,
      open!: () => void;
    const fence = new Promise<void>((r) => {
      open = r;
    });
    const pids = await Promise.all(
      connections.map((p) => p.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() as pid`),
    );
    expect(new Set(pids.flat().map((p) => p.pid)).size).toBe(2);
    const results = await Promise.allSettled(
      others.map(async (o, n) => {
        if (++arrivals === 2) open();
        await fence;
        return o.order.cartCreate(b.actor, ds[49 + n]!.id);
      }),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { error: "CART_LIMIT_REACHED", details: { limit: 50 } },
    });
    expect(await h.prisma.cartItem.count({ where: { storeId: b.store.id } })).toBe(50);
    expect(await h.order.cartCreate(b.actor, ds[0]!.id)).toMatchObject({
      snapshotPricePoints: 90,
      state: "price_changed",
    });
    expect(await h.tx.run((tx) => countCartBadge(tx, b.store.id, h.clock.now()))).toBe(50);
  });
  it("失效仍展示历史项，角标排除；缺失/草稿/归档404，下架和停止订购409", async () => {
    const b = await buyer(h),
      d = await drama(h),
      first = await h.order.cartCreate(b.actor, d.id);
    await h.prisma.drama.update({
      where: { id: d.id },
      data: { status: "delisted", delistedAt: h.clock.now(), delistReasonCode: "license_expired" },
    });
    expect((await h.order.cartList(b.actor)).items[0]).toMatchObject({
      state: "invalid",
      invalidReason: "not_listed",
      discountedPoints: null,
    });
    expect(await h.order.cartCreate(b.actor, d.id)).toMatchObject({
      cartItemId: first.cartItemId,
      state: "invalid",
    });
    expect(await h.tx.run((tx) => countCartBadge(tx, b.store.id, h.clock.now()))).toBe(0);
    await expect(
      h.order.cartAcceptPrice(b.actor, first.cartItemId, { acceptedPricePoints: 101 }),
    ).rejects.toMatchObject({ error: "DRAMA_NOT_ORDERABLE" });
    const other = await buyer(h);
    await expect(h.order.cartCreate(other.actor, d.id)).rejects.toMatchObject({
      error: "DRAMA_NOT_ORDERABLE",
      details: { reason: "not_listed" },
    });
    await expect(h.order.cartCreate(other.actor, uuidv7())).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    const draft = await h.make.drama({ status: "draft" });
    await expect(h.order.cartCreate(other.actor, draft.id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    await h.prisma.drama.update({ where: { id: d.id }, data: { archivedAt: h.clock.now() } });
    await expect(h.order.cartCreate(other.actor, d.id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    const stopped = await drama(h);
    await h.order.cartCreate(b.actor, stopped.id);
    await h.prisma.dramaCopyright.updateMany({
      where: { dramaId: stopped.id },
      data: { licenseEndDate: new Date("2026-01-06") },
    });
    expect(
      (await h.order.cartList(b.actor)).items.find((i) => i.drama.dramaId === stopped.id),
    ).toMatchObject({ state: "invalid", invalidReason: "stopped" });
    await expect(h.order.cartCreate(other.actor, stopped.id)).rejects.toMatchObject({
      error: "DRAMA_NOT_ORDERABLE",
      details: { reason: "stopped" },
    });
  });
  it("删除required同键重放为null；跨店/跨主体404，老板和已停用加入守卫", async () => {
    const b = await buyer(h),
      other = await buyer(h),
      d = await drama(h),
      row = await h.order.cartCreate(b.actor, d.id);
    await expect(h.order.cartDelete(other.actor, row.cartItemId)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    await expect(
      h.order.cartAcceptPrice(other.actor, row.cartItemId, { acceptedPricePoints: 101 }),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    const key = uuidv7();
    expect(
      await h.order.cartDelete(b.actor, row.cartItemId, {
        idem: idem(b, "m.cartItem.delete", row.cartItemId, null, key),
      }),
    ).toBeNull();
    expect(
      await h.order.cartDelete(b.actor, row.cartItemId, {
        idem: idem(b, "m.cartItem.delete", row.cartItemId, null, key),
      }),
    ).toBeNull();
    await expect(h.order.cartDelete(b.actor, row.cartItemId)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    await expect(
      h.order.cartCreate(
        { ...b.actor, membership: { ...b.actor.membership, storeMode: "archived" } },
        d.id,
      ),
    ).rejects.toMatchObject({ error: "STORE_ARCHIVED" });
    await expect(
      h.order.cartList({ ...b.actor, membership: { ...b.actor.membership, role: "clerk" } }),
    ).rejects.toMatchObject({ error: "ROLE_FORBIDDEN" });
  });
  it("不同门店可各自加入同剧，停用/未开通套餐不伪造折扣价", async () => {
    const a = await buyer(h, { subscribed: false }),
      b = await buyer(h, { subscribed: false }),
      d = await drama(h);
    const rows = await Promise.all(
      others.map((o, n) => o.order.cartCreate(n === 0 ? a.actor : b.actor, d.id)),
    );
    expect(new Set(rows.map((r) => r.cartItemId)).size).toBe(2);
    for (const row of rows)
      expect(row).toMatchObject({
        state: "valid",
        currentPricePoints: 101,
        discountedPoints: null,
      });
    expect(await h.order.cartList(a.actor)).toMatchObject({ plan: null, spendablePoints: 0 });
  });
});
