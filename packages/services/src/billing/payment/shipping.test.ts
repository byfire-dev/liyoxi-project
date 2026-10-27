import { afterEach, beforeEach, expect, it } from "vitest";
import type { WechatShippingOrder } from "../../providers/types.js";
import { failed } from "../../providers/types.js";
import { isInTransaction, purgeExpiredIdempotencyRecords } from "../../kernel/index.js";
import {
  applyReceipt,
  pendingPlanOrder,
  snapshotTables,
  transferReceipt,
  useSeededDatabase,
} from "../../testing/index.js";
import { APPID, MCHID, shippingWorld } from "./shipping.test.fixture.js";
import type { ShippingWorld } from "./shipping.test.fixture.js";

const db = useSeededDatabase("services", { max: 1, label: "shipping" });
let w: ShippingWorld;
beforeEach(async () => {
  await db.reset();
  w = shippingWorld(await db.prisma(), await db.url());
}, 60_000);
afterEach(() => w?.closeAll());
const receipt = (id: string) => w.prisma.paymentTxn.findUniqueOrThrow({ where: { id } });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it("默认关闭、对公和虚构paid来源零外呼；不写任何发货意图", async () => {
  const source = w.source(),
    own = await w.paid();
  await source.prepare(own.event);
  await source.consume(own.event);
  expect((await receipt(own.receipt.id)).shippingReportState).toBeNull();
  await w.controls(true);
  const merchant = await w.make.merchant({ verified: true });
  const order = await pendingPlanOrder(w, { entityId: merchant.entity.id });
  const bank = await transferReceipt(w, order);
  await applyReceipt(w, bank);
  const bankEvent = await w.eventOf({ order, receipt: bank });
  await source.prepare(bankEvent.event);
  await source.consume(bankEvent.event);
  await expect(
    source.prepare({ ...own.event, payload: { ...own.event.payload, amountFen: 1 } }),
  ).rejects.toMatchObject({ error: "INTERNAL" });
  expect(w.provider.wechat.callsOf("uploadShippingInfo")).toHaveLength(0);
  expect(w.provider.wechat.callsOf("queryShippingInfo")).toHaveLength(0);
  expect((await receipt(bank.id)).shippingReportState).toBeNull();
});

it("真实运输先提交unknown才事务外POST，确认与done一致；重放零重复外呼或账本写", async () => {
  await w.controls(true);
  const own = await w.paid(),
    source = w.source();
  const before = await snapshotTables(w.prisma, [
    "billing_order",
    "point_ledger_entry",
    "ledger_operation",
    "subscription_term",
  ]);
  const original = w.provider.wechat.uploadShippingInfo!;
  w.provider.wechat.uploadShippingInfo = async (input) => {
    expect(isInTransaction()).toBe(false);
    const row = await receipt(own.receipt.id);
    expect(row).toMatchObject({
      shippingReportState: "unknown",
      shippingReportAppid: APPID,
      shippingReportMchid: MCHID,
      shippingReportConfirmedAt: null,
    });
    expect(row.shippingReportUploadTime).toEqual(input.uploadedAt);
    return original(input);
  };
  const delivered = await source.deliver(own.event);
  expect(delivered.outcome).toBe("done");
  expect(await delivered.repeat()).toBe("stale");
  await source.prepare(own.event);
  expect(await receipt(own.receipt.id)).toMatchObject({
    shippingReportState: "confirmed",
    shippingReportConfirmedAt: w.clock.now(),
  });
  expect(w.provider.wechat.callsOf("uploadShippingInfo")).toHaveLength(1);
  expect(w.provider.wechat.callsOf("queryShippingInfo")).toHaveLength(0);
  expect(
    await snapshotTables(w.prisma, [
      "billing_order",
      "point_ledger_entry",
      "ledger_operation",
      "subscription_term",
    ]),
  ).toEqual(before);
});

