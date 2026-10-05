import { describe, expect, it } from "vitest";

import { CallInterruptedError, samplePrepay } from "../../testing/index.js";
import type { SamplePrepayResult } from "../../testing/index.js";
import { gate } from "../__fixtures__/db.js";
import { AppError } from "../errors.js";
import { IDEMPOTENCY_LEASE_MS } from "../idempotency.js";
import { attemptOf, SLOW, useThreePhase } from "./__fixtures__/harness.js";
import type { Attempt } from "./__fixtures__/harness.js";

// 验收第 5 条（甲类的并发测试）：占用过期后 10 个并发的重复请求只有一个续做，
// 其余得 IDEMPOTENCY_IN_PROGRESS 或拿到同一份结果；重复 20 轮。
// 另有三条定序的交错：占用过期被接手之后，原来那一方才从外呼回来。

const ROUNDS = 20;
const PARALLEL = 10;

// 连接数给够：10 个请求同时各开一个事务，外加用例自己查库的
const h = useThreePhase({ max: PARALLEL + 2 });

/** 发一次请求，外呼卡在一道门上：门开之前它一直“在外呼中” */
function sendHeld(attempt: Attempt, answer?: () => never) {
  const reached = gate();
  const release = gate();
  const useCase = samplePrepay(
    "multi_tx",
    {
      wechatPay: h.wechatPay,
      call: async (external) => {
        reached.open();
        await release.opened;
        return answer ? answer() : external();
      },
    },
    { outTradeNo: attempt.no, amountFen: 100, payerOpenid: "o-sample" },
  );
  const idem = h.request(attempt);
  const settled = h.threePhase.run(useCase, { idem }).then(
    (result) => ({ result, idem }),
    (error: unknown) => ({ error, idem }),
  );
  return { reached: reached.opened, release: release.open, settled };
}

describe("三段式：并发抢占（验收 5）", () => {
  it(
    `占用过期后 ${PARALLEL} 个并发的重复请求，${ROUNDS} 轮：只有一个续做，外呼一次，结果一份`,
    async () => {
      const tally = { resumed: 0, replayed: 0, inProgress: 0 };
      for (let round = 0; round < ROUNDS; round += 1) {
        const label = `第 ${round + 1} 轮`;
        const attempt = attemptOf(`race-${round}`);
        h.interrupter.arm("before");
        await expect(h.send("multi_tx", attempt)).rejects.toBeInstanceOf(CallInterruptedError);
        h.clock.advance(IDEMPOTENCY_LEASE_MS);

        const contexts = Array.from({ length: PARALLEL }, () => h.request(attempt));
        const outcomes = await Promise.allSettled(
          contexts.map((idem) => h.send("multi_tx", attempt, idem)),
        );
        const results: SamplePrepayResult[] = [];
        for (const outcome of outcomes) {
          if (outcome.status === "fulfilled") {
            results.push(outcome.value.result);
          } else {
            expect(outcome.reason, label).toMatchObject({
              name: "AppError",
              error: "IDEMPOTENCY_IN_PROGRESS",
            });
            tally.inProgress += 1;
          }
        }
        // 只有一个续做；别的成功的都是重放，拿到同一份结果
        const fresh = outcomes.filter(
          (outcome) => outcome.status === "fulfilled" && !outcome.value.idem.replayed,
        );
        expect(fresh, label).toHaveLength(1);
        // 逐个比内容：重放的结果从 jsonb 读回来，键的次序与首次返回的不一定相同
        for (const result of results) expect(result, label).toEqual(results[0]);
        expect(h.calls(attempt.no), label).toBe(1);
        expect(await h.row(attempt.no), label).toMatchObject({ status: "prepaid", settled: 1 });
        expect(await h.idemRow(attempt), label).toMatchObject({
          state: "done",
          result: results[0],
        });
        tally.resumed += 1;
        tally.replayed += results.length - 1;
      }
      expect(tally.resumed).toBe(ROUNDS);
      expect(tally.replayed + tally.inProgress).toBe(ROUNDS * (PARALLEL - 1));
    },
    SLOW,
  );
});

describe("三段式：占用过期被接手之后，原来那一方才回来", () => {
  it(
    "接手的一方已经写完：原来那一方不再落结果，拿到同一份结果",
    async () => {
      const attempt = attemptOf("stale-done");
      const first = sendHeld(attempt);
      await first.reached;
      h.clock.advance(IDEMPOTENCY_LEASE_MS);
      const taker = await h.send("multi_tx", attempt);
      expect(await h.row(attempt.no)).toMatchObject({ settled: 1 });

      first.release();
      const late = await first.settled;
      expect(late).toMatchObject({ result: taker.result, idem: { replayed: true } });
      expect(await h.row(attempt.no)).toMatchObject({ status: "prepaid", settled: 1 });
      expect(await h.idemRow(attempt)).toMatchObject({ state: "done", result: taker.result });
    },
    SLOW,
  );

  it(
    "接手的一方还在外呼：原来那一方得 IDEMPOTENCY_IN_PROGRESS，不落结果；接手的一方照常写完",
    async () => {
      const attempt = attemptOf("stale-busy");
      const first = sendHeld(attempt);
      await first.reached;
      h.clock.advance(IDEMPOTENCY_LEASE_MS);
      const taker = sendHeld(attempt);
      await taker.reached;

      first.release();
      expect(await first.settled).toMatchObject({ error: { error: "IDEMPOTENCY_IN_PROGRESS" } });
      expect(await h.row(attempt.no)).toMatchObject({ status: "pending", settled: 0 });

      taker.release();
      const done = await taker.settled;
      expect(done).toMatchObject({ result: { outTradeNo: attempt.no }, idem: { replayed: false } });
      expect(await h.row(attempt.no)).toMatchObject({ status: "prepaid", settled: 1 });
      expect(await h.idemRow(attempt)).toMatchObject({ state: "done" });
    },
    SLOW,
  );

  it(
    "原来那一方外呼失败：占用已经不是它的，它不补偿、不释放；接手的一方不受影响",
    async () => {
      const attempt = attemptOf("stale-fail");
      const failure = new AppError("PROVIDER_UNAVAILABLE");
      const first = sendHeld(attempt, () => {
        throw failure;
      });
      await first.reached;
      h.clock.advance(IDEMPOTENCY_LEASE_MS);
      const taker = sendHeld(attempt);
      await taker.reached;

      first.release();
      expect(await first.settled).toMatchObject({ error: failure });
      // 没被标成 closed，占用也还在接手的一方手里
      expect(await h.row(attempt.no)).toMatchObject({ status: "pending" });
      expect(await h.idemRow(attempt)).toMatchObject({ state: "in_progress" });

      taker.release();
      expect(await taker.settled).toMatchObject({ result: { outTradeNo: attempt.no } });
      expect(await h.row(attempt.no)).toMatchObject({ status: "prepaid", settled: 1 });
    },
    SLOW,
  );
});
