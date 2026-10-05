import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CallInterruptedError, createCallInterrupter, samplePrepay } from "../../testing/index.js";
import type { InterruptPoint, SamplePrepayResult } from "../../testing/index.js";
import { failed } from "../../providers/types.js";
import { IDEMPOTENCY_LEASE_MS } from "../idempotency.js";
import { attemptOf, SLOW, useThreePhase } from "./__fixtures__/harness.js";

// 甲类的性质测试：同一个键上任意次序的“请求（可带外呼前、中、后中断，外部失败，应答丢失）”与“拨钟”，
// 每一步的结果都与一个三态的模型（无记录、占用到某时刻、已完成）一致；业务结果至多落一次；
// 完成之后每次请求都重放同一份结果，不再外呼。连真库，每一轮一个新的键。
// 轮次与种子的约定同别的性质测试，连库所以缺省轮次少：
//   LYX_FC_RUNS=500 LYX_FC_SEED=42 pnpm --filter @liyoxi/services exec vitest run src/kernel/three-phase/three-phase.property.test.ts
const runs = {
  numRuns: Number(process.env.LYX_FC_RUNS ?? 40),
  seed: Number(process.env.LYX_FC_SEED ?? 20261005),
};

const h = useThreePhase();

type Fault = InterruptPoint | "failed" | "lost" | "none";
type Step = { send: Fault } | { advance: number };
type Model =
  | { state: "none" }
  | { state: "occupied"; until: number }
  | { state: "done"; result: SamplePrepayResult };

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      send: fc.constantFrom<Fault>("none", "before", "during", "after", "failed", "lost"),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      advance: fc.constantFrom(1, 1_000, IDEMPOTENCY_LEASE_MS - 1, IDEMPOTENCY_LEASE_MS, 45_000),
    }),
  },
);

/** 发一次请求：这一次的故障只作用在这一次的外呼上（没走到外呼就不生效） */
async function send(attempt: ReturnType<typeof attemptOf>, fault: Fault) {
  const interrupter = createCallInterrupter();
  if (fault === "before" || fault === "during" || fault === "after") interrupter.arm(fault);
  const useCase = samplePrepay(
    "local_first",
    {
      wechatPay: h.wechatPay,
      call: (external) =>
        interrupter.call(async () => {
          if (fault === "failed") return failed("unavailable", "注入：外部没办成") as never;
          const answer = await external();
          return fault === "lost" ? (failed("unavailable", "注入：应答丢了") as never) : answer;
        }),
    },
    { outTradeNo: attempt.no, amountFen: 100, payerOpenid: "o-sample" },
  );
  const idem = h.request(attempt);
  const outcome: { result?: SamplePrepayResult; error?: unknown } = await h.threePhase
    .run(useCase, { idem })
    .then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
  await interrupter.inFlight();
  return { ...outcome, replayed: idem.replayed };
}

describe("三段式：性质", () => {
  it(
    "任意次序的中断、失败、拨钟与重复请求：每一步与模型一致，业务结果至多落一次",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 8 }), async (steps) => {
          const attempt = attemptOf("prop");
          let model: Model = { state: "none" };
          for (const [index, current] of steps.entries()) {
            const label = `第 ${index + 1} 步 ${JSON.stringify(current)}，此前 ${JSON.stringify(model)}`;
            if ("advance" in current) {
              h.clock.advance(current.advance);
              continue;
            }
            const now = h.clock.now().getTime();
            const callsBefore = h.calls(attempt.no);
            const got = await send(attempt, current.send);

            if (model.state === "done") {
              expect(got, label).toEqual({ result: model.result, replayed: true });
              expect(h.calls(attempt.no), label).toBe(callsBefore);
            } else if (model.state === "occupied" && now < model.until) {
              expect(got.error, label).toMatchObject({ error: "IDEMPOTENCY_IN_PROGRESS" });
              expect(h.calls(attempt.no), label).toBe(callsBefore);
            } else if (current.send === "none") {
              expect(got.error, label).toBeUndefined();
              expect(got.replayed, label).toBe(false);
              model = { state: "done", result: got.result as SamplePrepayResult };
            } else if (current.send === "failed" || current.send === "lost") {
              expect(got.error, label).toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
              model = { state: "none" };
            } else {
              expect(got.error, label).toBeInstanceOf(CallInterruptedError);
              model = { state: "occupied", until: now + IDEMPOTENCY_LEASE_MS };
            }

            // 库里的样子跟着模型走
            const [row, idem] = [await h.row(attempt.no), await h.idemRow(attempt)];
            if (model.state === "none") {
              expect({ row, idem }, label).toEqual({ row: undefined, idem: null });
            } else if (model.state === "occupied") {
              expect(row, label).toMatchObject({ status: "pending", settled: 0 });
              expect(idem, label).toMatchObject({
                state: "in_progress",
                lockedUntil: new Date(model.until),
              });
            } else {
              expect(row, label).toMatchObject({
                status: "prepaid",
                settled: 1,
                prepayId: h.wechatPay.orders.get(attempt.no)?.prepayId,
              });
              expect(idem, label).toMatchObject({ state: "done", result: model.result });
            }
          }
        }),
        runs,
      );
    },
    SLOW,
  );
});
