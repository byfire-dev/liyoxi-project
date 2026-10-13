import { paramDef } from "@liyoxi/shared/params";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createClock, useTestRedis } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { createModelBudgetLedger } from "../media/index.js";
import type { ModelBudgetContext, ModelBudgetTransport } from "../media/index.js";
import { createModelBudgetInitializer } from "./model-budget-initialize.js";
import { createModelBudgetInspector } from "./model-budget-inspect.js";

const redis = useTestRedis(),
  DAY = 86400000,
  OFFSET = 28800000;
const signal = () => new AbortController().signal;
let client: Awaited<ReturnType<typeof redis.raw>>;
beforeAll(async () => {
  client = await redis.raw();
}, 60000);

function setup(controlledTime?: number) {
  const prefix = `${redis.prefix}initialize:${uuidv7()}:`,
    key = `${prefix}model_budget:v1`,
    clock = createClock(new Date(controlledTime ?? Date.now()));
  let serverAt = controlledTime;
  // 真实Redis脚本/原子性；仅午夜组用显式受控TIME，未声称真实等待一天或运维演练。
  const timed = (script: string) =>
    serverAt === undefined
      ? script
      : script.replaceAll(
          "redis.call('TIME')",
          `{ '${Math.floor(serverAt / 1000)}', '${(serverAt % 1000) * 1000}' }`,
        );
  const evaluate = vi.fn<ModelBudgetTransport["eval"]>(async (script, keys, argv) => {
    expect(keys).toEqual(["lyx:test:model_budget:v1"]);
    return client.eval(timed(script), 1, key, ...argv);
  });
  const initializer = createModelBudgetInitializer({
    appEnv: "test",
    clock,
    transport: { eval: evaluate },
  });
  const ledgerEval = vi.fn<ModelBudgetTransport["eval"]>((script, keys, argv) =>
    client.eval(timed(script), keys.length, ...keys, ...argv),
  );
  const ledger = createModelBudgetLedger({ clock, prefix, transport: { eval: ledgerEval } });
  const time = (at: number) => {
    serverAt = at;
    clock.set(new Date(at));
  };
  const refresh = () => clock.set(new Date(serverAt ?? Date.now()));
  const permit = (kind: "asr" | "vision" | "digest" = "asr"): ModelBudgetContext => {
    refresh();
    const at = clock.now().getTime();
    return {
      entityId: uuidv7(),
      storeId: uuidv7(),
      jobId: uuidv7(),
      fileIds: [uuidv7()],
      kind,
      attemptNo: 1,
      expectedSourceHash: "a".repeat(64),
      dailyFileCap: 200,
      dailyCallCap: 10000,
      readAtMs: at,
      admitUntilMs: at + 250,
      leaseUntilMs: at + 120000,
      originalDeadlineMs: at + (kind === "asr" ? 1800000 : 900000),
    };
  };
  return { prefix, key, clock, evaluate, initializer, ledger, ledgerEval, time, permit, refresh };
}