it("渠道已受理但应答丢失：真实退款/24h清理后仍只query同永久意图", async () => {
  await w.controls(true);
  const request = await w.approved(),
    own = await w.eventOf(request),
    source = w.source();
  const original = w.provider.wechat.uploadShippingInfo!;
  w.provider.wechat.uploadShippingInfo = async (input) => {
    expect((await original(input)).ok).toBe(true);
    return { ...failed("unavailable", "隔离模拟响应丢失"), acceptance: "unknown" };
  };
  expect((await source.deliver(own.event)).outcome).toBe("retry");
  const unknown = await receipt(own.receipt.id);
  expect(unknown.shippingReportState).toBe("unknown");
  await w.execute(request);
  const refunded = await w.prisma.refundTxn.findFirstOrThrow({
    where: { refundRequestId: request.created.refundRequestId },
  });
  await w.result(refunded.id);
  expect(
    (await w.prisma.billingOrder.findUniqueOrThrow({ where: { id: own.order.id } })).status,
  ).toBe("refunded");
  w.clock.advance(86_400_001);
  // 通用清理按DB基础设施时钟；仅把本轮真实幂等技术行移到24h清理边界，资金/发货事实不改。
  const expiredAt = new Date("2026-01-02T00:00:00Z");
  expect(
    (
      await w.prisma.idempotencyRecord.updateMany({
        where: { scope: "admin.paymentOrder.refundRequest.create" },
        data: { createdAt: new Date("2026-01-01T00:00:00Z"), expiresAt: expiredAt },
      })
    ).count,
  ).toBe(1);
  expect(await w.tx.run((tx) => purgeExpiredIdempotencyRecords(tx))).toBe(1);
  expect(
    await w.prisma.idempotencyRecord.count({
      where: { scope: "admin.paymentOrder.refundRequest.create" },
    }),
  ).toBe(0);
  await source.prepare(own.event);
  await source.consume(own.event);
  expect(await receipt(own.receipt.id)).toMatchObject({
    shippingReportState: "confirmed",
    shippingReportUploadTime: unknown.shippingReportUploadTime,
    shippingReportConfirmedAt: w.clock.now(),
  });
  expect(w.provider.wechat.callsOf("uploadShippingInfo")).toHaveLength(1);
  expect(w.provider.wechat.callsOf("queryShippingInfo")).toHaveLength(1);
});

it("unknown提交后调用前崩溃、查询空或失败均不得盲目重发", async () => {
  await w.controls(true);
  const own = await w.paid(),
    source = w.source();
  const original = w.provider.wechat.uploadShippingInfo!;
  w.provider.wechat.uploadShippingInfo = async () => {
    throw new Error("隔离调用前中断");
  };
  await expect(source.prepare(own.event)).rejects.toThrow("隔离调用前中断");
  w.provider.wechat.uploadShippingInfo = original;
  await expect(source.prepare(own.event)).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
  w.provider.wechat.failNext("queryShippingInfo");
  await expect(source.prepare(own.event)).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
  expect((await receipt(own.receipt.id)).shippingReportState).toBe("unknown");
  expect(w.provider.wechat.callsOf("uploadShippingInfo")).toHaveLength(0);
  expect(w.provider.wechat.callsOf("queryShippingInfo")).toHaveLength(2);
  await w.controls(false);
  await source.prepare(own.event);
  await source.consume(own.event);
  expect((await receipt(own.receipt.id)).shippingReportState).toBe("unknown");
});

it("恢复必须全匹配渠道身份、金额和单条虚拟统一发货事实，配置迁换不外呼", async () => {
  await w.controls(true);
  const own = await w.paid(),
    source = w.source();
  const original = w.provider.wechat.uploadShippingInfo!;
  w.provider.wechat.uploadShippingInfo = async (input) => {
    expect((await original(input)).ok).toBe(true);
    return failed("unavailable", "隔离模拟未知");
  };
  await expect(source.prepare(own.event)).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
  const valid = w.provider.wechat.shippingOrders.get(own.receipt.channelTxnNo!)!;
  const shipping = valid.shipping!;
  const bad: WechatShippingOrder[] = [
    { ...valid, transactionId: "wrong" },
    { ...valid, outTradeNo: "wrong" },
    { ...valid, mchid: "1900000000" },
    { ...valid, payerOpenid: "wrong" },
    { ...valid, amountFen: valid.amountFen + 1 },
    { ...valid, shipping: null },
    { ...valid, shipping: { ...shipping, logisticsType: 1 } },
    { ...valid, shipping: { ...shipping, deliveryMode: 2 } },
    { ...valid, shipping: { ...shipping, finished: false } },
    {
      ...valid,
      shipping: { ...shipping, items: [{ ...shipping.items[0]!, description: "wrong" }] },
    },
    {
      ...valid,
      shipping: {
        ...shipping,
        items: [{ ...shipping.items[0]!, uploadedAtSec: shipping.items[0]!.uploadedAtSec + 1 }],
      },
    },
    { ...valid, shipping: { ...shipping, items: [...shipping.items, ...shipping.items] } },
  ];
  for (const fact of bad) {
    w.provider.wechat.shippingOrders.set(valid.transactionId, fact);
    await expect(source.prepare(own.event)).rejects.toMatchObject({
      error: "PROVIDER_UNAVAILABLE",
    });
    expect((await receipt(own.receipt.id)).shippingReportState).toBe("unknown");
  }
  w.provider.wechat.shippingOrders.set(valid.transactionId, valid);
  for (const override of [{ appid: "wx1111111111111111" }, { mchid: "1900000000" }]) {
    await expect(w.source(override).prepare(own.event)).rejects.toMatchObject({
      error: "PROVIDER_UNAVAILABLE",
    });
  }
  expect(w.provider.wechat.callsOf("uploadShippingInfo")).toHaveLength(1);
  expect(w.provider.wechat.callsOf("queryShippingInfo")).toHaveLength(bad.length);
  await source.prepare(own.event);
  expect((await receipt(own.receipt.id)).shippingReportState).toBe("confirmed");
});

