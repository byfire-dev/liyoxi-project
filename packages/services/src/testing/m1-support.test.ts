import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createM1Support } from "./m1-support.js";

beforeEach(() => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("DATABASE_URL", "postgresql://127.0.0.1:5442/m1_guard");
  vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6389/0");
});
afterEach(() => vi.unstubAllEnvs());

it.each(["prod", "local", "staging"])(
  "%s 环境在建库、Redis与媒体读取前拒绝接口重放",
  async (env) => {
    vi.stubEnv("APP_ENV", env);
    await expect(createM1Support()).rejects.toThrow("APP_ENV=test");
  },
);
it("远程 PostgreSQL 在获取本轮 Redis scope 前拒绝", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://m1-guard.example.invalid/m1_guard");
  await expect(createM1Support()).rejects.toThrow("本地测试 PostgreSQL/Redis");
});
it("远程 Redis 在连接和获取 scope 前拒绝", async () => {
  vi.stubEnv("REDIS_URL", "redis://m1-guard.example.invalid/0");
  await expect(createM1Support()).rejects.toThrow("本地测试 PostgreSQL/Redis");
});
it.each(["../../main", "shared_scope", "a".repeat(13), ""])(
  "无效 scope %s 在获取 Redis/建库前拒绝",
  async (runId) => {
    await expect(createM1Support({ runId })).rejects.toThrow("runId");
  },
);
