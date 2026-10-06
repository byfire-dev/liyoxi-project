import { expect, it } from "vitest";
import {
  assertDeliveryLiveEnvironment,
  assertDeliveryScope,
  knownVideoBytes,
  KNOWN_VIDEO,
} from "./delivery-known-media.js";
import { fakeKeyEnv } from "../staff.js";
const runId = "1234567890abcdef",
  name = `lyx_test_admin_live_${runId}`;
const env = {
  APP_ENV: "test" as const,
  LOG_LEVEL: "error" as const,
  DATABASE_URL: `postgresql://liyoxi:lyx-local-dev@localhost:5442/${name}?options=-c%20role%3Dlyx_app`,
  REDIS_URL: "redis://localhost:6389/0",
  ...fakeKeyEnv(),
};
it("只接受明确的本轮 public-test 连接与角色", () => {
  expect(assertDeliveryLiveEnvironment(env)).toEqual({
    runId,
    name,
    prefix: `lyx:test:admin_live_${runId}:`,
  });
  for (const patch of [
    { APP_ENV: "local" as const },
    { DATABASE_URL: env.DATABASE_URL.replace(name, "liyoxi") },
    { DATABASE_URL: env.DATABASE_URL.replace("localhost", "example.com") },
    { DATABASE_URL: env.DATABASE_URL.replace("lyx-local-dev", "unknown") },
    { DATABASE_URL: env.DATABASE_URL.replace("5442", "5432") },
    { DATABASE_URL: env.DATABASE_URL.replace("lyx_app", "liyoxi") },
    { DATABASE_URL: `${env.DATABASE_URL}&sslmode=disable` },
    { DATABASE_URL: `${env.DATABASE_URL}&options=-c%20role%3Dlyx_app` },
    { REDIS_URL: "redis://localhost:6389/1" },
    { REDIS_URL: "redis://user:password@localhost:6389/0" },
  ])
    expect(() => assertDeliveryLiveEnvironment({ ...env, ...patch })).toThrow();
});
it("scope 的库、runId、Redis 前缀三者必须一致；无任意元数据入参", () => {
  const id = "01950000-0000-7000-8000-000000000001";
  const scope = {
    ...assertDeliveryLiveEnvironment(env),
    startedAt: "2026-10-01T00:00:00.000Z",
    entityId: id,
    storeId: id,
    orderId: id,
    itemId: id,
    ticketId: id,
    uploaderId: id,
    managerId: id,
  };
  expect(assertDeliveryScope(env, scope)).toEqual(scope);
  for (const patch of [
    { runId: "abcdef1234567890" },
    { name: "lyx_test_admin_live_abcdef1234567890" },
    { prefix: "lyx:test:other:" },
    { durationMs: 9999 },
  ])
    expect(() => assertDeliveryScope(env, { ...scope, ...patch })).toThrow();
});
it("固定 MP4 字节经 SHA-256 核对，与已声明 known 事实对应", async () => {
  const bytes = await knownVideoBytes();
  expect(bytes.length).toBe(KNOWN_VIDEO.bytes);
  expect(bytes.subarray(4, 8).toString()).toBe("ftyp");
});
