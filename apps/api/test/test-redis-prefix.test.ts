import { describe, expect, it } from "vitest";
import { testRedisKeyPrefix } from "../src/cli/test-redis-prefix.js";

describe("真实接口验收 Redis 键空间", () => {
  it("省略时不覆盖 runtime 默认前缀", () => {
    for (const env of ["local", "test", "stg", "prod"])
      expect(testRedisKeyPrefix(env, undefined)).toBeUndefined();
  });
  it("test 只接受属于测试命名空间的精确前缀", () => {
    expect(testRedisKeyPrefix("test", "lyx:test:admin_live_123:")).toBe("lyx:test:admin_live_123:");
    for (const value of [
      "",
      "lyx:prod:",
      "lyx:test:",
      "lyx:test:foo*:",
      "lyx:test:foo",
      `lyx:test:${"a".repeat(49)}:`,
    ])
      expect(() => testRedisKeyPrefix("test", value)).toThrow();
  });
  it("其他环境拒绝显式测试前缀，不改变部署键空间", () => {
    for (const env of ["local", "stg", "prod"])
      expect(() => testRedisKeyPrefix(env, "lyx:test:admin_live:")).toThrow();
  });
});
