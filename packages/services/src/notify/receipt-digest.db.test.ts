import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { PaymentTransactionListQuerySchema } from "@liyoxi/contract";
import { uuidv7 } from "../kernel/index.js";
import { notificationFixture, useSeededDatabase } from "../testing/index.js";
import { findNotifyN1Violations, sendReceiptDailyDigest } from "./index.js";

const db = useSeededDatabase("services", { max: 1, label: "receiptdgst" });
let h: ReturnType<typeof notificationFixture>;
beforeEach(async () => {
  await db.reset();
  h = notificationFixture(await db.prisma());
  h.clock.set(new Date("2026-10-19T10:00:00.000Z"));
});
afterEach(async () => {
  await h?.service.close();
});
async function input() {
  const at = h.clock.now(),
    bizDate = "2026-10-19";
  const day = await h.prisma.reconDay.create({
    data: {
      id: uuidv7(),
      billDate: new Date(`${bizDate}T00:00:00.000Z`),
      channel: "bank_transfer",
      status: "ok",
      bankCount: 2,
      bankFen: 4_294_967_294n,
      createdAt: at,
      updatedAt: at,
    },
  });
  const staff = await h.make.staff({ staffRoleKey: "finance", name: "确认财务" });
  return {
    reconDayId: day.id,
    bizDate,
    at,
    items: [0, 1].map((n) => ({
      paymentTxnId: uuidv7(),
      orderNo: n ? null : "PO2026101990001",
      outTradeNo: `PS${uuidv7().replaceAll("-", "")}`,
      amountFen: 2_147_483_647,
      confirmedAt: "2026-10-19T09:00:00.000Z",
      confirmedBy: n ? null : { staffId: staff.id, name: staff.name },
      bankSerialConflictOverride: n === 1,
    })),
  };
}
const send = (value: Awaited<ReturnType<typeof input>>) =>
  h.tx.run((tx) => sendReceiptDailyDigest(tx, value, h.deps.assembly));

it("对公日摘要仅当前在职超管：真实受众/同日幂等、bigint总分、安全清单与仅站内", async () => {
  expect(h.deps.assembly.recurringJob("receipt.daily_digest")).toMatchObject({
    kind: "receipt.daily_digest",
    schedule: { every: "day", at: "18:00" },
    mode: "job",
  });
  const value = await input();
  const first = await h.make.staff({ staffRoleKey: "super_admin" });
  const second = await h.make.staff({ staffRoleKey: "super_admin" });
  await h.make.staff({ staffRoleKey: "super_admin", status: "pending" });
  await h.make.staff({
    staffRoleKey: "super_admin",
    status: "disabled",
    disabledAt: h.clock.now(),
    disabledReason: "other",
  });
  expect(
    await h.prisma.notifyScene.findUnique({ where: { sceneKey: "s.receipt_daily_digest" } }),
  ).toMatchObject({
    audience: "staff",
    extEnabled: false,
    smsPolicy: "never",
    wxTemplateSlotKey: null,
  });
  // 后台误开外部开关也不能让这个纯站内公口创建外部投递。
  await h.prisma.notifyScene.update({
    where: { sceneKey: "s.receipt_daily_digest" },
    data: { extEnabled: true },
  });
  expect(await send(value)).toEqual({ status: "sent", recipients: 2, created: 2 });
  expect(await send(value)).toEqual({ status: "sent", recipients: 2, created: 0 });
  const rows = await h.prisma.notification.findMany({
    where: { notifySceneKey: "s.receipt_daily_digest" },
    orderBy: { staffId: "asc" },
    include: { staffMessage: true, notificationDeliveries: true },
  });
  expect(rows.map((row) => row.staffId)).toEqual([first.id, second.id].sort());
  for (const row of rows) {
    expect(row).toMatchObject({
      dedupeKey: `receipt.daily_digest:${value.bizDate}:${row.staffId}`,
      bizType: "recon_day",
      bizId: value.reconDayId,
      merchantUserId: null,
      entityId: null,
      storeId: null,
      copyMode: null,
      createdAt: value.at,
      vars: {
        bizDate: value.bizDate,
        totalFen: "4294967294",
        conflictCount: 1,
        items: value.items,
      },
    });
    expect(row.staffMessage).toMatchObject({
      staffId: row.staffId,
      kind: "system",
      title: "2026-10-19 对公确认日摘要",
      body: "已确认 2 笔，合计 4294967294 分；流水号冲突放行 1 笔。按成功日期查看收款清单。",
      link: {
        route: "finance.payments",
        params: {
          successFrom: value.bizDate,
          successTo: value.bizDate,
          channel: "bank_transfer",
        },
      },
    });
    const link = z
      .object({ route: z.string(), params: z.record(z.string(), z.string()) })
      .parse(row.staffMessage!.link);
    expect(PaymentTransactionListQuerySchema.parse(link.params)).toMatchObject({
      successFrom: value.bizDate,
      successTo: value.bizDate,
      channel: "bank_transfer",
    });
    expect(row.notificationDeliveries).toHaveLength(1);
    expect(row.notificationDeliveries[0]).toMatchObject({
      channel: "inbox",
      status: "sent",
      sentAt: value.at,
      finishedAt: value.at,
    });
    expect([...row.staffMessage!.body].length).toBeLessThanOrEqual(200);
  }
  expect(await h.tx.run(findNotifyN1Violations)).toEqual([]);
  expect(await h.prisma.merchantMessage.count()).toBe(0);
  expect(await h.prisma.billingAccount.count()).toBe(0);
  expect(h.providers.wecom.callsOf("sendAppMessage")).toHaveLength(0);
  expect(h.providers.wecom.callsOf("sendRobotMessage")).toHaveLength(0);
  expect(h.providers.wechat.callsOf("sendSubscribeMessage")).toHaveLength(0);
  expect(h.providers.sms.callsOf("sendSubscribeFallback")).toHaveLength(0);
});

