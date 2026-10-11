import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";

import { lockRows, uuidv7 } from "../../kernel/index.js";
import {
  assembleForTest,
  createFactories,
  createLedgerHarness,
  seedBillingDeletionFacts,
  testDatabaseUrl,
  useSeededDatabase,
} from "../../testing/index.js";
import type { LedgerHarness } from "../../testing/index.js";
import { billingHistoryPort } from "../../tenant/index.js";
import { deletionGuard, readBillingHistoryFacts } from "../index.js";

const db = useSeededDatabase("services", { label: "billinghist", max: 4 });
const SLOW = 60_000;
const absent = { hasSubscriptionTerm: false, hasBillingOrder: false };
const orderOnly = { hasSubscriptionTerm: false, hasBillingOrder: true };
const both = { hasSubscriptionTerm: true, hasBillingOrder: true };
let prisma: PrismaClient;
let h: LedgerHarness;
let bankRevisionId: string;

beforeAll(async () => {
  prisma = await db.prisma();
  h = createLedgerHarness(prisma);
  // 只为对公付款单补正式配置/审批外键，使用别主体的真实合法历史夹具。
  const owner = await h.make.merchant();
  await h.tx.run((tx) =>
    seedBillingDeletionFacts(tx, h.clock, {
      entityId: owner.entity.id,
      userId: owner.user.id,
    }),
  );
  bankRevisionId = (
    await prisma.financeConfigRevision.findFirstOrThrow({
      where: { configKey: "bank_account" },
      orderBy: { effectiveAt: "desc" },
    })
  ).id;
}, 120_000);

const read = (entityId: string) => h.tx.run((tx) => readBillingHistoryFacts(tx, entityId));
const snapshot = async (entityId: string) => ({
  entity: await prisma.entity.findUnique({ where: { id: entityId } }),
  account: await prisma.billingAccount.findUnique({ where: { entityId } }),
  terms: await prisma.subscriptionTerm.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
  orders: await prisma.billingOrder.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
  payments: await prisma.paymentTxn.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
  history: await prisma.statusTransition.count(),
  audit: await prisma.auditLog.count(),
  outbox: await prisma.outboxEvent.count(),
});

