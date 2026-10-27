import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdSchema } from "@liyoxi/contract";
import { afterAll, expect, it } from "vitest";
import { EnvError, loadEnv } from "./env.js";

const directory = mkdtempSync(join(tmpdir(), "lyx-staging-pay-config-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const pg = "postgresql://public:public@localhost/lyx_public_test";
const redis = "redis://localhost/0";
const pgFile = join(directory, "public-pg");
const redisFile = join(directory, "public-redis");
writeFileSync(pgFile, pg);
writeFileSync(redisFile, redis);
const source = (appEnv: string) => ({
  APP_ENV: appEnv,
  DATABASE_URL_FILE: pgFile,
  REDIS_URL_FILE: redisFile,
});
const id = (n: number) => `019baaaa-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

it("预发名单默认空保留旧输出；非stg环境拒绝显式名单且不回显", () => {
  for (const appEnv of ["local", "test", "stg", "prod"]) {
    const base = source(appEnv);
    expect(loadEnv(base)).not.toHaveProperty("STAGING_PAY");
    expect(loadEnv({ ...base, STAGING_PAY_ENTITY_IDS: " \n " })).toEqual(loadEnv(base));
    if (appEnv === "stg") continue;
    try {
      loadEnv({ ...base, STAGING_PAY_ENTITY_IDS: id(1) });
      expect.fail("非预发名单未被拒绝");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).issues).toEqual([
        { key: "STAGING_PAY_ENTITY_IDS", reason: "仅stg环境允许配置非空主体名单" },
      ]);
      expect((error as Error).message).not.toContain(id(1));
    }
  }
});

it("仅stg解析显式UUIDv7名单并冻结；100主体边界有效且不产生启用字段", () => {
  const entityIds = Array.from({ length: 100 }, (_, n) => id(n + 1));
  for (const value of entityIds) expect(IdSchema.safeParse(value).success).toBe(true);
  const config = loadEnv({
    ...source("stg"),
    STAGING_PAY_ENTITY_IDS: ` ${entityIds.join(", ")} `.padEnd(4096, " "),
  }).STAGING_PAY!;
  expect(config).toEqual({ entityIds });
  expect(Object.keys(config)).toEqual(["entityIds"]);
  expect(Object.isFrozen(config)).toBe(true);
  expect(Object.isFrozen(config.entityIds)).toBe(true);
});

it("预发名单非法/重复/空项/超量/超长均拒绝，错误不回显值或路径", () => {
  for (const value of [
    "public-invalid-id",
    id(1).toUpperCase(),
    `${id(1)},${id(1)}`,
    `${id(1)},`,
    `,${id(1)}`,
    `${id(1)}, ,${id(2)}`,
    id(1).replace("-7000-", "-4000-"),
    id(1).replace("-8000-", "-7000-"),
    Array.from({ length: 101 }, (_, n) => id(n + 1)).join(","),
    id(1).padEnd(4097, " "),
  ]) {
    try {
      loadEnv({ ...source("stg"), STAGING_PAY_ENTITY_IDS: value });
      expect.fail("非法名单未被拒绝");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).issues).toHaveLength(1);
      expect((error as EnvError).issues[0]!.key).toBe("STAGING_PAY_ENTITY_IDS");
      expect((error as Error).message).not.toContain(value);
      expect((error as Error).message).not.toContain(directory);
    }
  }
});