describe("missing-only真实Redis保守建账", { timeout: 30000 }, () => {
  it("两个独立建账器并发仅一个HSET成功，重放拒绝且正式诊断可读合法元数据", async () => {
    const h = setup(),
      second = createModelBudgetInitializer({
        appEnv: "test",
        clock: h.clock,
        transport: { eval: h.evaluate },
      });
    try {
      const outcomes = await Promise.all([
        h.initializer.initialize(signal()),
        second.initialize(signal()),
      ]);
      expect(outcomes.filter((one) => one.status === "initialized")).toHaveLength(1);
      expect(outcomes.filter((one) => one.status === "refused")).toEqual([
        { status: "refused", reason: "existing" },
      ]);
      const before = await client.hgetall(h.key),
        day = Math.floor((h.clock.now().getTime() + OFFSET) / DAY);
      expect(before).toMatchObject({
        marker: "model_budget_v1",
        head: "1",
        next: "2",
        cursor: "1",
        [`g:${day}`]: "10000",
      });
      expect(Object.keys(before)).toHaveLength(10);
      expect(JSON.parse(before["q:1"]!)).toEqual([
        "g",
        String(day),
        String((day + 2) * DAY - OFFSET),
        `g:${day}`,
      ]);
      expect(await h.initializer.initialize(signal())).toEqual({
        status: "refused",
        reason: "existing",
      });
      expect(await client.hgetall(h.key)).toEqual(before);
      const inspector = createModelBudgetInspector({
        appEnv: "test",
        clock: h.clock,
        transport: { eval: h.evaluate },
      });
      expect(await inspector.inspect(signal())).toMatchObject({
        schema: "sampled_metadata_ok",
        currentGlobalUsed: 10000,
      });
      await inspector.close();
    } finally {
      await Promise.all([h.initializer.close(), second.close()]);
    }
  });

  it("已有损坏hash/错型与预检后并发创建均不覆盖；未知写结果重跑不清空", async () => {
    for (const mode of ["hash", "wrong_type", "race", "unknown"] as const) {
      const h = setup();
      try {
        if (mode === "hash") await client.hset(h.key, { marker: "damaged", keep: "evidence" });
        if (mode === "wrong_type") await client.set(h.key, "evidence");
        const original = h.evaluate.getMockImplementation()!;
        if (mode === "race")
          h.evaluate.mockImplementation(async (script, keys, argv) => {
            const reply = await original(script, keys, argv);
            if (!script.includes("redis.call('HSET'"))
              await client.hset(h.key, { marker: "concurrent", keep: "evidence" });
            return reply;
          });
        if (mode === "unknown")
          h.evaluate.mockImplementation(async (script, keys, argv) => {
            const reply = await original(script, keys, argv);
            if (script.includes("redis.call('HSET'")) throw new Error("PRIVATE_UNKNOWN_REPLY");
            return reply;
          });
        const result = await h.initializer.initialize(signal());
        expect(result).toEqual(
          mode === "unknown"
            ? { status: "unavailable" }
            : { status: "refused", reason: mode === "wrong_type" ? "wrong_type" : "existing" },
        );
        const before = await client.dump(h.key),
          expiry = await client.pexpiretime(h.key);
        h.evaluate.mockImplementation(original);
        h.refresh();
        expect(await h.initializer.initialize(signal())).toEqual({
          status: "refused",
          reason: mode === "wrong_type" ? "wrong_type" : "existing",
        });
        expect(await client.dump(h.key)).toEqual(before);
        expect(await client.pexpiretime(h.key)).toBe(expiry);
        if (mode !== "wrong_type")
          expect(await client.hget(h.key, mode === "unknown" ? "marker" : "keep")).toBe(
            mode === "unknown" ? "model_budget_v1" : "evidence",
          );
      } finally {
        await h.initializer.close();
      }
    }
  });

  it("双钟偏差/跨北京午夜先拒绝零写，closed覆盖旧最大deadline再加5秒", async () => {
    const at = Date.parse("2026-10-13T15:59:59.999Z");
    for (const [serverAt, delta] of [
      [at - 3600000, 5001],
      [at, 2],
    ] as const) {
      const h = setup(serverAt);
      h.clock.set(new Date(serverAt + delta));
      try {
        expect(await h.initializer.initialize(signal())).toEqual({
          status: "refused",
          reason: "clock",
        });
        expect(await client.exists(h.key)).toBe(0);
      } finally {
        await h.initializer.close();
      }
    }
    const h = setup(at - 3600000);
    try {
      const result = await h.initializer.initialize(signal());
      if (result.status !== "initialized") throw new Error("受控合法双钟未建账");
      const tomorrow = Date.parse("2026-10-13T16:00:00Z");
      expect(result).toMatchObject({
        earliestConfiguredDayMs: tomorrow,
        closedBeforeMs: tomorrow + 1800000 + 5000,
      });
      h.time(tomorrow + 6000);
      const old = h.permit();
      old.originalDeadlineMs = tomorrow + 1800000;
      expect(await h.ledger.reserve(old, signal())).toEqual({ status: "denied", reason: "stale" });
      expect(await client.hget(h.key, "closed")).toBe(String(result.closedBeforeMs));
    } finally {
      await h.initializer.close();
    }
  });

  it("当天10000槽与默认0保守关闭；次日沿原跨日与128槽维护，不重建或退款", async () => {
    const h = setup(Date.parse("2026-10-13T04:00:00Z"));
    try {
      const result = await h.initializer.initialize(signal());
      if (result.status !== "initialized") throw new Error("受控合法双钟未建账");
      expect(await client.hget(h.key, `g:${result.blockedBeijingDay}`)).toBe("10000");
      expect((await h.ledger.reserve(h.permit(), signal())).status).toBe("denied");
      expect(paramDef("media.model.daily_call_cap")!.default).toBe(0);
      const calls = h.ledgerEval.mock.calls.length;
      expect(await h.ledger.reserve({ ...h.permit(), dailyCallCap: 0 }, signal())).toEqual({
        status: "denied",
        reason: "disabled",
      });
      expect(h.ledgerEval).toHaveBeenCalledTimes(calls);
      h.time(result.closedBeforeMs + 1);
      const current = h.permit("vision");
      expect(await h.ledger.reserve(current, signal())).toEqual({
        status: "reserved",
        units: 3,
        newFiles: 1,
      });
      expect(await client.hget(h.key, `g:${result.blockedBeijingDay}`)).toBe("10000");
      expect(await client.hget(h.key, `g:${result.blockedBeijingDay + 1}`)).toBe("3");
      expect(await h.initializer.initialize(signal())).toEqual({
        status: "refused",
        reason: "existing",
      });
      h.time(result.earliestConfiguredDayMs + DAY + 1);
      expect(await h.ledger.maintain(signal())).toMatchObject({ status: "maintained", removed: 2 });
      expect(await client.hexists(h.key, `g:${result.blockedBeijingDay}`)).toBe(0);
      expect(await client.hget(h.key, `g:${result.blockedBeijingDay + 1}`)).toBe("3");
      expect(Number(await client.hget(h.key, "closed"))).toBeGreaterThanOrEqual(
        result.closedBeforeMs,
      );
    } finally {
      await h.initializer.close();
    }
  });
});
