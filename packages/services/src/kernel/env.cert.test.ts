import { expect, it } from "vitest";
import { EnvError, loadEnv } from "./env.js";

const base = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://a:a@localhost/test",
  REDIS_URL: "redis://localhost",
};
it("证书配置空白零目标；显式域名规范化去重，错误/空项/过量拒绝且不回显值", () => {
  expect(loadEnv(base)).not.toHaveProperty("CERT_DOMAINS");
  expect(loadEnv({ ...base, CERT_DOMAINS: "  " })).not.toHaveProperty("CERT_DOMAINS");
  const domains = loadEnv({
    ...base,
    CERT_DOMAINS: " API.example.invalid,api.example.invalid,cdn.example.invalid ",
  }).CERT_DOMAINS;
  expect(domains).toEqual(["api.example.invalid", "cdn.example.invalid"]);
  expect(Object.isFrozen(domains)).toBe(true);
  for (const value of [
    "https://a.example.invalid",
    "localhost",
    "127.0.0.1",
    "a.example.invalid:443",
    "*.example.invalid",
    "a.example.invalid/path",
    "a.example.invalid,",
    "a..invalid",
    "-a.example.invalid",
    Array.from({ length: 17 }, (_, n) => `a${n}.example.invalid`).join(","),
  ]) {
    try {
      loadEnv({ ...base, CERT_DOMAINS: value });
      expect.fail("错误目标未拒绝");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).issues).toEqual([
        { key: "CERT_DOMAINS", reason: "须为至多16个逗号分隔的DNS域名，每个至多200字符" },
      ]);
      expect((error as Error).message).not.toContain(value);
    }
  }
});
