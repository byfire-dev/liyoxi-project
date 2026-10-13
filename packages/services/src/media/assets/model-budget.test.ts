import { paramDef, validateParamValue } from "@liyoxi/shared/params";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClock } from "../../testing/index.js";
import { createModelBudgetLedger } from "../index.js";
import type { ModelBudgetContext, ModelBudgetTransport } from "../index.js";
import { AssetJobInputSchema } from "./pipeline.js";

const id = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const prefix = "lyx:test:budgetpure:1:";
const signal = () => new AbortController().signal;
function setup(reply: unknown = ["reserved", 3, 1]) {
  const clock = createClock(new Date("2026-10-11T04:00:00Z"));
  const evalCall = vi.fn<ModelBudgetTransport["eval"]>().mockResolvedValue(reply);
  const ledger = createModelBudgetLedger({ clock, prefix, transport: { eval: evalCall } });
  const permit = (): ModelBudgetContext => ({
    entityId: id(1),
    storeId: id(2),
    jobId: id(3),
    fileIds: [id(4)],
    kind: "digest",
    attemptNo: 1,
    expectedSourceHash: "a".repeat(64),
    dailyFileCap: 200,
    dailyCallCap: 10000,
    readAtMs: clock.now().getTime(),
    admitUntilMs: clock.now().getTime() + 250,
    leaseUntilMs: clock.now().getTime() + 120000,
    originalDeadlineMs: clock.now().getTime() + 900000,
  });
  return { clock, evalCall, ledger, permit };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("独立预算纯上下文与借用传输", () => {
  it("首代13字段沿真实jobId；明确UUID重试意图仅替换token身份，非法显式值零IO", async () => {
    const h = setup(),
      original = h.permit(),
      modelIntentId = id(20),
      input = {
        assetMarker: "store_asset_v1",
        assetId: id(6),
        fileId: id(4),
        promptVersion: 1,
        runId: id(7),
        selected: [],
        etag: "etag",
        crc64: "123",
        sizeBytes: "3",
        coverFileId: id(8),
      };
    expect(Object.keys(original)).toHaveLength(13);
    expect(Object.hasOwn(AssetJobInputSchema.parse(input), "modelIntentId")).toBe(false);
    expect(await h.ledger.reserve(original, signal())).toMatchObject({ status: "reserved" });
    const retry = { ...original, modelIntentId };
    expect(AssetJobInputSchema.parse({ ...input, modelIntentId }).modelIntentId).toBe(
      modelIntentId,
    );
    expect(await h.ledger.reserve(retry, signal())).toMatchObject({ status: "reserved" });
    expect(h.evalCall.mock.calls[0]![2][8]).toBe(original.jobId);
    expect(h.evalCall.mock.calls[1]![2][8]).toBe(modelIntentId);
    expect(retry.jobId).toBe(original.jobId);
    for (const bad of [undefined, null, "bad-uuid"]) {
      expect(AssetJobInputSchema.safeParse({ ...input, modelIntentId: bad }).success).toBe(false);
      expect(
        await h.ledger.reserve({ ...original, modelIntentId: bad } as ModelBudgetContext, signal()),
      ).toEqual({ status: "denied", reason: "stale" });
    }
    expect(await h.ledger.reserve({ ...retry, dailyCallCap: 0 }, signal())).toEqual({
      status: "denied",
      reason: "disabled",
    });
    expect(h.evalCall).toHaveBeenCalledTimes(2);
  });

  it("构造零IO，缺传输关闭；没有初始化、退款或连接关闭口", async () => {
    const h = setup();
    expect(h.evalCall).not.toHaveBeenCalled();
    expect(Object.keys(h.ledger).sort()).toEqual(["maintain", "reserve"]);
    const absent = createModelBudgetLedger({ clock: h.clock, prefix });
    expect(await absent.reserve(h.permit(), signal())).toEqual({
      status: "denied",
      reason: "unavailable",
    });
    expect(await absent.maintain(signal())).toEqual({ status: "denied", reason: "unavailable" });
    expect(h.evalCall).not.toHaveBeenCalled();
  });

  it.each([
    "other:prod:",
    "lyx:prod:../:",
    "lyx:test:UPPER:",
    "lyx:prod",
    `lyx:prod:${"a".repeat(128)}:`,
  ])("拒绝命名空间%s且零IO", (bad) => {
    const h = setup();
    expect(() =>
      createModelBudgetLedger({ clock: h.clock, prefix: bad, transport: { eval: h.evalCall } }),
    ).toThrow(TypeError);
    expect(h.evalCall).not.toHaveBeenCalled();
  });

  it.each([15, 250001, 1.5, Number.NaN])("技术上界不能非法或提高：%s", (maxFields) => {
    expect(() => createModelBudgetLedger({ clock: setup().clock, prefix, maxFields })).toThrow(
      TypeError,
    );
  });

  it.each([
    ["主体大写", { entityId: id(1).toUpperCase() }],
    ["门店不是UUID", { storeId: "store" }],
    ["任务缺失", { jobId: undefined }],
    ["未知kind", { kind: "query" }],
    ["零attempt", { attemptNo: 0 }],
    ["溢出attempt", { attemptNo: 32768 }],
    ["小数attempt", { attemptNo: 1.5 }],
    ["错误hash", { expectedSourceHash: "A".repeat(64) }],
    ["负文件额度", { dailyFileCap: -1 }],
    ["文件硬上界", { dailyFileCap: 201 }],
    ["全局硬上界", { dailyCallCap: 10001 }],
    ["字符串额度", { dailyCallCap: "100" }],
    ["重复文件", { fileIds: [id(4), id(4)] }],
    ["文件乱序", { fileIds: [id(5), id(4)] }],
    ["文件越界", { fileIds: Array.from({ length: 10 }, (_, n) => id(n + 10)) }],
    ["ASR零文件", { kind: "asr", fileIds: [] }],
    ["vision多文件", { kind: "vision", fileIds: [id(4), id(5)] }],
    ["日期NaN", { readAtMs: Number.NaN }],
    ["未知字段", { cost: 0 }],
  ])("坏结构%s不调用eval", async (_label, change) => {
    const h = setup();
    expect(
      await h.ledger.reserve({ ...h.permit(), ...change } as ModelBudgetContext, signal()),
    ).toEqual({ status: "denied", reason: "stale" });
    expect(h.evalCall).not.toHaveBeenCalled();
  });

  it.each([
    "future_read",
    "old_admit",
    "long_admit",
    "short_lease",
    "old_deadline",
    "long_deadline",
  ] as const)("拒绝无新鲜期限%s", async (mode) => {
    const h = setup(),
      p = h.permit(),
      now = h.clock.now().getTime();
    const change = {
      future_read: { readAtMs: now + 1 },
      old_admit: { admitUntilMs: now },
      long_admit: { admitUntilMs: now + 251 },
      short_lease: { leaseUntilMs: now + 249 },
      old_deadline: { originalDeadlineMs: now },
      long_deadline: { originalDeadlineMs: now + 900001 },
    }[mode]!;
    expect(await h.ledger.reserve({ ...p, ...change }, signal())).toEqual({
      status: "denied",
      reason: "stale",
    });
    expect(h.evalCall).not.toHaveBeenCalled();
  });

  it.each(["dailyFileCap", "dailyCallCap"] as const)("%s为0连零文件摘要也关闭", async (key) => {
    const h = setup();
    expect(await h.ledger.reserve({ ...h.permit(), fileIds: [], [key]: 0 }, signal())).toEqual({
      status: "denied",
      reason: "disabled",
    });
    expect(h.evalCall).not.toHaveBeenCalled();
  });

  it("绑定唯一完整KEY与字符串参数，原上下文无旁改", async () => {
    const h = setup(),
      p = h.permit(),
      before = structuredClone(p);
    Object.freeze(p.fileIds);
    Object.freeze(p);
    expect(await h.ledger.reserve(p, signal())).toEqual({
      status: "reserved",
      units: 3,
      newFiles: 1,
    });
    expect(h.evalCall).toHaveBeenCalledTimes(1);
    const [, keys, argv] = h.evalCall.mock.calls[0]!;
    expect(keys).toEqual([`${prefix}model_budget:v1`]);
    expect(argv).toEqual(
      [
        p.readAtMs,
        250000,
        p.readAtMs,
        p.admitUntilMs,
        p.leaseUntilMs,
        p.originalDeadlineMs,
        p.kind,
        p.attemptNo,
        p.jobId,
        p.storeId,
        200,
        10000,
        ...p.fileIds,
      ].map(String),
    );
    expect(p).toEqual(before);
  });

  it.each(["disabled", "quota_global", "quota_store", "duplicate", "stale", "unavailable"])(
    "受控拒绝%s不改成成功",
    async (reason) => {
      const h = setup(["denied", reason]);
      expect(await h.ledger.reserve(h.permit(), signal())).toEqual({ status: "denied", reason });
      expect(h.evalCall).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["null", null],
    ["wrong_cost", ["reserved", 1, 1]],
    ["wrong_files", ["reserved", 3, 2]],
    ["negative_files", ["reserved", 3, -1]],
    ["unknown_reason", ["denied", "allow"]],
    ["extra_field", ["reserved", 3, 1, "extra"]],
  ])("未知回包%s关闭", async (_label, reply) => {
    const h = setup(reply);
    expect(await h.ledger.reserve(h.permit(), signal())).toEqual({
      status: "denied",
      reason: "unavailable",
    });
  });

  it("异常和throwing上下文都关闭，不输出原异常", async () => {
    const h = setup();
    h.evalCall.mockRejectedValueOnce(new Error("PRIVATE_REDIS_URL"));
    expect(await h.ledger.reserve(h.permit(), signal())).toEqual({
      status: "denied",
      reason: "unavailable",
    });
    const p = h.permit();
    Object.defineProperty(p, "fileIds", {
      get: () => {
        throw new Error("private getter");
      },
    });
    expect(await h.ledger.reserve(p, signal())).toEqual({
      status: "denied",
      reason: "unavailable",
    });
    expect(h.evalCall).toHaveBeenCalledTimes(1);
  });

  it("已经取消的reserve与maintain均零IO", async () => {
    const h = setup(),
      controller = new AbortController();
    controller.abort();
    expect((await h.ledger.reserve(h.permit(), controller.signal)).status).toBe("denied");
    expect((await h.ledger.maintain(controller.signal)).status).toBe("denied");
    expect(h.evalCall).not.toHaveBeenCalled();
  });

  it.each(["timeout", "abort", "deadline", "clock_back"])(
    "%s之后的成功回包永不放行且不重发",
    async (mode) => {
      vi.useFakeTimers();
      const h = setup(),
        controller = new AbortController();
      let resolve!: (value: unknown) => void;
      h.evalCall.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const p = h.permit(),
        running = h.ledger.reserve(p, controller.signal);
      await Promise.resolve();
      expect(h.evalCall).toHaveBeenCalledTimes(1);
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(251);
      else if (mode === "abort") controller.abort();
      else if (mode === "deadline") h.clock.set(new Date(p.originalDeadlineMs));
      else h.clock.set(new Date(p.readAtMs - 1));
      resolve(["reserved", 3, 1]);
      expect((await running).status).toBe("denied");
      await Promise.resolve();
      expect(h.evalCall).toHaveBeenCalledTimes(1);
    },
  );

  it("清理只接受有界实际数量，超时的迟到拒绝被消费", async () => {
    const h = setup(["maintained", 128, 2]);
    expect(await h.ledger.maintain(signal())).toEqual({
      status: "maintained",
      scanned: 128,
      removed: 2,
    });
    h.evalCall.mockResolvedValueOnce(["maintained", 129, 1]);
    expect((await h.ledger.maintain(signal())).status).toBe("denied");
    h.evalCall.mockResolvedValueOnce(["maintained", 2, 3]);
    expect((await h.ledger.maintain(signal())).status).toBe("denied");
    vi.useFakeTimers();
    let reject!: (reason: Error) => void;
    h.evalCall.mockImplementationOnce(
      () =>
        new Promise((_done, fail) => {
          reject = fail;
        }),
    );
    const pending = h.ledger.maintain(signal());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(251);
    expect((await pending).status).toBe("denied");
    reject(new Error("late failure"));
    await Promise.resolve();
    expect(h.evalCall).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["media.assets.daily_file_cap", 200, 200, "文件"],
    ["media.model.daily_call_cap", 0, 10000, "槽"],
  ] as const)("正式定义%s的默认、禁用和硬上界", (key, fallback, max, unit) => {
    const def = paramDef(key)!;
    expect(def).toMatchObject({
      key,
      type: "int",
      default: fallback,
      min: 0,
      max,
      unit,
      snapshotOn: "read",
    });
    expect(validateParamValue(def, 0)).toBeNull();
    expect(validateParamValue(def, max)).toBeNull();
    for (const bad of [-1, max + 1, 1.5, "0", false, Number.NaN])
      expect(validateParamValue(def, bad)).not.toBeNull();
  });
});
