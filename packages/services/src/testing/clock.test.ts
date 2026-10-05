import { describe, expect, it } from "vitest";

import { createClock, DEFAULT_CLOCK_START } from "./clock.js";
import { createFakeProviders } from "./providers/index.js";
import type { FakeClock } from "./providers/index.js";

// 可拨时钟（W0-05b 任务书 第 7 节第 7 条）：advance、set 后 now() 符合预期；不拨就不走。

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("可拨时钟", () => {
  it("不拨就不走：真实时间过去了，now() 还是原来的时刻", async () => {
    const clock = createClock();
    const before = clock.now();
    await sleep(30);
    expect(clock.now().getTime()).toBe(before.getTime());
    expect(before.toISOString()).toBe(DEFAULT_CLOCK_START);
  });

  it("advance：往前拨多少毫秒，now() 就前进多少，可以累加", () => {
    const clock = createClock(new Date("2026-03-01T00:00:00.000Z"));
    clock.advance(1_500);
    expect(clock.now().toISOString()).toBe("2026-03-01T00:00:01.500Z");
    clock.advance(24 * 60 * 60 * 1000);
    expect(clock.now().toISOString()).toBe("2026-03-02T00:00:01.500Z");
    clock.advance(0);
    expect(clock.now().toISOString()).toBe("2026-03-02T00:00:01.500Z");
  });

  it("set：直接拨到某个时刻，可以往回拨；之后的 advance 从新时刻算", () => {
    const clock = createClock();
    clock.set(new Date("2027-12-31T15:59:59.999Z"));
    expect(clock.now().toISOString()).toBe("2027-12-31T15:59:59.999Z");
    clock.advance(1);
    expect(clock.now().toISOString()).toBe("2027-12-31T16:00:00.000Z");
    clock.set(new Date("2020-01-01T00:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });

  it("拿到的 Date 与时钟互不牵连：改返回值不动时钟，改传入的起点、目标也不动时钟", () => {
    const start = new Date("2026-06-01T00:00:00.000Z");
    const clock = createClock(start);
    start.setUTCFullYear(1999);
    clock.now().setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe("2026-06-01T00:00:00.000Z");
    const target = new Date("2026-07-01T00:00:00.000Z");
    clock.set(target);
    target.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(clock.now()).not.toBe(clock.now());
  });

  it("写错的参数即抛错，时钟不动", () => {
    const clock = createClock();
    for (const ms of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => clock.advance(ms)).toThrow(RangeError);
    }
    expect(() => clock.set(new Date("不是日期"))).toThrow(RangeError);
    expect(() => createClock(new Date(Number.NaN))).toThrow(RangeError);
    expect(clock.now().toISOString()).toBe(DEFAULT_CLOCK_START);
  });

  it("与替身用的时钟同形：能直接传给十二个替身，拨动之后替身看到的是新时刻", async () => {
    const clock = createClock();
    const asFake: FakeClock = clock;
    const fakes = createFakeProviders({ clock: asFake });
    await fakes.sms.sendActivationCode({ phone: "13800000000", code: "123456" });
    clock.advance(60_000);
    await fakes.sms.sendActivationCode({ phone: "13800000000", code: "123456" });
    const [first, second] = fakes.sms.calls;
    expect(first?.at.toISOString()).toBe(DEFAULT_CLOCK_START);
    expect(second?.at.getTime()).toBe((first?.at.getTime() ?? 0) + 60_000);
  });
});
