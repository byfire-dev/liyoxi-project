import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { standingOf } from "../authz/index.js";
import { createIdempotencyContext, createIdentityContext, uuidv7 } from "../kernel/index.js";
import type { DeliveredEvent } from "../kernel/index.js";
import type { MediaActor } from "../media/index.js";
import { createMediaAssetsHarness, useSeededDatabase } from "../testing/index.js";
import { buyer, body, drama, harness, residual, version } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { createOrderService } from "./service.js";
import { releaseClosedOrderReferences } from "./file-refs.js";
import { bindOrder } from "./binding.js";
import { requestsHarness } from "./__fixtures__/cancel-requests.js";
import { claimDeliveries, consumeDelivery } from "../events/index.js";
import type { DeliveryRef } from "../events/index.js";

const db = useSeededDatabase("services", { label: "orderrefs", max: 1 });
let h: Harness;
let media: Awaited<ReturnType<typeof createMediaAssetsHarness>>;
beforeAll(async () => {
  const prisma = await db.prisma();
  media = await createMediaAssetsHarness(prisma);
  media.clock.set(new Date("2026-01-05T04:00:00Z"));
  h = harness(prisma, { clock: media.clock });
  await version(h);
}, 120_000);
afterAll(async () => media?.close());

async function setup() {
  const b = await buyer(h),
    d = await drama(h),
    input = await body(h, b, [d.id]);
  const actor: MediaActor = {
    identity: createIdentityContext({
      actor: { type: "merchant", id: b.user.id, role: "owner", client: "weapp" },
      entityId: b.entity.id,
      storeId: b.store.id,
    }),
    merchant: {
      entityId: b.entity.id,
      storeId: b.store.id,
      standing: standingOf("owner", "active"),
    },
  };
  return { b, input, actor };
}
async function image(f: Awaited<ReturnType<typeof setup>>) {
  const file = await media.stored(f.actor);
  const asset = await media.media.assets.create(f.actor, { type: "image", fileIds: [file.id] });
  return { file, asset };
}
const orderRefs = (ids: string[]) =>
  h.prisma.fileRef.findMany({
    where: { fileId: { in: ids }, refType: "drama_order", role: "reference" },
    orderBy: { fileId: "asc" },
  });

