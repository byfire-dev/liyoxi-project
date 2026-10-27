import { afterAll, beforeAll, expect, it } from "vitest";
import fc from "fast-check";
import { createIdentityContext } from "../../kernel/index.js";
import { useSeededDatabase } from "../../testing/index.js";
import { createRefundHarness } from "./test.fixture.js";
import type { RefundHarness } from "./test.fixture.js";
import { recordRefundResult } from "./result.js";
import { refundInvariants } from "./invariants.js";
const handle = useSeededDatabase("services", { max: 1, label: "refundprop" });
let h: RefundHarness;
beforeAll(async () => {
  h = createRefundHarness(await handle.prisma());
}, 60_000);
afterAll(() => h?.close());
it("固定种子乱序渠道序列：首次成功是唯一累计点，后来非成功不能抹除现金，回收恒一次", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom("PROCESSING", "CLOSED", "ABNORMAL", "SUCCESS"), {
        minLength: 3,
        maxLength: 7,
      }),
      async (statuses) => {
        const r = await h.approved();
        await h.execute(r);
        const txn = await h.prisma.refundTxn.findFirstOrThrow({
          where: { refundRequestId: r.created.refundRequestId },
        });
        let credited = false;
        for (const status of [...statuses, "SUCCESS"] as const) {
          // 独立模型只按外部成功事实累计一次，不根据生产当前状态推导余额。
          credited ||= status === "SUCCESS";
          await h.tx.run((tx) =>
            recordRefundResult(
              tx,
              h.deps,
              createIdentityContext({ actor: { type: "system", job: "lyxtest.refund_property" } }),
              {
                refundTxnId: txn.id,
                detectedBy: "query",
                fact: {
                  outRefundNo: txn.outRefundNo,
                  outTradeNo: r.receipt.outTradeNo,
                  refundId: txn.channelRefundNo!,
                  refundFen: txn.amountFen,
                  status,
                  ...(status === "SUCCESS" ? { successAt: h.clock.now() } : {}),
                },
              },
            ),
          );
          expect(
            (await h.prisma.paymentTxn.findUniqueOrThrow({ where: { id: r.receipt.id } }))
              .refundedFen,
          ).toBe(credited ? txn.amountFen : 0);
          expect(
            (await h.prisma.refundTxn.findUniqueOrThrow({ where: { id: txn.id } })).status ===
              "succeeded",
          ).toBe(credited);
          expect(
            await h.prisma.ledgerOperation.count({
              where: { opType: "revoke", refId: r.created.refundRequestId },
            }),
          ).toBe(1);
          for (const invariant of refundInvariants)
            expect(
              await h.tx.run((tx) =>
                invariant.run!(tx, { entityIds: [r.entity.id] }, { now: h.clock.now() }),
              ),
              invariant.code,
            ).toEqual([]);
        }
      },
    ),
    { numRuns: 4, seed: 20261018, endOnFailure: true },
  );
}, 120_000);
