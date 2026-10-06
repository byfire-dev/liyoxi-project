import type { PrismaClient } from "@liyoxi/db";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  applyReceipt,
  createPaymentHarness,
  dumpLedger,
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

const db = useSeededDatabase("services");
const SLOW = 600_000;
const seed = Number(process.env.LYX_FC_SEED ?? 20261006);
const numRuns = Number(process.env.LYX_FC_RUNS ?? 10);
let prisma: PrismaClient;
let h: PaymentHarness;
const joined: Awaited<ReturnType<typeof joinPayment>>[] = [];
beforeAll(async () => {
  prisma = await db.prisma();
  h = createPaymentHarness(prisma);
  const url = await db.url();
  for (let n = 0; n < 3; n++) joined.push(await joinPayment(h, url));
}, SLOW);
afterAll(async () => {
  await Promise.all(joined.map((side) => side.close()));
});

it(
  "任意实付、月数、并发度和重放次数：结果相同、计划合计=实付、首月成本=分摊，不变量为零",
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          amountFen: fc.integer({ min: 1, max: 20_000_000 }),
          months: fc.constantFrom(1, 3, 12),
          concurrency: fc.integer({ min: 1, max: 4 }),
          replays: fc.integer({ min: 1, max: 5 }),
          queued: fc.boolean(),
        }),
        async ({ amountFen, months, concurrency, replays, queued }) => {
          const { entity } = await h.make.merchant({ verified: true });
          if (queued) {
            const prior = await pendingPlanOrder(h, { entityId: entity.id });
            await applyReceipt(h, await transferReceipt(h, prior));
          }
          const order = await pendingPlanOrder(h, { entityId: entity.id, amountFen, months });
          const receipt = await transferReceipt(h, order);
          const outcomes = await Promise.all(
            [h, ...joined].slice(0, concurrency).map((side) => applyReceipt(side, receipt)),
          );
          expect(outcomes.filter((outcome) => !outcome.replayed)).toHaveLength(1);
          for (const outcome of outcomes) expect(outcome.result).toEqual(outcomes[0]?.result);
          expect(outcomes[0]?.result).toMatchObject({
            status: "applied",
            fulfillment: { status: "done", queuedBehindActive: queued },
          });
          const term = await prisma.subscriptionTerm.findUniqueOrThrow({
            where: { sourceBillingOrderId: order.id },
          });
          const schedules = await prisma.grantSchedule.findMany({
            where: { subscriptionTermId: term.id },
            orderBy: { monthNo: "asc" },
          });
          expect(schedules.map((row) => row.valueFen).reduce((a, b) => a + b, 0)).toBe(amountFen);
          if (!queued)
            expect(
              (
                await prisma.pointLot.findUniqueOrThrow({
                  where: { id: schedules[0]!.pointLotId! },
                })
              ).costBasisFen,
            ).toBe(schedules[0]?.valueFen);
          const ledger = await dumpLedger(prisma, entity.id);
          const tables = [
            "billing_order",
            "payment_txn",
            "status_transition",
            "outbox_event",
            "audit_log",
            "biz_sequence",
          ];
          const settled = await snapshotTables(prisma, tables);
          for (let n = 0; n < replays; n++)
            expect(await applyReceipt(h, receipt)).toEqual({
              result: outcomes[0]?.result,
              replayed: true,
            });
          expect(await dumpLedger(prisma, entity.id)).toEqual(ledger);
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
        },
      ),
      { seed, numRuns },
    );
  },
  SLOW,
);