describe("全部计费历史事实", () => {
  it(
    "空主体和无账户主体均无历史；不存在历史不充当主体存在性证明",
    async () => {
      const merchant = await h.make.merchant();
      const entity = await h.make.entity();
      expect(await prisma.billingAccount.findUnique({ where: { entityId: entity.id } })).toBeNull();
      expect(await read(merchant.entity.id)).toEqual(absent);
      expect(await read(entity.id)).toEqual(absent);
      expect(await read(uuidv7())).toEqual(absent);
    },
    SLOW,
  );

  it.each(["scheduled", "active", "ended", "refunded", "cancelled"] as const)(
    "真实 %s 订阅期及其付款单都属于历史",
    async (status) => {
      const entity = await h.make.entity();
      const term = await h.make.subscriptionTerm({ entityId: entity.id, status });
      const order = await prisma.billingOrder.findUniqueOrThrow({
        where: { id: term.sourceBillingOrderId },
      });
      expect(order.entityId).toBe(entity.id);
      expect(await read(entity.id)).toEqual(both);
    },
    SLOW,
  );

  it.each(["pending_payment", "pending_confirmation", "paid", "cancelled", "refunded"] as const)(
    "%s 付款单无论是否收款/退款/履约都属于历史",
    async (status) => {
      const entity = await h.make.entity();
      const order = await h.make.billingOrder({
        entityId: entity.id,
        status,
        ...(status === "pending_confirmation"
          ? {
              channel: "bank_transfer",
              transferState: "proof_submitted",
              bankAccountFinanceConfigRevisionId: bankRevisionId,
            }
          : {}),
      });
      expect(await prisma.subscriptionTerm.count({ where: { entityId: entity.id } })).toBe(0);
      if (status === "paid" || status === "refunded") {
        expect(order.paidPaymentTxnId).not.toBeNull();
        expect(
          await prisma.paymentTxn.findUniqueOrThrow({ where: { id: order.paidPaymentTxnId! } }),
        ).toMatchObject({ entityId: entity.id, status: "succeeded" });
      }
      expect(await read(entity.id)).toEqual(orderOnly);
    },
    SLOW,
  );

  it(
    "别主体全部历史不污染空主体，端口真实实现保持精确归属",
    async () => {
      const empty = await h.make.entity();
      const other = await h.make.entity();
      await h.make.subscriptionTerm({ entityId: other.id, status: "cancelled" });
      const reader = assembleForTest({ entry: "worker" }).port(billingHistoryPort);
      expect(await h.tx.run((tx) => reader.read(tx, empty.id))).toEqual(absent);
      expect(await h.tx.run((tx) => reader.read(tx, other.id))).toEqual(both);
    },
    SLOW,
  );

  it(
    "历史终态与四项未结计数为零并存，不能复用 deletionGuard 判断历史",
    async () => {
      const entity = await h.make.entity();
      await h.make.subscriptionTerm({ entityId: entity.id, status: "ended" });
      await h.make.billingOrder({ entityId: entity.id, status: "cancelled" });
      expect(await h.tx.run((tx) => deletionGuard(tx, entity.id))).toEqual({
        subscription_active: 0,
        payment_open: 0,
        refund_open: 0,
        invoice_open: 0,
      });
      expect(await read(entity.id)).toEqual(both);
    },
    SLOW,
  );

  it(
    "账户仍为无订阅及零余额不掩盖真实历史，也不自动修正缓存",
    async () => {
      const entity = await h.make.entity();
      const account = await h.make.billingAccount({ entityId: entity.id });
      expect(await read(entity.id)).toEqual(absent);
      await h.make.billingOrder({ entityId: entity.id, status: "cancelled" });
      expect(await read(entity.id)).toEqual(orderOnly);
      expect(
        await prisma.billingAccount.findUniqueOrThrow({ where: { entityId: entity.id } }),
      ).toEqual(account);
    },
    SLOW,
  );

  it(
    "调用方未提交事实可见，其他 app 事务不可见，外层失败完整回滚",
    async () => {
      const entity = await h.make.entity();
      const before = await snapshot(entity.id);
      const failure = new Error("rollback billing history fixture");
      await expect(
        h.tx.run(async (tx) => {
          const make = createFactories({ db: tx, clock: h.clock });
          await make.subscriptionTerm({ entityId: entity.id, status: "cancelled" });
          expect(await readBillingHistoryFacts(tx, entity.id)).toEqual(both);
          expect(await read(entity.id)).toEqual(absent);
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await read(entity.id)).toEqual(absent);
      expect(await snapshot(entity.id)).toEqual(before);
    },
    SLOW,
  );

  it(
    "多条历史仍只返回两个 boolean，重复读取全行/时间/审计/事件零变化",
    async () => {
      const entity = await h.make.entity();
      await h.make.subscriptionTerm({ entityId: entity.id, status: "ended" });
      await h.make.billingOrder({ entityId: entity.id, status: "cancelled" });
      await h.make.billingOrder({ entityId: entity.id, status: "refunded" });
      const before = await snapshot(entity.id);
      expect(before.orders.length).toBeGreaterThan(1);
      expect(await read(entity.id)).toEqual(both);
      expect(await read(entity.id)).toEqual(both);
      expect(await snapshot(entity.id)).toEqual(before);
    },
    SLOW,
  );

  it.each(["2020-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"])(
    "付款期限 %s 不过滤历史，也不依赖当前时钟",
    async (expiresAt) => {
      const entity = await h.make.entity();
      await h.make.billingOrder({
        entityId: entity.id,
        status: "pending_payment",
        expiresAt: new Date(expiresAt),
      });
      const original = h.clock.now();
      try {
        h.clock.set(new Date("2100-01-01T00:00:00.000Z"));
        expect(await read(entity.id)).toEqual(orderOnly);
      } finally {
        h.clock.set(original);
      }
    },
    SLOW,
  );

  it(
    "最小合法金额且从未收款的付款单也使历史为真",
    async () => {
      const entity = await h.make.entity();
      const order = await h.make.billingOrder({
        entityId: entity.id,
        status: "pending_payment",
        amountFen: 1,
      });
      expect(order).toMatchObject({ amountFen: 1, paidAmountFen: 0, paidAt: null });
      expect(await read(entity.id)).toEqual(orderOnly);
    },
    SLOW,
  );

  it(
    "独立 app 持有账户行锁时读侧已返回，无账户锁依赖且所有连接收尾",
    async () => {
      const entity = await h.make.entity();
      await h.make.billingAccount({ entityId: entity.id });
      await h.make.billingOrder({ entityId: entity.id, status: "cancelled" });
      let holderPid = 0;
      let readerPid = 0;
      let released = false;
      let signalHeld!: () => void;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      const proceed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const observer = createPrismaClient({
        connectionString: testDatabaseUrl(db.name, { role: null }),
        max: 1,
      });
      const holder = h.tx.run(async (tx) => {
        holderPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        await lockRows(tx, "billing_account", [entity.id], "update");
        signalHeld();
        await proceed;
      });
      // 保留 holder 拒绝供 finally 收集，避免 setup 失败留下未处理拒绝。
      const holderResult = holder.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await Promise.race([
          held,
          holder.then(() => {
            throw new Error("未持锁即退出");
          }),
        ]);
        const [lock] = await observer.$queryRaw<{ held: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks
          WHERE pid = ${holderPid} AND granted
            AND relation = 'billing_account'::regclass AND mode = 'RowShareLock'
        ) AS held`;
        expect(lock?.held).toBe(true);
        const facts = await h.tx.run(async (tx) => {
          readerPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!
            .pid;
          return readBillingHistoryFacts(tx, entity.id);
        });
        expect(readerPid).not.toBe(holderPid);
        expect(released).toBe(false);
        expect(facts).toEqual(orderOnly);
        expect(
          (
            await observer.$queryRaw<{ held: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${holderPid}
          AND granted AND relation = 'billing_account'::regclass
          AND mode = 'RowShareLock') AS held`
          )[0]?.held,
        ).toBe(true);
        released = true;
        release();
        expect(await holderResult).toBeNull();
      } finally {
        release();
        await holderResult;
        await observer.$disconnect();
      }
    },
    SLOW,
  );
});
