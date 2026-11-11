import { describe, expect, it, vi } from "vitest";

import { createPortalErrorReporter } from "./client-errors";

describe("portal安全上报接线槽", () => {
  it("默认不发送；注入sink也只保留分类、状态、requestId与正式编译帧", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      createPortalErrorReporter()({ category: "network" });
      expect(fetchSpy).not.toHaveBeenCalled();
      const sink = vi.fn();
      const report = createPortalErrorReporter(sink);
      report({
        category: "api",
        status: 503,
        requestId: "019a4500-0000-7000-8000-000000000004",
        url: "https://private.invalid?code=secret",
        message: "pollSecret=private",
        headers: { Cookie: "private" },
        stacktrace: {
          frames: [
            {
              filename: "assets/index-abcdefgh.js",
              abs_path: "app:///portal/assets/index-abcdefgh.js",
              lineno: 7,
              colno: 4,
              vars: { pollSecret: "private" },
            },
            {
              filename: "https://private.invalid/source.ts",
              abs_path: "private",
              lineno: 2,
              colno: 3,
            },
          ],
        },
      });
      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0]?.[0]).toEqual({
        category: "api",
        status: 503,
        requestId: "019a4500-0000-7000-8000-000000000004",
        stacktrace: {
          frames: [
            {
              filename: "assets/index-abcdefgh.js",
              abs_path: "app:///portal/assets/index-abcdefgh.js",
              lineno: 7,
              colno: 4,
              in_app: true,
            },
          ],
        },
      });
      expect(JSON.stringify(sink.mock.calls)).not.toMatch(/private|pollSecret|Cookie/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("未知分类拒绝；sink失败不递归或抛出原异常", () => {
    const sink = vi.fn(() => {
      throw new Error("private");
    });
    const report = createPortalErrorReporter(sink);
    report({ category: "pollSecret=private" });
    expect(sink).not.toHaveBeenCalled();
    expect(() => report({ category: "network" })).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
  });
  it("输入getter与Proxy不进入白名单读取，未知字段和不可用安全字段全部丢弃", () => {
    const sink = vi.fn();
    const report = createPortalErrorReporter(sink);
    const getter = vi.fn(() => {
      throw new Error("private");
    });
    const input = { category: "api", status: 200, requestId: "code=12ABCDEF" };
    Object.defineProperty(input, "stacktrace", { get: getter });
    Object.defineProperty(input, "message", { get: getter });
    expect(() => report(input)).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledExactlyOnceWith({ category: "api" });
    const hostile = new Proxy({}, { getOwnPropertyDescriptor: getter });
    expect(() => report(hostile)).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