describe("订购参考文件的真实上传、双关联与回滚", { timeout: 90_000 }, () => {
  it("跨素材文件UUID交错仍先整体410再420，每素材全部文件与usage同TX登记", async () => {
    const f = await setup();
    const files = [];
    for (let i = 0; i < 3; i++) files.push(await media.stored(f.actor));
    // 第一组持最小/最大文件；按组逐个预锁会在第二组的中间UUID倒序。
    const first = await media.media.assets.create(f.actor, {
      type: "image",
      fileIds: [files[0]!.id, files[2]!.id],
    });
    const second = await media.media.assets.create(f.actor, {
      type: "image",
      fileIds: [files[1]!.id],
    });
    const ids = [first.storeAssetId, second.storeAssetId];
    const input = { ...f.input, referenceStoreAssetIds: ids },
      key = uuidv7();
    const options = () => ({
      idem: createIdempotencyContext({
        mode: "required",
        scope: "m.order.create",
        key,
        actor: f.b.actor.ctx.actor,
        request: { method: "POST", body: input, storeId: f.b.store.id },
        redact: ["items[].posterUrl"],
      }),
    });
    const result = await h.order.create(f.b.actor, input, options());
    expect((await h.order.get(f.b.actor, result.orderId)).referenceStoreAssetIds).toEqual(ids);
    expect(await orderRefs(files.map((file) => file.id))).toEqual(
      [...files]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((file) =>
          expect.objectContaining({ fileId: file.id, refId: result.orderId, state: "live" }),
        ),
    );
    expect(
      await h.prisma.storeAssetUsage.count({
        where: { usedByType: "drama_order", usedById: result.orderId, role: "reference" },
      }),
    ).toBe(2);
    const refs = await orderRefs(files.map((file) => file.id));
    expect(await h.order.create(f.b.actor, input, options())).toMatchObject({
      orderId: result.orderId,
      replayed: true,
    });
    expect(await orderRefs(files.map((file) => file.id))).toEqual(refs);
  });

  it("文本参考保留usage，没有底层文件时不造file_ref", async () => {
    const f = await setup();
    const asset = await media.media.assets.create(f.actor, {
      type: "text",
      textBody: "主推服务说明",
    });
    const result = await h.order.create(f.b.actor, {
      ...f.input,
      referenceStoreAssetIds: [asset.storeAssetId],
    });
    expect((await h.order.get(f.b.actor, result.orderId)).referenceStoreAssetIds).toEqual([
      asset.storeAssetId,
    ]);
    expect(
      await h.prisma.fileRef.count({ where: { refType: "drama_order", refId: result.orderId } }),
    ).toBe(0);
  });

  it("素材本身可选而底层文件被拦截时FILE_NOT_USABLE，hold/订单/usage/file_ref全回滚", async () => {
    const f = await setup(),
      made = await image(f);
    await h.prisma.fileObject.update({
      where: { id: made.file.id },
      data: { moderationState: "block" },
    });
    const before = await h.prisma.billingAccount.findUniqueOrThrow({
      where: { entityId: f.b.entity.id },
    });
    await expect(
      h.order.create(f.b.actor, {
        ...f.input,
        referenceStoreAssetIds: [made.asset.storeAssetId],
      }),
    ).rejects.toMatchObject({ error: "FILE_NOT_USABLE", details: { reason: "blocked" } });
    expect(await residual(h, f.b.entity.id)).toEqual({
      orders: 0,
      items: 0,
      holds: 0,
      consents: 0,
    });
    expect(
      await h.prisma.billingAccount.findUniqueOrThrow({ where: { entityId: f.b.entity.id } }),
    ).toEqual(before);
    expect(await orderRefs([made.file.id])).toEqual([]);
    expect(
      await h.prisma.storeAssetUsage.count({ where: { storeAssetId: made.asset.storeAssetId } }),
    ).toBe(0);
  });

  it("第二个真实link之后故障，已写第一个引用及文件缓存也随资金回滚", async () => {
    const f = await setup(),
      a = await image(f),
      b = await image(f);
    const before = await h.prisma.fileObject.findMany({
      where: { id: { in: [a.file.id, b.file.id] } },
      orderBy: { id: "asc" },
    });
    let links = 0;
    const service = createOrderService({
      ...h.deps,
      media: {
        signRead: h.deps.media.signRead,
        link: async (tx, input) => {
          await h.deps.media.link(tx, input);
          if (++links === 2) throw new Error("lyxtest.after-order-file-link");
        },
      },
    });
    await expect(
      service.create(f.b.actor, {
        ...f.input,
        referenceStoreAssetIds: [a.asset.storeAssetId, b.asset.storeAssetId],
      }),
    ).rejects.toThrow("lyxtest.after-order-file-link");
    expect(links).toBe(2);
    expect(await residual(h, f.b.entity.id)).toEqual({
      orders: 0,
      items: 0,
      holds: 0,
      consents: 0,
    });
    expect(await orderRefs([a.file.id, b.file.id])).toEqual([]);
    expect(
      await h.prisma.fileObject.findMany({
        where: { id: { in: [a.file.id, b.file.id] } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
  });

  it("跨店素材在持账前拒绝，错误精确指向referenceStoreAssetIds下标", async () => {
    const f = await setup(),
      other = await setup(),
      made = await image(other);
    await expect(
      h.order.create(f.b.actor, {
        ...f.input,
        referenceStoreAssetIds: [made.asset.storeAssetId],
      }),
    ).rejects.toMatchObject({
      error: "VALIDATION_FAILED",
      details: { fieldErrors: [{ path: "referenceStoreAssetIds.0" }] },
    });
    expect(await residual(h, f.b.entity.id)).toEqual({
      orders: 0,
      items: 0,
      holds: 0,
      consents: 0,
    });
    expect(await orderRefs([made.file.id])).toEqual([]);
  });
});

describe("订单拥有的终态参考留存", { timeout: 90_000 }, () => {
  it("真实免审批取消的cancel.executed可独立驱动释放，覆盖父状态事件被抑制的消费路径", async () => {
    const cancel = requestsHarness(h.prisma);
    const unbind = bindOrder({ ...cancel.core, media: media.media });
    try {
      const p = await cancel.atStage("pending_start");
      media.clock.set(cancel.clock.now());
      const actor: MediaActor = {
        identity: createIdentityContext({
          actor: { type: "merchant", id: p.b.user.id, role: "owner", client: "weapp" },
          entityId: p.b.entity.id,
          storeId: p.b.store.id,
        }),
        merchant: {
          entityId: p.b.entity.id,
          storeId: p.b.store.id,
          standing: standingOf("owner", "active"),
        },
      };
      const file = await media.stored(actor);
      await media.media.assets.create(actor, { type: "image", fileIds: [file.id] });
      await cancel.tx.run((tx) =>
        media.media.link(tx, {
          fileId: file.id,
          entityId: p.b.entity.id,
          storeId: p.b.store.id,
          refType: "drama_order",
          refId: p.out.orderId,
          role: "reference",
        }),
      );
      await cancel.param("refund.points.auto_approve_before_production", true, p.actor);
      const result = await cancel.create(p);
      expect(result.status).toBe("done");
      const event = await h.prisma.outboxEvent.findFirstOrThrow({
        where: { eventType: "cancel.executed", aggregateId: result.cancelRequestId },
      });
      expect(cancel.events.subscribers.get("order.onReferencesClosed")?.critical).toBe(true);
      // 使用真实中继展开、租约认领和消费，不把直接调用handler冒充正式投递链。
      let delivery: DeliveryRef | undefined;
      for (let attempt = 0; attempt < 8 && !delivery; attempt++) {
        await cancel.events.expand();
        const claimed = await cancel.tx.run((tx) => claimDeliveries(tx));
        delivery = claimed.claimed.find(
          (ref) => ref.eventId === event.id && ref.subscriber === "order.onReferencesClosed",
        );
      }
      expect(delivery).toBeDefined();
      const dispatch = {
        tx: cancel.tx,
        subscribers: cancel.events.subscribers,
        alerts: {
          raise: async () => {
            throw new Error("lyxtest.unexpected-release-failure");
          },
        },
      };
      expect(await consumeDelivery(dispatch, delivery!)).toBe("done");
      const refs = await orderRefs([file.id]);
      expect(refs[0]).toMatchObject({ refId: p.out.orderId, state: "released" });
      expect(
        await h.prisma.outboxDelivery.findUniqueOrThrow({
          where: {
            outboxEventId_subscriber: {
              outboxEventId: event.id,
              subscriber: "order.onReferencesClosed",
            },
          },
        }),
      ).toMatchObject({ status: "done" });
      expect(await consumeDelivery(dispatch, delivery!)).toBe("stale");
      expect(await orderRefs([file.id])).toEqual(refs);
    } finally {
      unbind();
      await cancel.close();
    }
  });

  it.each(["ended", "cancelled", "refunded"])(
    "%s真实终态释放90天，迟到/重复不缩短其他引用也不反复顺延",
    async (status) => {
      const f = await setup(),
        made = await image(f),
        closedAt = h.clock.now(),
        order = await h.make.dramaOrder({
          entityId: f.b.entity.id,
          storeId: f.b.store.id,
          placedByUserId: f.b.user.id,
          subscriptionTermId: f.b.term!.id,
          status,
          closedAt,
        });
      // 合法历史终态工厂仅准备消费前提；引用经真实媒体公口登记，不伪装下单producer。
      await h.tx.run((tx) =>
        media.media.link(tx, {
          fileId: made.file.id,
          entityId: f.b.entity.id,
          storeId: f.b.store.id,
          refType: "drama_order",
          refId: order.id,
          role: "reference",
        }),
      );
      const event: DeliveredEvent = {
        id: uuidv7(),
        type: "order.status_changed",
        payload: { v: 1, dramaOrderId: order.id },
      };
      h.clock.advance(86_400_000);
      await h.tx.run((tx) => releaseClosedOrderReferences(tx, { media: media.media }, event));
      const refs = await orderRefs([made.file.id]);
      expect(refs[0]).toMatchObject({
        state: "released",
        releasedAt: h.clock.now(),
        keepUntil: new Date(h.clock.now().getTime() + 90 * 86_400_000),
      });
      expect(
        (await h.prisma.fileObject.findUniqueOrThrow({ where: { id: made.file.id } })).purgeAfter,
      ).toBeNull();
      h.clock.advance(86_400_000);
      await h.tx.run((tx) => releaseClosedOrderReferences(tx, { media: media.media }, event));
      expect(await orderRefs([made.file.id])).toEqual(refs);
    },
  );

  it("状态事件载荷不替代当前订单事实，未终态订单的参考仍live", async () => {
    const f = await setup(),
      made = await image(f),
      result = await h.order.create(f.b.actor, {
        ...f.input,
        referenceStoreAssetIds: [made.asset.storeAssetId],
      });
    const refs = await orderRefs([made.file.id]);
    await h.tx.run((tx) =>
      releaseClosedOrderReferences(
        tx,
        { media: media.media },
        {
          id: uuidv7(),
          type: "order.status_changed",
          payload: { v: 1, dramaOrderId: result.orderId, toState: "cancelled" },
        },
      ),
    );
    expect(await orderRefs([made.file.id])).toEqual(refs);
  });
});
