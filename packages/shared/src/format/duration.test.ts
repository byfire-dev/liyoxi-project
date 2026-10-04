import { describe, expect, it } from "vitest";

import { formatDuration, formatDurationMs } from "./duration.js";

describe("时长：mm:ss，两位分钟（规范 第 7 节）", () => {
  it("规范的两个例子", () => {
    expect(formatDuration(42)).toBe("00:42");
    expect(formatDuration(72)).toBe("01:12");
  });

  it("整分、零、超过一小时", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(60)).toBe("01:00");
    expect(formatDuration(95)).toBe("01:35");
    expect(formatDuration(3725)).toBe("62:05");
    expect(formatDuration(6005)).toBe("100:05");
  });

  it("不足一秒的部分舍去；毫秒入参", () => {
    expect(formatDuration(42.9)).toBe("00:42");
    expect(formatDurationMs(125_000)).toBe("02:05");
    expect(formatDurationMs(42_999)).toBe("00:42");
  });

  it("负数与非数字报错", () => {
    expect(() => formatDuration(-1)).toThrow(RangeError);
    expect(() => formatDuration(Number.NaN)).toThrow(RangeError);
  });
});
