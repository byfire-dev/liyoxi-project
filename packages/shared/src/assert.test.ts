import { describe, expect, it } from "vitest";

import { assertNever } from "./assert.js";

describe("assertNever", () => {
  it("运行期走到即抛错，带上没处理的值", () => {
    expect(() => assertNever("unknown" as never)).toThrow("未处理的分支: unknown");
    expect(() => assertNever("x" as never, "未知的时限单位")).toThrow("未知的时限单位: x");
  });

  it("编译期：分支写全了才能通过类型检查", () => {
    const label = (unit: "a" | "b"): string => {
      switch (unit) {
        case "a":
          return "甲";
        case "b":
          return "乙";
        default:
          return assertNever(unit);
      }
    };
    expect(label("a")).toBe("甲");
    expect(label("b")).toBe("乙");
  });
});
