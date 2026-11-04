import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  keys: new Map<string, string>(),
  databases: new Set<string>(),
  calls: [] as string[],
  fail: "" as "" | "seed" | "agreements" | "runtime",
  disconnects: 0,
}));
vi.mock("@liyoxi/db", () => ({
  createPrismaClient: () => ({
    $disconnect: async () => {
      state.calls.push("db.disconnect");
    },
  }),
}));
vi.mock("@liyoxi/db/testing/standalone", () => ({
  assertTestDatabaseUrl: () => {},
  testDatabaseName: (_: string, parts: { session: string }) =>
    `lyx_test_api_${parts.session}_0_portal`,
  testDatabaseUrl: (name: string) => `postgresql://test:test@127.0.0.1:5432/${name}`,
  listTestDatabases: async () => [...state.databases],
  dropTestDatabase: async (name: string) => {
    state.calls.push("db.drop");
    state.databases.delete(name);
  },
}));
vi.mock("../data/seeded-db.js", () => ({
  createSeededDatabase: async (name: string) => {
    state.calls.push("db.seed");
    state.databases.add(name);
    if (state.fail === "seed") throw new Error("private-database-sentinel");
  },
}));
vi.mock("../data/factories/index.js", () => ({
  createFactories: () => ({
    staff: async () => ({ id: "staff" }),
    fileObject: async () => ({ id: "file" }),
    agreementVersion: async () => {
      state.calls.push("agreement");
      if (state.fail === "agreements") throw new Error("private-agreement-sentinel");
    },
  }),
}));
vi.mock("../../runtime.js", () => ({
  createRuntime: () => {
    state.calls.push("runtime.create");
    if (state.fail === "runtime") throw new Error("private-runtime-sentinel");
    return {
      close: async () => {
        state.calls.push("runtime.close");
      },
    };
  },
}));
vi.mock("../redis.js", () => ({
  testRedisPrefix: ({ session }: { session: string }) => `lyx:test:${session}:0:`,
  assertTestRedisPrefix: () => {},
  disconnectTestRedis: async () => {
    state.disconnects += 1;
  },
}));
vi.mock("./observations.js", () => ({
  createPortalLiveObservations: () => ({
    discardReadWindow: () => false,
    beginReadWindow: async () => "window",
    endReadWindow: async () => ({ unchanged: true, changedTables: [] }),
    ticketFacts: async () => [],
  }),
}));
vi.mock("ioredis", () => ({
  Redis: class {
    on() {
      return this;
    }
    async connect() {
      state.calls.push("redis.connect");
    }
    async set(key: string, value: string) {
      if (state.keys.has(key)) return null;
      state.keys.set(key, value);
      return "OK";
    }
    async get(key: string) {
      return state.keys.get(key) ?? null;
    }
    async scan(_cursor: string, _match: string, pattern: string) {
      return ["0", [...state.keys.keys()].filter((key) => key.startsWith(pattern.slice(0, -1)))];
    }
    async eval(_script: string, count: number, ...args: string[]) {
      const key = args[0]!;
      const claim = args[count]!;
      if (state.keys.get(key) !== claim) return count === 1 ? 0 : -1;
      return state.keys.delete(count === 1 ? key : args[1]!) ? 1 : 0;
    }
  },
}));

import { assertPortalLiveInput, createPortalLiveFixture } from "./fixture.js";
const runId = "abcdef012345",
  prefix = `lyx:test:${runId}:0:`,
  ownerKey = `${prefix}portal_live.owner`;
const name = `lyx_test_api_${runId}_0_portal`;
const input = () => ({
  runId,
  portalOrigin: "https://portal.localhost:4000",
  version: "test",
  signal: new AbortController().signal,
  diagnostic: vi.fn(),
});
beforeEach(() => {
  state.keys.clear();
  state.databases.clear();
  state.calls.length = 0;
  state.fail = "";
  state.disconnects = 0;
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@127.0.0.1:5432/postgres");
  vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379");
});
afterEach(() => vi.unstubAllEnvs());

