import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { EnvError, loadEnv } from "./env.js";

const recipient = "age1ntnnfzy39drf2yscy0yr9e93frec8yzh8jelk5yrjmnra600adyse8ycjw";
it("备份FILE未配零启用，严格公钥/连接/文件边界及生产独立密钥，错误不回显", () => {
  const directory = mkdtempSync(join(tmpdir(), "lyx-backup-env-"));
  let sequence = 0;
  const file = (body: unknown) => {
    const path = join(directory, `fake-${sequence++}.json`);
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
    return path;
  };
  const base = {
    APP_ENV: "test",
    DATABASE_URL_FILE: file("postgresql://public:public@localhost/lyx_test_public"),
    REDIS_URL_FILE: file("redis://localhost"),
  };
  const config = {
    databaseUrl:
      "postgresql://backup_login:public-test-password@localhost/lyx_test_public?sslmode=require",
    recipient,
    target: { bucket: "backup-1250000000", prefix: "" },
  };
  const rejected = (source: Record<string, string>) => {
    try {
      loadEnv(source);
      expect.fail("非法备份配置未拒绝");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      const message = `${(error as Error).message}${JSON.stringify((error as EnvError).issues)}`;
      for (const secret of [
        directory,
        config.databaseUrl,
        "public-test-password",
        "publicbackupsecret",
      ])
        expect(message).not.toContain(secret);
    }
  };
  try {
    expect(loadEnv(base)).not.toHaveProperty("BACKUP");
    const loaded = loadEnv({ ...base, BACKUP_FILE: file(config) });
    expect(loaded.BACKUP).toEqual({ ...config, maxBytes: 2 * 1024 ** 3 });
    rejected({ ...base, BACKUP: JSON.stringify(config) });
    for (const invalid of [
      { ...config, recipient: `${recipient.slice(0, -1)}q` },
      { ...config, databaseUrl: `${config.databaseUrl}&options=-c%20role%3Dlyx_app` },
      { ...config, maxBytes: 2 * 1024 ** 3 + 1 },
      { ...config, privateKey: "never-accepted" },
    ])
      rejected({ ...base, BACKUP_FILE: file(invalid) });
    const link = join(directory, "link.json");
    symlinkSync(file(config), link);
    rejected({ ...base, BACKUP_FILE: link });
    rejected({ ...base, BACKUP_FILE: file(" ".repeat(4097)) });
    rejected({ ...base, APP_ENV: "prod", BACKUP_FILE: file(config) });
    const production = {
      ...config,
      target: {
        ...config.target,
        region: "ap-shanghai",
        key: { secretId: "publicbackup", secretKey: "publicbackupsecret" },
      },
    };
    expect(loadEnv({ ...base, APP_ENV: "prod", BACKUP_FILE: file(production) }).BACKUP).toEqual({
      ...production,
      maxBytes: 2 * 1024 ** 3,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
