import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { EnvError, loadEnv } from "./env.js";

it("告警通道FILE默认未配，独立key/名单/白名单严格解析且拒绝越界或明文", () => {
  const directory = mkdtempSync(join(tmpdir(), "lyx-alert-env-"));
  let sequence = 0;
  const file = (value: unknown) => {
    const path = join(directory, `fake-${sequence++}.json`);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const base = {
    APP_ENV: "test",
    DATABASE_URL: "postgresql://public:public@localhost/lyx_test_public",
    REDIS_URL: "redis://localhost",
  };
  const config = {
    robotKey: "public_fake_robot",
    oncallPhones: ["13800138000"],
    p2Immediate: ["billing.unfulfilled"],
  };
  const bad = (source: Record<string, string>) => {
    try {
      loadEnv(source);
      expect.fail("错误告警配置未拒绝");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      for (const value of [directory, config.robotKey, ...config.oncallPhones])
        expect((error as Error).message).not.toContain(value);
    }
  };
  try {
    expect(loadEnv(base)).not.toHaveProperty("ALERTS");
    expect(loadEnv({ ...base, ALERTS_FILE: file(config) }).ALERTS).toEqual(config);
    expect(
      loadEnv({ ...base, ALERTS_FILE: file({ oncallPhones: [], p2Immediate: [] }) }).ALERTS,
    ).toEqual({ oncallPhones: [], p2Immediate: [] });
    bad({ ...base, ALERTS: JSON.stringify(config) });
    for (const value of [
      { ...config, robotKey: "https://other.invalid" },
      { ...config, oncallPhones: ["13800138000", "13800138000"] },
      { ...config, p2Immediate: ["invalid"] },
      { ...config, token: "extra" },
    ])
      bad({ ...base, ALERTS_FILE: file(value) });
    const link = join(directory, "link.json");
    symlinkSync(file(config), link);
    bad({ ...base, ALERTS_FILE: link });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