describe("portal live owned resource lifecycle (injected IO failures)", () => {
  it("rejects non-test/external/override URLs before opening any connection", () => {
    const env = {
      APP_ENV: "test",
      DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/postgres",
      REDIS_URL: "redis://127.0.0.1:6379",
    };
    for (const value of [
      { ...env, APP_ENV: "prod" },
      { ...env, DATABASE_URL: "postgresql://secret@database.example/prod" },
      { ...env, DATABASE_URL: `${env.DATABASE_URL}?host=database.example` },
      { ...env, REDIS_URL: "redis://cache.example:6379" },
    ])
      expect(() => assertPortalLiveInput(input(), value)).toThrow(/INVALID_LIVE_/);
    expect(() =>
      assertPortalLiveInput(
        { ...input(), portalOrigin: "https://portal.localhost:4000/path" },
        env,
      ),
    ).toThrow("INVALID_LIVE_ENVIRONMENT");
    expect(state.calls).toEqual([]);
  });
  it.each(["database", "prefix", "claim"] as const)(
    "never deletes a colliding %s scope",
    async (collision) => {
      if (collision === "database") state.databases.add(name);
      if (collision === "prefix") state.keys.set(`${prefix}old`, "old");
      if (collision === "claim") state.keys.set(ownerKey, "another-owner");
      await expect(createPortalLiveFixture(input())).rejects.toThrow("PORTAL_LIVE_START_FAILED");
      expect(state.calls).not.toContain("db.seed");
      expect(state.calls).not.toContain("db.drop");
      if (collision === "database") expect(state.databases.has(name)).toBe(true);
      if (collision === "prefix") expect(state.keys.get(`${prefix}old`)).toBe("old");
      expect(state.keys.get(ownerKey)).toBe(collision === "claim" ? "another-owner" : undefined);
      expect(state.disconnects).toBe(1);
    },
  );
  it.each(["seed", "agreements", "runtime"] as const)(
    "closes only acquired resources when %s fails",
    async (point) => {
      state.fail = point;
      state.keys.set("lyx:test:other:0:keep", "keep");
      state.databases.add("lyx_test_api_other_0_portal");
      await expect(createPortalLiveFixture(input())).rejects.toThrow("PORTAL_LIVE_START_FAILED");
      expect(state.databases.has(name)).toBe(false);
      expect(state.keys.has(ownerKey)).toBe(false);
      expect(state.databases.has("lyx_test_api_other_0_portal")).toBe(true);
      expect(state.keys.get("lyx:test:other:0:keep")).toBe("keep");
      expect(state.disconnects).toBe(1);
      if (point !== "seed") expect(state.calls).toContain("db.disconnect");
    },
  );
  it("closes once, retains unrelated keys and enforces one provider login input per alias", async () => {
    const fixture = await createPortalLiveFixture(input());
    expect(fixture.primePhoneLogin("owner")).toHaveProperty("loginCode");
    expect(() => fixture.primePhoneLogin("owner")).toThrow("LOGIN_INPUT_ALREADY_USED");
    state.keys.set(`${prefix}ratelimit`, "one");
    state.keys.set("lyx:test:other:0:keep", "keep");
    const first = fixture.close(),
      second = fixture.close();
    expect(second).toBe(first);
    await first;
    expect(state.calls.indexOf("runtime.close")).toBeLessThan(state.calls.indexOf("db.drop"));
    expect(state.calls.filter((call) => call === "db.drop")).toHaveLength(1);
    expect(state.keys.size).toBe(1);
    expect(state.keys.get("lyx:test:other:0:keep")).toBe("keep");
    expect(state.disconnects).toBe(1);
  });
  it("refuses destructive cleanup after ownership changes while closing connections", async () => {
    const options = input(),
      fixture = await createPortalLiveFixture(options);
    state.keys.set(ownerKey, "another-owner");
    state.keys.set(`${prefix}keep`, "keep");
    await expect(fixture.close()).rejects.toThrow("PORTAL_LIVE_CLOSE_FAILED");
    expect(state.calls).toContain("runtime.close");
    expect(state.calls).toContain("db.disconnect");
    expect(state.calls).not.toContain("db.drop");
    expect(state.databases.has(name)).toBe(true);
    expect(state.keys.get(`${prefix}keep`)).toBe("keep");
    expect(options.diagnostic).toHaveBeenCalledWith({
      stage: "closing",
      code: "OWNERSHIP_CHANGED",
    });
  });
});