it("关闭/无在职超管零写，敏感额外字段与重复/跨日事实拒绝；caller回滚后可重放", async () => {
  const value = await input();
  await h.prisma.notifyScene.update({
    where: { sceneKey: "s.receipt_daily_digest" },
    data: { sceneEnabled: false },
  });
  expect(await send(value)).toEqual({ status: "disabled", recipients: 0, created: 0 });
  await h.prisma.notifyScene.update({
    where: { sceneKey: "s.receipt_daily_digest" },
    data: { sceneEnabled: true },
  });
  expect(await send(value)).toEqual({ status: "no_recipients", recipients: 0, created: 0 });
  await h.make.staff({ staffRoleKey: "super_admin" });
  const unsafe = {
    ...value,
    items: [
      {
        ...value.items[0]!,
        bankAccount: "sensitive-account",
        phone: "sensitive-phone",
        openid: "sensitive-openid",
      },
    ],
  };
  await expect(send(unsafe)).rejects.toThrow();
  await expect(send({ ...value, items: [value.items[0]!, value.items[0]!] })).rejects.toThrow(
    "重复",
  );
  await expect(send({ ...value, bizDate: "2026-10-20" })).rejects.toThrow("跨日");
  expect(await h.prisma.notification.count()).toBe(0);
  await expect(
    h.tx.run(async (tx) => {
      expect(await sendReceiptDailyDigest(tx, value, h.deps.assembly)).toEqual({
        status: "sent",
        recipients: 1,
        created: 1,
      });
      throw new Error("fictional receipt digest rollback");
    }),
  ).rejects.toThrow("fictional receipt digest rollback");
  expect(await h.prisma.notification.count()).toBe(0);
  expect(await h.prisma.staffMessage.count()).toBe(0);
  expect(await h.prisma.notificationDelivery.count()).toBe(0);
  expect(await send(value)).toEqual({ status: "sent", recipients: 1, created: 1 });
  expect(await send(value)).toEqual({ status: "sent", recipients: 1, created: 0 });
  const persisted = await h.prisma.notification.findMany();
  expect(JSON.stringify(persisted)).not.toMatch(
    /sensitive-account|sensitive-phone|sensitive-openid/,
  );
});
