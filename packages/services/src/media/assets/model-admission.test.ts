import { describe, expect, it, vi } from "vitest";
import type { MediaJob } from "@liyoxi/db";
import { createClock } from "../../testing/index.js";
import type { Tx, TxRunner } from "../../kernel/index.js";
import { uuidv7 } from "../../kernel/index.js";
import type { AssetDeps } from "./context.js";
import type { ModelBudgetAdmission, ModelBudgetDecision } from "../index.js";
import { admitModel, modelPermitCurrent } from "./model-admission.js";

// 这里仅验证异步协议与纯窗口；真实PG提交失败/等待在独立DB叶证明。
function setup(kind: "asr" | "vision" | "digest" = "asr") {
  const clock = createClock(new Date("2026-10-12T04:00:00Z"));
  const at = clock.now().getTime(),
    signal = new AbortController();
  const job = {
    id: uuidv7(),
    kind,
    state: "running",
    attemptNo: 1,
    nextRunAt: new Date(at + 120000),
    deadlineAt: new Date(at + (kind === "asr" ? 1800000 : 900000)),
  } as MediaJob;
  const source = {
    entityId: uuidv7(),
    storeId: uuidv7(),
    fileIds: kind === "digest" ? [] : [uuidv7()],
    expectedSourceHash: "a".repeat(64),
  };
  const events: string[] = [];
  const read = vi.fn(async () => ({ ...source }));
  const readPermit = vi.fn<ModelBudgetAdmission["readPermit"]>(async (_tx, facts) => {
    events.push("permit");
    return { ...facts, dailyFileCap: 200, dailyCallCap: 10000 };
  });
  const reserve = vi.fn<ModelBudgetAdmission["reserve"]>(async () => {
    events.push("reserve");
    return { status: "reserved", units: kind === "asr" ? 1 : 3, newFiles: source.fileIds.length };
  });
  let phase = 0;
  const run: TxRunner["run"] = async (callback) => {
    const n = ++phase;
    events.push(`begin${n}`);
    const value = await callback({} as Tx);
    events.push(`settled${n}`);
    return value;
  };
  // 纯协议夹具只构造本组所需端口，不代表完整运行时或真实PG提交。
  const deps = {
    clock,
    tx: { run },
    assets: { modelBudget: { readPermit, reserve } },
  } as unknown as AssetDeps;
  const execute = () => admitModel(deps, job, signal.signal, read);
  return { clock, at, signal, job, source, events, read, readPermit, reserve, deps, execute };
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("预算许可纯协议", () => {
  it.each(["asr", "vision", "digest"] as const)(
    "%s冻结精确13字段且两次提交后才交付原窗口",
    async (kind) => {
      const h = setup(kind),
        outcome = await h.execute();
      expect(h.events).toEqual([
        "begin1",
        "permit",
        "settled1",
        "reserve",
        "begin2",
        "permit",
        "settled2",
      ]);
      expect(h.reserve).toHaveBeenCalledTimes(1);
      const paid = h.reserve.mock.calls[0]![0];
      expect(paid).toEqual({
        ...h.source,
        jobId: h.job.id,
        kind,
        attemptNo: 1,
        readAtMs: h.at,
        admitUntilMs: h.at + 250,
        leaseUntilMs: h.at + 120000,
        originalDeadlineMs: h.job.deadlineAt.getTime(),
        dailyFileCap: 200,
        dailyCallCap: 10000,
      });
      expect(Object.keys(paid)).toHaveLength(13);
      expect(Object.isFrozen(paid)).toBe(true);
      expect(Object.isFrozen(paid.fileIds)).toBe(true);
      expect(outcome).toEqual({ permit: paid });
      expect(h.read).toHaveBeenCalledTimes(2);
    },
  );

  it.each([1, 2])("phase%d回调完成但run未settle不得越界", async (blocked) => {
    const h = setup(),
      waiting = deferred(),
      entered = deferred();
    let n = 0;
    const run: TxRunner["run"] = async (fn) => {
      const phase = ++n,
        result = await fn({} as Tx);
      if (phase === blocked) {
        entered.release();
        await waiting.promise;
      }
      return result;
    };
    const pending = admitModel({ ...h.deps, tx: { run } }, h.job, h.signal.signal, h.read);
    try {
      await entered.promise;
      expect(h.reserve).toHaveBeenCalledTimes(blocked === 1 ? 0 : 1);
      let delivered = false;
      void pending.then(() => {
        delivered = true;
      });
      await Promise.resolve();
      expect(delivered).toBe(false);
    } finally {
      waiting.release();
    }
    expect(await pending).toHaveProperty("permit");
  });

  it.each([1, 2])("phase%d提交promise失败不交付许可且不退款/重发", async (failed) => {
    const h = setup();
    let n = 0;
    const run: TxRunner["run"] = async (fn) => {
      const result = await fn({} as Tx);
      if (++n === failed) throw new Error("模拟提交promise拒绝，非真实40001证据");
      return result;
    };
    expect(
      await admitModel({ ...h.deps, tx: { run } }, h.job, h.signal.signal, h.read),
    ).toMatchObject({ output: { reason: "budget_unavailable" } });
    expect(h.reserve).toHaveBeenCalledTimes(failed === 1 ? 0 : 1);
  });

  it.each([
    "disabled",
    "quota_global",
    "quota_store",
    "duplicate",
    "stale",
    "unavailable",
  ] as const)("拒绝%s不会进入P2", async (reason) => {
    const h = setup();
    h.reserve.mockResolvedValue({ status: "denied", reason });
    const outcome = await h.execute();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.readPermit).toHaveBeenCalledTimes(1);
    expect(h.reserve).toHaveBeenCalledTimes(1);
    if (reason === "duplicate" || reason === "stale")
      expect(outcome).toEqual({ state: "canceled" });
    else
      expect(outcome).toMatchObject({
        state: "succeeded",
        output: {
          status: "skipped",
          reason:
            reason === "disabled"
              ? "budget_unconfigured"
              : reason.startsWith("quota")
                ? "budget_exhausted"
                : "budget_unavailable",
        },
      });
  });

  it.each(["absent", "null", "throw", "facts", "extra", "caps"])(
    "许可%s关闭，不借legacy true",
    async (mode) => {
      const h = setup();
      const legacy = vi.fn(async () => true),
        assets = { ...h.deps.assets, allowModelCall: legacy };
      if (mode === "absent") delete assets.modelBudget;
      if (mode === "null") h.readPermit.mockResolvedValue(null);
      if (mode === "throw") h.readPermit.mockRejectedValue(new Error("读取失败"));
      if (["facts", "extra", "caps"].includes(mode))
        h.readPermit.mockImplementation(async (_tx, facts) => ({
          ...facts,
          dailyFileCap: mode === "caps" ? 201 : 200,
          dailyCallCap: 10000,
          ...(mode === "facts" ? { storeId: uuidv7() } : {}),
          ...(mode === "extra" ? { unknown: true } : {}),
        }));
      const result = await admitModel({ ...h.deps, assets }, h.job, h.signal.signal, h.read);
      expect(result).toMatchObject({
        output: { reason: mode === "null" ? "budget_unconfigured" : "budget_unavailable" },
      });
      expect(h.reserve).not.toHaveBeenCalled();
      expect(legacy).not.toHaveBeenCalled();
    },
  );

  it.each(["wrong_units", "extra", "unknown", "negative_files", "too_many_files"])(
    "未知预留%s关闭",
    async (mode) => {
      const h = setup();
      const malformed =
        mode === "unknown"
          ? { status: "maybe" }
          : {
              status: "reserved",
              units: mode === "wrong_units" ? 3 : 1,
              newFiles: mode === "negative_files" ? -1 : mode === "too_many_files" ? 2 : 1,
              ...(mode === "extra" ? { extra: true } : {}),
            };
      h.reserve.mockResolvedValue(malformed as ModelBudgetDecision);
      expect(await h.execute()).toMatchObject({ output: { reason: "budget_unavailable" } });
      expect(h.read).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["source", "caps", "abort", "late", "backward"])(
    "R后%s变化取消且不再收费",
    async (mode) => {
      const h = setup(),
        original = h.reserve.getMockImplementation()!;
      h.reserve.mockImplementation(async (permit, abort) => {
        const result = await original(permit, abort);
        if (mode === "source") h.source.expectedSourceHash = "b".repeat(64);
        if (mode === "caps")
          h.readPermit.mockImplementation(async (_tx, facts) => ({
            ...facts,
            dailyFileCap: 199,
            dailyCallCap: 10000,
          }));
        if (mode === "abort") h.signal.abort();
        if (mode === "late") h.clock.advance(250);
        if (mode === "backward") h.clock.set(new Date(h.at - 1));
        return result;
      });
      expect(await h.execute()).toEqual({ state: "canceled" });
      expect(h.reserve).toHaveBeenCalledTimes(1);
    },
  );

  it("P2 fresh readAt不续原paid窗口；IO紧前同步guard还会检查原三期限/abort", async () => {
    const h = setup();
    h.reserve.mockImplementation(async () => {
      h.clock.advance(249);
      return { status: "reserved", units: 1, newFiles: 1 };
    });
    const result = await h.execute();
    if (!("permit" in result)) throw new Error("缺少许可");
    expect(h.readPermit.mock.calls[1]![1].readAtMs).toBe(h.at + 249);
    expect(result.permit.admitUntilMs).toBe(h.at + 250);
    expect(modelPermitCurrent(h.deps, result.permit, h.signal.signal)).toBe(true);
    h.clock.advance(1);
    expect(modelPermitCurrent(h.deps, result.permit, h.signal.signal)).toBe(false);
    h.clock.set(new Date(h.at));
    h.signal.abort();
    expect(modelPermitCurrent(h.deps, result.permit, h.signal.signal)).toBe(false);
    expect(
      modelPermitCurrent(
        h.deps,
        { ...result.permit, leaseUntilMs: h.at },
        new AbortController().signal,
      ),
    ).toBe(false);
    expect(
      modelPermitCurrent(
        h.deps,
        { ...result.permit, originalDeadlineMs: h.at },
        new AbortController().signal,
      ),
    ).toBe(false);
  });
});
