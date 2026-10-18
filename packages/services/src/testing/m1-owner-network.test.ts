import { expect, it } from "vitest";
import { assertM1OwnerNetwork, M1OwnerNetworkSchema } from "./m1-owner-network.js";
import type { M1SupportOptions } from "./m1-types.js";

it("owner 私网精确收据和固定连接通过，错轮次/身份/连接在 IO 前拒绝", () => {
  const expected = {
    runId: "abc123",
    source: "1".repeat(40),
    nonce: "2".repeat(32),
    networkId: "3".repeat(64),
  };
  const containers = { postgres: "4".repeat(64), redis: "5".repeat(64), minio: "6".repeat(64) };
  const receipt = { schemaVersion: 1 as const, ...expected, containers };
  const options = { runId: expected.runId, ownerNetwork: { expected, receipt } };
  const env = {
    APP_ENV: "test",
    DATABASE_URL: "postgresql://liyoxi:lyx-local-dev@lyx-mixed-abc123-postgres:5432/liyoxi",
    REDIS_URL: "redis://lyx-mixed-abc123-redis:6379/0",
  };
  const parsed: M1SupportOptions["ownerNetwork"] = M1OwnerNetworkSchema.parse(options.ownerNetwork);
  expect(parsed).toEqual(options.ownerNetwork);
  expect(() => assertM1OwnerNetwork(options, env)).not.toThrow();
  expect(() =>
    assertM1OwnerNetwork(options, {
      ...env,
      DATABASE_URL: env.DATABASE_URL.replace("postgresql:", "postgres:"),
    }),
  ).not.toThrow();

  const reject = (input: unknown, environment = env) =>
    expect(() => assertM1OwnerNetwork(input as M1SupportOptions, environment)).toThrow(
      "ownerNetwork",
    );
  for (const APP_ENV of ["local", "prod", ""]) reject(options, { ...env, APP_ENV });
  for (const input of [
    { ...options, runId: undefined },
    { ...options, runId: "another" },
    { ...options, attach: {} },
    { ...options, clock: {} },
    { ...options, ownerNetwork: null },
    { ...options, ownerNetwork: { ...options.ownerNetwork, [Symbol("extra")]: true } },
    { ...options, ownerNetwork: { ...options.ownerNetwork, host: "localhost" } },
    { ...options, ownerNetwork: { expected: { ...expected, extra: true }, receipt } },
    { ...options, ownerNetwork: { expected, receipt: { ...receipt, extra: true } } },
    { ...options, ownerNetwork: { expected, receipt: { ...receipt, schemaVersion: 2 } } },
    {
      ...options,
      ownerNetwork: {
        expected,
        receipt: { ...receipt, containers: { ...containers, extra: true } },
      },
    },
    {
      ...options,
      ownerNetwork: {
        expected,
        receipt: { ...receipt, containers: { ...containers, redis: containers.postgres } },
      },
    },
  ])
    reject(input);
  for (const key of ["runId", "source", "nonce", "networkId"] as const) {
    const changed = { ...expected, [key]: "INVALID" };
    reject({
      ...options,
      runId: key === "runId" ? changed.runId : options.runId,
      ownerNetwork: { expected: changed, receipt: { ...receipt, ...changed } },
    });
    reject({ ...options, ownerNetwork: { expected, receipt: { ...receipt, [key]: "bad" } } });
  }
  for (const service of ["postgres", "redis", "minio"] as const)
    reject({
      ...options,
      ownerNetwork: {
        expected,
        receipt: { ...receipt, containers: { ...containers, [service]: "7".repeat(12) } },
      },
    });
  for (const DATABASE_URL of [
    env.DATABASE_URL.replace("abc123", "another"),
    env.DATABASE_URL.replace("lyx-mixed-abc123-postgres", "127.0.0.1"),
    env.DATABASE_URL.replace(":5432", ":5442"),
    env.DATABASE_URL.replace("liyoxi:lyx-local-dev@", "other:other@"),
    env.DATABASE_URL.replace("/liyoxi", "/stack"),
    `${env.DATABASE_URL}?schema=public`,
    `${env.DATABASE_URL}#fragment`,
  ])
    reject(options, { ...env, DATABASE_URL });
  for (const REDIS_URL of [
    env.REDIS_URL.replace("abc123", "another"),
    env.REDIS_URL.replace(":6379", ":6389"),
    env.REDIS_URL.replace("/0", "/1"),
    env.REDIS_URL.replace("redis://", "redis://other:other@"),
    `${env.REDIS_URL}?db=0`,
  ])
    reject(options, { ...env, REDIS_URL });
});
