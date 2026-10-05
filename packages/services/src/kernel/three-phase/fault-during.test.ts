import { describe, expect, it } from "vitest";

import { CallInterruptedError } from "../../testing/index.js";
import { IDEMPOTENCY_LEASE_MS } from "../idempotency.js";
import { attemptOf, SLOW, useThreePhase } from "./__fixtures__/harness.js";

// 验收第 2 条：外呼中中断。请求发出去了、结果不知道（超时、连接断开就是这样）。
// 续做用同一个商户单号再呼；替身侧同号只生效一次；业务结果一份。

const h = useThreePhase();

describe("三段式：外呼中中断", () => {
  it(
    "外部已处理、调用方不知道；续做用同一个外部幂等号再呼，同号只生效一次，结果一份",
    async () => {
      const attempt = attemptOf("during");
      h.interrupter.arm("during");
      await expect(h.send("multi_tx", attempt)).rejects.toBeInstanceOf(CallInterruptedError);
      await h.interrupter.inFlight();

      // 外部一侧已经下了单；本地只有意图，占用还在
      expect(h.calls(attempt.no)).toBe(1);
      const placed = h.wechatPay.orders.get(attempt.no);
      expect(placed).toBeDefined();
      expect(await h.row(attempt.no)).toMatchObject({ status: "pending", settled: 0 });
      expect(await h.idemRow(attempt)).toMatchObject({ state: "in_progress" });

      h.clock.advance(IDEMPOTENCY_LEASE_MS);
      const { result } = await h.send("multi_tx", attempt);

      // 再呼了一次，用的是同一个单号；外部侧还是那一单
      const sent = h.wechatPay.callsOf("createJsapiOrder").map((call) => call.input);
      expect(
        sent.filter((input) => (input as { outTradeNo: string }).outTradeNo === attempt.no),
      ).toHaveLength(2);
      expect([...h.wechatPay.orders.keys()].filter((no) => no === attempt.no)).toHaveLength(1);
      expect(result.prepayId).toBe(placed?.prepayId);
      expect(await h.row(attempt.no)).toMatchObject({
        status: "prepaid",
        prepayId: placed?.prepayId,
        settled: 1,
      });
      expect(await h.idemRow(attempt)).toMatchObject({ state: "done", result });
    },
    SLOW,
  );

  it(
    "应答丢了、用例报成“外部不可用”（业务失败）：补偿并释放占用，同键直接重试，同号仍只生效一次",
    async () => {
      const attempt = attemptOf("lost");
      h.wechatPay.loseResponseNext("createJsapiOrder");
      await expect(h.send("multi_tx", attempt)).rejects.toMatchObject({
        name: "AppError",
        error: "PROVIDER_UNAVAILABLE",
      });
      // 外部其实下了单；本地的尝试标成 closed，占用不留
      expect(h.wechatPay.orders.has(attempt.no)).toBe(true);
      expect(await h.row(attempt.no)).toMatchObject({ status: "closed", settled: 0 });
      expect(await h.idemRow(attempt)).toBeNull();

      // 不用等 30 秒：同一个键马上重试
      const { result, idem } = await h.send("multi_tx", attempt);
      expect(idem.replayed).toBe(false);
      expect(h.calls(attempt.no)).toBe(2);
      expect(result.prepayId).toBe(h.wechatPay.orders.get(attempt.no)?.prepayId);
      expect(await h.row(attempt.no)).toMatchObject({ status: "prepaid", settled: 1 });
    },
    SLOW,
  );
});
