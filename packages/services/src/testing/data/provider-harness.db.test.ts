// 假 Provider 支架的用例（任务书 W0-25 第 7 节第 5 条）。只有“事务里外呼”一条连库：要一个真的事务。
import { describe, expect, it } from "vitest";

import { createTxRunner, KernelViolation } from "../../kernel/index.js";
import { PROVIDER_METHODS, PROVIDER_NAMES } from "../../providers/types.js";
import type { Providers } from "../../providers/types.js";
import { createClock, createProviderHarness, useTestDatabase } from "../index.js";
import type { ProviderCallName } from "../index.js";

const db = useTestDatabase("services");
const TIMEOUT = { timeout: 120_000 };

describe("createProviderHarness", () => {
  it("十二个替身的调用合成一条时间线：按先后编号，带入参与时刻；能按接口、按方法筛", async () => {
    const clock = createClock();
    const harness = createProviderHarness({ clock });
    // 它是一份 Providers：要 Providers 的地方直接传
    const providers: Providers = harness.providers;
    harness.assertNoCalls();

    await providers.wechat.checkText({ content: "开业大吉", scene: "profile", openid: "o-1" });
    clock.advance(1_000);
    await providers.sms.sendActivationCode({ phone: "13800135678", code: "246810" });
    await providers.wechat.checkText({ content: "第二条", scene: "profile", openid: "o-1" });

    expect(harness.callNames()).toEqual([
      "wechat.checkText",
      "sms.sendActivationCode",
      "wechat.checkText",
    ]);
    harness.assertCalls(["wechat.checkText", "sms.sendActivationCode", "wechat.checkText"]);
    expect(harness.calls().map((call) => call.seq)).toEqual([1, 2, 3]);
    expect(harness.calls("wechat").map((call) => call.seq)).toEqual([1, 3]);
    expect(harness.calls("sms.sendActivationCode")).toEqual([
      {
        seq: 2,
        name: "sms.sendActivationCode",
        provider: "sms",
        method: "sendActivationCode",
        input: { phone: "13800135678", code: "246810" },
        at: new Date(clock.now()),
      },
    ]);
    expect(harness.lastCall("wechat.checkText")?.input).toMatchObject({ content: "第二条" });
    expect(harness.lastCall()?.seq).toBe(3);
    expect(harness.lastCall("mail")).toBeUndefined();
    // 替身自己的记录与编排入口照旧
    expect(harness.providers.sms.lastActivationCode("13800135678")).toBe("246810");
    expect(harness.providers.wechat.callsOf("checkText")).toHaveLength(2);
  });

  it("断言不符：说明里列出期望与实际", async () => {
    const harness = createProviderHarness();
    await harness.providers.sms.sendActivationCode({ phone: "13800135678", code: "1" });
    expect(() => harness.assertCalls(["wechat.checkText"])).toThrow(
      "外呼对不上。\n  期望：wechat.checkText\n  实际：sms.sendActivationCode",
    );
    expect(() => harness.assertNoCalls()).toThrow(
      /期望：（没有）\n {2}实际：sms\.sendActivationCode/,
    );
  });

  it("注入的失败照记；延迟的应答拨了时钟、tick 之后才回来；reset 清空时间线", async () => {
    const clock = createClock();
    const harness = createProviderHarness({ clock });
    const { sms } = harness.providers;

    sms.failNext("sendActivationCode", { reason: "rejected" });
    expect(await sms.sendActivationCode({ phone: "13800135678", code: "1" })).toMatchObject({
      ok: false,
      reason: "rejected",
    });

    sms.delayNext("sendActivationCode", 5_000);
    let settled = false;
    const pending = sms.sendActivationCode({ phone: "13800135678", code: "2" }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect([settled, harness.tick()]).toEqual([false, 0]);
    clock.advance(5_000);
    expect(harness.tick()).toBe(1);
    expect(await pending).toEqual({ ok: true, value: undefined });
    expect(harness.callNames()).toEqual(["sms.sendActivationCode", "sms.sendActivationCode"]);

    harness.reset();
    harness.assertNoCalls();
    expect(sms.calls).toEqual([]);
    // 替身里别的状态不动：发出去的那条短信还在
    expect(sms.sent).toHaveLength(1);
  });

  it("十二个接口的每个方法都经时间线：名字与方法清单一一对应", async () => {
    const harness = createProviderHarness();
    const expected: ProviderCallName[] = [];
    for (const provider of PROVIDER_NAMES) {
      for (const method of PROVIDER_METHODS[provider]) {
        expected.push(`${provider}.${method}` as ProviderCallName);
        const call = (harness.providers[provider] as unknown as Record<string, unknown>)[method];
        // 入参随便给：这里只看有没有记上。替身拿到不合规的入参可能抛错或返回失败，都不管
        await Promise.resolve()
          .then(() => (call as (input: unknown) => unknown)({}))
          .catch(() => undefined);
      }
    }
    expect(harness.callNames()).toEqual(expected);
  });

  it("事务里外呼即抛错，不记进时间线；事务外照常", TIMEOUT, async () => {
    const tx = createTxRunner({ prisma: await db.prisma(), appEnv: "test" });
    const harness = createProviderHarness();
    const send = () =>
      harness.providers.sms.sendActivationCode({ phone: "13800135678", code: "1" });

    await expect(tx.run(() => send())).rejects.toBeInstanceOf(KernelViolation);
    harness.assertNoCalls();
    expect(harness.providers.sms.sent).toEqual([]);

    expect(await send()).toEqual({ ok: true, value: undefined });
    harness.assertCalls(["sms.sendActivationCode"]);

    // 关掉这道检查的支架：事务里也放行（只在专门验别处的防线时用）
    const loose = createProviderHarness({ guardTransaction: false });
    await tx.run(() => loose.providers.sms.sendActivationCode({ phone: "13800135678", code: "2" }));
    loose.assertCalls(["sms.sendActivationCode"]);
  });
});
