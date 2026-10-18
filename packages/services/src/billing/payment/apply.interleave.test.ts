import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  applyReceipt,
  createPaymentHarness,
  joinPayment,
  pendingPlanOrder,
  transferReceipt,
  useSeededDatabase,
} from "../../testing/index.js";
import type { PaymentHarness } from "../../testing/index.js";
import { prepareClosedBillingDays } from "../../testing/billing-daily.js";
import { billingInvariants } from "../invariants.js";
import { subscriptionInvariants } from "../subscription/invariants.js";
import { advanceDueAccounts } from "../sweep.js";
import { paymentInvariants } from "./invariants.js";

const db = useSeededDatabase("services");
const SLOW = 600_000;
let prisma: PrismaClient;
let h: PaymentHarness;
let sweeper: Awaited<ReturnType<typeof joinPayment>>;
beforeAll(async () => {
  prisma = await db.prisma();
  h = createPaymentHarness(prisma);
  sweeper = await joinPayment(h, await db.url());
}, SLOW);
afterAll(async () => {
  await sweeper?.close();
});

it(
  "付款先锁付款单再锁账户，与真实 advance 扫描交错 200 轮：无死锁或锁序违规",
  async () => {
    for (let round = 0; round < 200; round++) {
      h.clock.set(new Date("2026-01-05T12:00:00+08:00"));
      const { entity } = await h.make.merchant({ verified: true });
      const first = await pendingPlanOrder(h, { entityId: entity.id });
      await applyReceipt(h, await transferReceipt(h, first));
      const second = await pendingPlanOrder(h, { entityId: entity.id });
      const receipt = await transferReceipt(h, second);
      h.clock.set(new Date("2026-02-05T00:00:30+08:00"));
      const [outcome, scan] = await Promise.all([
        applyReceipt(h, receipt),
        advanceDueAccounts({
          db: sweeper.prisma,
          tx: sweeper.tx,
          clock: sweeper.clock,
          ledger: sweeper.ledger,
        }),
      ]);
      expect(scan.failed, `第${round + 1}轮`).toEqual([]);
      expect(outcome.result).toMatchObject({
        status: "applied",
        fulfillment: { status: "done", queuedBehindActive: false },
      });
      const terms = await prisma.subscriptionTerm.findMany({
        where: { entityId: entity.id },
        orderBy: { termNo: "asc" },
      });
      expect(terms.map((term) => [term.status, term.origin])).toEqual([
        ["ended", "new"],
        ["active", "resume"],
      ]);
      expect(
        await prisma.ledgerOperation.count({ where: { entityId: entity.id, opType: "expire" } }),
      ).toBe(1);
      await prepareClosedBillingDays(h, entity.id);
      for (const check of [...billingInvariants, ...subscriptionInvariants, ...paymentInvariants]) {
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
