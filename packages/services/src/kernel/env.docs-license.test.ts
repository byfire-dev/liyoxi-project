import { expect, it } from "vitest";
import { EnvError, loadEnv } from "./env.js";

const base = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://a:a@localhost/test",
  REDIS_URL: "redis://localhost",
};

it("验真地址独立可选，HTTPS根地址规范化且不同实例不互借配置", () => {
  expect(loadEnv(base)).not.toHaveProperty("PORTAL_PUBLIC_ORIGIN");
  expect(loadEnv({ ...base, PORTAL_PUBLIC_ORIGIN: " \t " })).not.toHaveProperty(
    "PORTAL_PUBLIC_ORIGIN",
  );
  const first = loadEnv({ ...base, PORTAL_PUBLIC_ORIGIN: " HTTPS://Portal.Example.Invalid:443/ " });
  const second = loadEnv({ ...base, PORTAL_PUBLIC_ORIGIN: "https://other.example.invalid:8443" });
  expect(first.PORTAL_PUBLIC_ORIGIN).toBe("https://portal.example.invalid");
  expect(second.PORTAL_PUBLIC_ORIGIN).toBe("https://other.example.invalid:8443");
  expect(Object.isFrozen(first)).toBe(true);
  expect(loadEnv(base)).not.toHaveProperty("PORTAL_PUBLIC_ORIGIN");
});

it("拒绝非根地址与隐式URL归一化，不在错误中回显配置", () => {
  for (const value of [
    "http://portal.example.invalid",
    "https://portal.example.invalid/v",
    "https://portal.example.invalid/../",
    "https://portal.example.invalid/%2e/",
    "https://portal.example.invalid?",
    "https://portal.example.invalid?code=private-marker",
    "https://portal.example.invalid#",
    "https://fake-user:fake-secret@portal.example.invalid",
    "https://@portal.example.invalid",
    "https:////portal.example.invalid",
    "https://portal.example.invalid\\",
    "https://por\ntal.example.invalid",
    "https://portal.example.invalid:99999",
    "https://portal.example.invalid:",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://portal..invalid",
    "https://-portal.example.invalid",
    `https://${"a".repeat(64)}.example.invalid`,
  ]) {
    try {
      loadEnv({ ...base, PORTAL_PUBLIC_ORIGIN: value });
      expect.fail("非法验真地址未拒绝");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).issues).toEqual([
        {
          key: "PORTAL_PUBLIC_ORIGIN",
          reason: "须为HTTPS DNS根地址，不含账号密码、路径、查询或片段",
        },
      ]);
      const diagnostic = `${(error as Error).message} ${JSON.stringify((error as EnvError).issues)}`;
      expect(diagnostic).not.toContain(value);
      expect(diagnostic).not.toContain("portal.example.invalid");
      expect(diagnostic).not.toContain("private-marker");
      expect(diagnostic).not.toContain("fake-secret");
    }
  }
});
