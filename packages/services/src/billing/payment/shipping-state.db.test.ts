// 仅验证新增结构与旧读兼容：直接构造行内事实，不安装发货 writer 或调用微信。
import type { Prisma, PrismaClient } from "@liyoxi/db";
import fc from "fast-check";
import { beforeEach, expect, it } from "vitest";
import { createClock, createFactories, useSeededDatabase } from "../../testing/index.js";

const db = useSeededDatabase("services", { max: 1, label: "shipstate" });
const clock = createClock(new Date("2026-10-19T03:00:00.999Z"));
let prisma: PrismaClient;
let make: ReturnType<typeof createFactories>;
beforeEach(async () => {
  await db.reset();
  prisma = await db.prisma();
  make = createFactories({ db: prisma, clock });
}, 60_000);

const empty = {
  shippingReportState: null,
  shippingReportAppid: null,
  shippingReportMchid: null,
  shippingReportItemDesc: null,
  shippingReportUploadTime: null,
  shippingReportConfirmedAt: null,
};
const intent = {
  shippingReportState: "unknown",
  shippingReportAppid: "wx0000000000000000",
  shippingReportMchid: "1900000001",
  shippingReportItemDesc: "套餐数字服务",
  shippingReportUploadTime: clock.now(),
};
async function receipt() {
  const order = await make.billingOrder();
  return prisma.paymentTxn.update({
    where: { id: order.paidPaymentTxnId! },
    data: { channelPayerRef: "o-test-shipping-payer" },
  });
}

it("旧渠道事实、孤儿及已入账收款默认六列全空，旧显式投影读取不改事实", async () => {
  const rows = [];
  for (const status of ["created", "prepaid", "closed", "succeeded"]) {
    rows.push(await make.paymentTxn({ status, entityId: null }));
  }
  rows.push(await receipt());
  const staff = await make.staff();
  rows.push(
    await make.paymentTxn({
      channel: "bank_transfer",
      entityId: null,
      bankSerialRaw: "TEST-SHIPPING-LEGACY-BANK",
      confirmedByStaffId: staff.id,
    }),
  );
  for (const row of rows) expect(row).toMatchObject(empty);
  const ids = rows.map(({ id }) => id);
  const before = await prisma.paymentTxn.findMany({ where: { id: { in: ids } } });
  const projected = await prisma.paymentTxn.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, channel: true, amountFen: true, appliedAt: true },
    orderBy: { id: "asc" },
  });
  expect(projected).toEqual(
    [...rows]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((row) => ({
        id: row.id,
        status: row.status,
        channel: row.channel,
        amountFen: row.amountFen,
        appliedAt: row.appliedAt,
      })),
  );
  expect(await prisma.paymentTxn.findMany({ where: { id: { in: ids } } })).toEqual(before);
});

it("未认领不得只填五列之一；声明状态仅三种且意图必须完整有效", async () => {
  const row = await receipt();
  const update = (data: Prisma.PaymentTxnUncheckedUpdateInput) =>
    prisma.paymentTxn.update({ where: { id: row.id }, data });
  for (const data of [
    { shippingReportAppid: intent.shippingReportAppid },
    { shippingReportMchid: intent.shippingReportMchid },
    { shippingReportItemDesc: intent.shippingReportItemDesc },
    { shippingReportUploadTime: intent.shippingReportUploadTime },
    { shippingReportConfirmedAt: clock.now() },
  ]) {
    await expect(update(data)).rejects.toThrow(/ck_payment_txn_shipping_report_/);
  }
  const invalid: Prisma.PaymentTxnUncheckedUpdateInput[] = [
    { shippingReportState: "sent" },
    { shippingReportAppid: null },
    { shippingReportAppid: "bad appid" },
    { shippingReportMchid: null },
    { shippingReportMchid: "merchant" },
    { shippingReportItemDesc: null },
    { shippingReportItemDesc: "" },
    { shippingReportItemDesc: "   " },
    { shippingReportItemDesc: "😀".repeat(121) },
    { shippingReportUploadTime: null },
  ];
  for (const patch of invalid) {
    await expect(update({ ...intent, ...patch })).rejects.toThrow(
      /ck_payment_txn_shipping_report_/,
    );
  }
  expect(await prisma.paymentTxn.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject(empty);
  // PostgreSQL char_length按Unicode字符计数，不错误地按JS的UTF-16单元限长。
  for (const state of ["unknown", "not_accepted", "confirmed"]) {
    expect(
      await update({
        ...intent,
        shippingReportState: state,
        shippingReportItemDesc: "😀".repeat(120),
        shippingReportConfirmedAt: state === "confirmed" ? clock.now() : null,
      }),
    ).toMatchObject({ shippingReportState: state, shippingReportItemDesc: "😀".repeat(120) });
  }
});

it("认领仅限有真实入账基础事实的微信收款，预下单openid不能替代实际渠道付款人", async () => {
  const row = await receipt();
  const staff = await make.staff();
  const invalid: Prisma.PaymentTxnUncheckedUpdateInput[] = [
    { status: "prepaid", appliedAt: null },
    { billingOrderId: null, appliedAt: null },
    { entityId: null },
    { appliedAt: null },
    { channelTxnNo: null },
    { channelTxnNo: " " },
    { channelAmountFen: null },
    { channelPayerRef: null, payerOpenid: "o-test-prepay-only" },
    { channelPayerRef: " " },
    {
      channel: "bank_transfer",
      bankSerialRaw: "TEST-SHIPPING-CLAIM-BANK",
      confirmedByStaffId: staff.id,
    },
  ];
  for (const patch of invalid) {
    await expect(
      prisma.paymentTxn.update({ where: { id: row.id }, data: { ...intent, ...patch } }),
    ).rejects.toThrow(/ck_payment_txn_/);
  }
  // 缺实收/渠道号/主体等原有CHECK仍可能先拒绝；不假称全由新增CHECK负责。
  expect(await prisma.paymentTxn.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
    ...empty,
    channel: "wechat_jsapi",
    status: "succeeded",
    channelPayerRef: "o-test-shipping-payer",
    billingOrderId: row.billingOrderId,
    appliedAt: row.appliedAt,
  });
});

it("只有confirmed可填观察时刻；任意毫秒边界相等可确认，倒退1毫秒必拒绝", async () => {
  const row = await receipt();
  const update = (data: Prisma.PaymentTxnUncheckedUpdateInput) =>
    prisma.paymentTxn.update({ where: { id: row.id }, data });
  for (const state of ["unknown", "not_accepted"]) {
    await expect(
      update({ ...intent, shippingReportState: state, shippingReportConfirmedAt: clock.now() }),
    ).rejects.toThrow("ck_payment_txn_shipping_report_confirmation");
  }
  await expect(update({ ...intent, shippingReportState: "confirmed" })).rejects.toThrow(
    "ck_payment_txn_shipping_report_confirmation",
  );
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 999 }), async (millis) => {
      const uploadedAt = new Date(Date.parse("2026-10-19T03:00:00.000Z") + millis);
      const confirmed = {
        ...intent,
        shippingReportState: "confirmed",
        shippingReportUploadTime: uploadedAt,
        shippingReportConfirmedAt: uploadedAt,
      };
      expect(await update(confirmed)).toMatchObject(confirmed);
      await expect(
        update({ ...confirmed, shippingReportConfirmedAt: new Date(uploadedAt.getTime() - 1) }),
      ).rejects.toThrow("ck_payment_txn_shipping_report_confirmation");
      expect(await prisma.paymentTxn.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject(
        confirmed,
      );
    }),
    { seed: 20261019, numRuns: 12 },
  );
});
