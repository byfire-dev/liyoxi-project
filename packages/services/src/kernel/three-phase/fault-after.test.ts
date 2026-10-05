import { describe, expect, it } from "vitest";

import { CallInterruptedError } from "../../testing/index.js";
import { IDEMPOTENCY_LEASE_MS } from "../idempotency.js";
import { attemptOf, SLOW, useThreePhase } from "./__fixtures__/harness.js";

// 验收第 3 条：外呼后中断。外呼成功、结果还没落库，进程断了。
// 续做后结果落库一次；同键再请求直接重放（重放标记照 W0-13：上下文的 replayed 为真；登记了脱敏路径的另带 replayed: true）。

const h = useThreePhase();

describe("三段式：外呼后中断", () => {
  it(
    "续做后结果落库一次；同键再请求直接重放，不外呼、不再落结果",
    async () => {
      const attempt = attemptOf("after");
      h.interrupter.arm("after");
      const interrupted = await h.send("multi_tx", attempt).catch((error: unknown) => error);
      expect(interrupted).toBeInstanceOf(CallInterruptedError);
      // 应答已经回来了（挂在中断上），本地没落
      const answered = (interrupted as CallInterruptedError).result as {
        value: { prepayId: string };
      };
      expect(await h.row(attempt.no)).toMatchObject({
        status: "pending",
        prepayId: null,
        settled: 0,
      });
      expect(await h.idemRow(attempt)).toMatchObject({ state: "in_progress", result: null });

      h.clock.advance(IDEMPOTENCY_LEASE_MS);
      const { result } = await h.send("multi_tx", attempt);
      expect(result.prepayId).toBe(answered.value.prepayId);
      expect(await h.row(attempt.no)).toMatchObject({ status: "prepaid", settled: 1 });
      expect(await h.idemRow(attempt)).toMatchObject({ state: "done", result });
      const callsAfterResume = h.calls(attempt.no);
      expect(callsAfterResume).toBe(2);

      // 同键再来三次：重放
      for (let again = 0; again < 3; again += 1) {
        const replay = await h.send("multi_tx", attempt);
        expect(replay.result).toEqual(result);
        expect(replay.idem).toMatchObject({ used: true, replayed: true });
      }
      expect(h.calls(attempt.no)).toBe(callsAfterResume);
      expect(await h.row(attempt.no)).toMatchObject({ settled: 1 });
    },
    SLOW,
  );

  it(
    "登记了脱敏路径：首次返回完整结果，幂等记录里调起参数是 null，重放带 replayed: true",
    async () => {
      const attempt = attemptOf("after-redact", { redact: ["payParams"] });
      h.interrupter.arm("after");
      await expect(h.send("local_first", attempt)).rejects.toBeInstanceOf(CallInterruptedError);
      h.clock.advance(IDEMPOTENCY_LEASE_MS);

      const { result } = await h.send("local_first", attempt);
      expect(result.payParams).toEqual(expect.stringContaining("prepay_id="));
      expect((await h.idemRow(attempt))?.result).toEqual({ ...result, payParams: null });

      const replay = await h.send("local_first", attempt);
      expect(replay.result).toEqual({ ...result, payParams: null, replayed: true });
      expect(replay.idem.replayed).toBe(true);
      expect(await h.row(attempt.no)).toMatchObject({ settled: 1 });
    },
    SLOW,
  );

  it(
    "落结果的事务没提交（settle 之后、提交之前出错）：占用留着，续做后结果仍只落一次",
    async () => {
      const attempt = attemptOf("after-rollback");
      // 让末个事务在提交前失败：把探针表的行先锁住是做不到“必然失败”的，这里直接让 settle 抛一个非业务错误
      const crash = new Error("进程断在提交之前");
      const broken = h.threePhase.run(
        {
          external: async () => ({ prepayId: "fake-never-settled" }),
          settle: async (tx) => {
            await tx.$executeRaw`
              INSERT INTO lyx_sample_prepay (out_trade_no, status, settled)
              VALUES (${attempt.no}, 'prepaid', 1)`;
            throw crash;
          },
        },
        { idem: h.request(attempt) },
      );
      await expect(broken).rejects.toBe(crash);
      // 事务回滚：业务结果没留下，占用回到 in_progress（没被删，也没变 done）
      expect(await h.row(attempt.no)).toBeUndefined();
      expect(await h.idemRow(attempt)).toMatchObject({ state: "in_progress", result: null });

      h.clock.advance(IDEMPOTENCY_LEASE_MS);
      const { result } = await h.send("external_first", attempt);
      expect(await h.row(attempt.no)).toMatchObject({ status: "prepaid", settled: 1 });
      expect(await h.idemRow(attempt)).toMatchObject({ state: "done", result });
    },
    SLOW,
  );
});
