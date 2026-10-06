import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyReceipt,
  createPaymentHarness,
  joinPayment,
  pendingPlanOrder,
  snapshotTables,
  transferReceipt,
  useSeededDatabase,
} from "../../testing/index.js";
import type { PaymentHarness } from "../../testing/index.js";
import { billingInvariants } from "../invariants.js";
import { subscriptionInvariants } from "../subscription/invariants.js";
import { paymentInvariants } from "./invariants.js";

const SLOW = 240_000;
const db = useSeededDatabase("services");
let prisma: PrismaClient;
let h: PaymentHarness;
const joined: Awaited<ReturnType<typeof joinPayment>>[] = [];
beforeAll(async () => {
  prisma = await db.prisma();
  h = createPaymentHarness(prisma);
  const url = await db.url();
  for (let n = 0; n < 9; n++) joined.push(await joinPayment(h, url));
}, SLOW);
afterAll(async () => {
  await Promise.all(joined.map((side) => side.close()));
});

describe("付款入账并发（验收 1）", () => {
  it(
    "同一交易十条独立连接，20 轮；只履约一次，三次顺序重放不写任何表",
    async () => {
      for (let round = 0; round < 20; round++) {
        const { entity } = await h.make.merchant({ verified: true });
        const order = await pendingPlanOrder(h, { entityId: entity.id });
        const receipt = await transferReceipt(h, order);
        const outcomes = await Promise.all(
          [h, ...joined].map((side) => applyReceipt(side, receipt)),
        );
        expect(
          outcomes.filter((outcome) => !outcome.replayed),
          `第${round + 1}轮`,
        ).toHaveLength(1);
        for (const outcome of outcomes) expect(outcome.result).toEqual(outcomes[0]?.result);
        expect(await prisma.subscriptionTerm.count({ where: { entityId: entity.id } })).toBe(1);
        expect(await prisma.pointLot.count({ where: { entityId: entity.id } })).toBe(1);
        expect(
          await prisma.ledgerOperation.count({ where: { entityId: entity.id, opType: "fulfill" } }),
        ).toBe(1);
        expect(
          await prisma.outboxEvent.count({
            where: { entityId: entity.id, eventType: "billing_order.paid" },
          }),
        ).toBe(1);
        expect(
          await prisma.statusTransition.count({
            where: { machine: "billing_order", subjectId: order.id },
          }),
        ).toBe(1);
        const tables = [
          "billing_order",
          "payment_txn",
          "billing_account",
          "subscription_term",
          "grant_schedule",
          "point_lot",
          "point_ledger_entry",
          "ledger_operation",
          "subscription_event",
          "outbox_event",
          "status_transition",
          "audit_log",
          "biz_sequence",
          "timer",
        ];
        const settled = await snapshotTables(prisma, tables);
        for (let n = 0; n < 3; n++)
          expect(await applyReceipt(h, receipt)).toEqual({
            result: outcomes[0]?.result,
            replayed: true,
          });
        expect(await snapshotTables(prisma, tables)).toEqual(settled);
        for (const check of [
          ...billingInvariants,
          ...subscriptionInvariants,
          ...paymentInvariants,
        ]) {
          expect(
            await h.tx.run((tx) =>
              check.run!(tx, { entityIds: [entity.id] }, { now: h.clock.now() }),
            ),
            check.code,
          ).toEqual([]);
        }
      }
    },
    SLOW,
  );
});
