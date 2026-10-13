import { describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "./env.js";

const base = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://example:example@localhost/liyoxi",
  REDIS_URL: "redis://localhost:6379",
};

describe("后台来源白名单配置", () => {
  it("未配置或纯空白沿用不限制的默认", () => {
    expect(loadEnv(base)).not.toHaveProperty("ADMIN_IP_ALLOWLIST");
    expect(loadEnv({ ...base, ADMIN_IP_ALLOWLIST: "  " })).not.toHaveProperty("ADMIN_IP_ALLOWLIST");
  });
  it("接受逗号分隔的IPv4、IPv6及CIDR并冻结列表", () => {
    const configured = loadEnv({
      ...base,
      ADMIN_IP_ALLOWLIST: " 198.51.100.7, 2001:db8::/32, ::ffff:198.51.100.0/120 ",
    }).ADMIN_IP_ALLOWLIST;
    expect(configured).toEqual(["198.51.100.7", "2001:db8::/32", "::ffff:198.51.100.0/120"]);
    expect(Object.isFrozen(configured)).toBe(true);
  });
  it("错误地址、前缀或空项拒绝启动，错误不回显配置值", () => {
    for (const value of [
      "private.example",
      "198.51.100.0/33",
      "2001:db8::/129",
      "10.0.0.0/1e1",
      "10.0.0.0/8/9",
      ",",
      "10.0.0.1,",
    ]) {
      try {
        loadEnv({ ...base, ADMIN_IP_ALLOWLIST: value });
        expect.fail("错误配置没有被拒绝");
      } catch (error) {
        expect(error).toBeInstanceOf(EnvError);
        expect((error as EnvError).issues).toEqual([
          {
            key: "ADMIN_IP_ALLOWLIST",
            reason: "必须是逗号分隔的合法 IP 或 CIDR 列表",
          },
        ]);
        expect((error as Error).message).not.toContain(value);
      }
    }
  });
});