it("明确not_accepted才可重试同固定意图，普通rejected缺受理证明仍只query", async () => {
  await w.controls(true);
  const own = await w.paid(),
    source = w.source();
  const remote = w.provider.wechat.shippingOrders.get(own.receipt.channelTxnNo!)!;
  w.provider.wechat.shippingOrders.delete(own.receipt.channelTxnNo!);
  await expect(source.prepare(own.event)).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
  const refused = await receipt(own.receipt.id);
  expect(refused.shippingReportState).toBe("not_accepted");
  w.provider.wechat.shippingOrders.set(remote.transactionId, remote);
  w.clock.advance(1000);
  await source.prepare(own.event);
  expect(await receipt(own.receipt.id)).toMatchObject({
    shippingReportState: "confirmed",
    shippingReportUploadTime: refused.shippingReportUploadTime,
  });
  const other = await w.paid();
  w.provider.wechat.failNext("uploadShippingInfo", { reason: "rejected" });
  await expect(source.prepare(other.event)).rejects.toMatchObject({
    error: "PROVIDER_UNAVAILABLE",
  });
  await expect(source.prepare(other.event)).rejects.toMatchObject({
    error: "PROVIDER_UNAVAILABLE",
  });
  expect((await receipt(other.receipt.id)).shippingReportState).toBe("unknown");
  expect(w.provider.wechat.callsOf("uploadShippingInfo")).toHaveLength(3);
  expect(w.provider.wechat.callsOf("queryShippingInfo")).toHaveLength(1);
});

it("明确拒绝后真实退款完成，重投不再POST且保留not_accepted", async () => {
  await w.controls(true);
  const approved = await w.approved(),
    own = await w.eventOf(approved),
    source = w.source();
  w.provider.wechat.shippingOrders.delete(own.receipt.channelTxnNo!);
  await expect(source.prepare(own.event)).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
  expect((await receipt(own.receipt.id)).shippingReportState).toBe("not_accepted");
  await w.execute(approved);
  const refund = await w.prisma.refundTxn.findFirstOrThrow({
    where: { refundRequestId: approved.created.refundRequestId },
  });
  await w.result(refund.id);
  expect(
    (await w.prisma.billingOrder.findUniqueOrThrow({ where: { id: own.order.id } })).status,
  ).toBe("refunded");
  await source.prepare(own.event);
  await source.consume(own.event);
  expect((await receipt(own.receipt.id)).shippingReportState).toBe("not_accepted");
  expect(w.provider.wechat.callsOf("uploadShippingInfo")).toHaveLength(1);
  expect(w.provider.wechat.callsOf("queryShippingInfo")).toHaveLength(0);
});

it("真实Clock倒退保持unknown，秒级query不能伪造确认时间；恢复观察毫秒后才确认", async () => {
  await w.controls(true);
  // 让内控早于意图生效，倒退1ms只检验确认观察，不能误落到默认关闭分支。
  w.clock.advance(1000);
  const own = await w.paid(),
    source = w.source(),
    intended = w.clock.now();
  const original = w.provider.wechat.uploadShippingInfo!;
  w.provider.wechat.uploadShippingInfo = async (input) => {
    const result = await original(input);
    w.clock.set(new Date(intended.getTime() - 1));
    return result;
  };
  await expect(source.prepare(own.event)).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
  expect(await receipt(own.receipt.id)).toMatchObject({
    shippingReportState: "unknown",
    shippingReportConfirmedAt: null,
  });
  await expect(source.prepare(own.event)).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
  w.clock.set(intended);
  await source.prepare(own.event);
  expect(await receipt(own.receipt.id)).toMatchObject({
    shippingReportState: "confirmed",
    shippingReportConfirmedAt: intended,
  });
  expect(w.provider.wechat.callsOf("uploadShippingInfo")).toHaveLength(1);
  expect(w.provider.wechat.callsOf("queryShippingInfo")).toHaveLength(2);
});

it("两个真实会话owner竞争同交易三轮只有一个POST，另一个占用失败后只读confirmed", async () => {
  await w.controls(true);
  const left = w.source(),
    right = w.source();
  const original = w.provider.wechat.uploadShippingInfo!;
  for (let round = 0; round < 3; round++) {
    const own = await w.paid(),
      entered = deferred(),
      release = deferred();
    w.provider.wechat.uploadShippingInfo = async (input) => {
      const result = await original(input);
      entered.resolve();
      await release.promise;
      return result;
    };
    const pending = left.prepare(own.event);
    try {
      await entered.promise;
      await expect(right.prepare(own.event)).rejects.toMatchObject({ error: "BUSY" });
    } finally {
      release.resolve();
    }
    await pending;
    await right.prepare(own.event);
    expect((await receipt(own.receipt.id)).shippingReportState).toBe("confirmed");
    expect(w.provider.wechat.callsOf("uploadShippingInfo")).toHaveLength(round + 1);
  }
  expect(w.provider.wechat.callsOf("queryShippingInfo")).toHaveLength(0);
});
