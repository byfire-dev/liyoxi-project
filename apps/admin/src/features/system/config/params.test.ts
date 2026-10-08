import { describe, expect, it } from "vitest";
import { ConfigFailure, configResult, errorMessage, isConflict } from "./api";
import {
  acknowledgeParamVersions,
  createConfigIntent,
  paramBody,
  paramDraft,
  paramIssue,
  paramsSearch,
  scheduleInstant,
  type Param,
} from "./model";

const item: Param = {
  key: "work.start",
  group: "calendar",
  label: "上班时刻",
  description: "",
  type: "time_hm",
  unit: null,
  range: null,
  defaultValue: "09:00",
  value: "09:00",
  rev: "2",
  latestRev: "4",
  effectiveAt: "2026-10-07T00:00:00Z",
  savedBy: null,
  savedAt: null,
  pending: [
    {
      paramValueId: "01990000-0000-7000-8000-000000000004",
      value: "10:00",
      rev: "4",
      effectiveAt: "2026-10-20T00:00:00Z",
      reason: null,
      savedBy: null,
      savedAt: "2026-10-07T00:00:00Z",
      canWithdraw: true,
    },
  ],
  snapshotOn: "create",
};
describe("W207 typed参数、当前/预约与幂等意图", () => {
  it("实际openapi已解析409仍能识别VERSION_CONFLICT，不能降成普通HTTP错误", async () => {
    const error = {
      error: "VERSION_CONFLICT",
      code: 1000,
      message: "版本变化",
      requestId: "fixture",
      retryable: false,
      details: { conflicts: [{ key: "work.start", latestRev: "5" }] },
    };
    const response = new Response(JSON.stringify(error), { status: 409 });
    await response.json();
    try {
      await configResult({ error, response });
      throw new Error("不应成功");
    } catch (cause) {
      expect(isConflict(cause)).toBe(true);
    }
  });
  it("缺内置年份正式拒绝保留服务端字段原因", () => {
    expect(
      errorMessage(
        new ConfigFailure({
          symbol: "VALIDATION_FAILED",
          status: 400,
          message: "提交的内容有误，请检查后重试",
          requestId: null,
          disposition: "field-errors",
          body: {
            error: "VALIDATION_FAILED",
            code: 1000,
            message: "提交的内容有误，请检查后重试",
            requestId: "fixture",
            retryable: false,
            fieldErrors: [{ path: "days", message: "该年份没有内置安排" }],
          },
        }),
      ),
    ).toBe("days：该年份没有内置安排");
  });
  it("CAS使用latestRev，当前值不偷偷取未来预约", () => {
    expect(paramDraft(item)).toEqual({ value: "09:00", expectedRev: "4" });
    expect(paramBody([item], { [item.key]: { ...paramDraft(item), value: "09:30" } }).body).toEqual(
      { items: [{ key: "work.start", value: "09:30", expectedRev: "4" }] },
    );
  });
  it("预约显式携带生效时间，立即保存不提交撤销字段", () => {
    const at = scheduleInstant("2026-10-20", "09:30");
    expect(at).toBe("2026-10-20T01:30:00.000Z");
    expect(paramBody([item], { [item.key]: paramDraft(item) }, at).body?.items[0]).toMatchObject({
      effectiveAt: at,
    });
    expect(() => scheduleInstant("2026-02-30", "09:30")).toThrow();
    expect(() => scheduleInstant("2026-10-20", "24:00")).toThrow();
  });
  it("多个键一批保持typed值并拒绝工作时间逆序", () => {
    const end = { ...item, key: "work.end", value: "18:00", defaultValue: "18:00" };
    expect(
      paramBody([item, end], {
        "work.start": { value: "19:00", expectedRev: "4" },
        "work.end": { value: "18:30", expectedRev: "4" },
      }).errors["work.end"],
    ).toBeDefined();
    const numeric = { ...item, key: "test.range", type: "int" as const, range: { min: 1, max: 5 } };
    expect(paramIssue(numeric, "3")).toBe("请填写整数");
    expect(paramIssue(numeric, 6)).toBe("最大值为 5");
    expect(paramIssue(numeric, 3)).toBeUndefined();
    expect(paramIssue({ ...item, type: "bool" }, true)).toBeUndefined();
    expect(paramIssue({ ...item, type: "int_list" }, [1, 2, 3])).toBeUndefined();
    expect(paramIssue({ ...item, type: "int_list" }, ["1"])).toBeDefined();
  });
  it("409不改变旧草稿，只有显式核对才替换expectedRev", () => {
    const drafts = { [item.key]: { value: "11:00", expectedRev: "4" } };
    const fresh = { ...item, latestRev: "5", value: "08:00" };
    const next = acknowledgeParamVersions(drafts, [fresh]);
    expect(next[item.key]).toEqual({ value: "11:00", expectedRev: "5" });
    expect(drafts[item.key]).toEqual({ value: "11:00", expectedRev: "4" });
  });
  it("默认年份固定北京时间，边界坏值恢复；分组显式白名单格式", () => {
    expect(paramsSearch({}, new Date("2026-12-31T20:00:00Z")).year).toBe(2027);
    expect(paramsSearch({ year: 2101, group: "../" }, new Date("2026-01-01T00:00:00Z"))).toEqual({
      year: 2026,
      group: undefined,
    });
    expect(paramsSearch({ year: 2024 })).toMatchObject({ year: 2024 });
    expect(paramsSearch({ year: 2100 })).toMatchObject({ year: 2100 });
  });
  it("失败重试同键，改body换键，同步重复提交只调用一次", async () => {
    let seq = 0;
    const intent = createConfigIntent("config", () => `config-${++seq}`),
      keys: string[] = [];
    const fail = async (key: string) => {
      keys.push(key);
      throw new Error("network");
    };
    await expect(intent.submit({ value: 1 }, fail)).rejects.toThrow("network");
    await expect(intent.submit({ value: 1 }, fail)).rejects.toThrow("network");
    await expect(intent.submit({ value: 2 }, fail)).rejects.toThrow("network");
    expect(keys).toEqual(["config-1", "config-1", "config-2"]);
    let release!: () => void;
    const wait = new Promise<void>((done) => {
      release = done;
    });
    let calls = 0;
    const first = intent.submit({ value: 3 }, async () => {
      calls++;
      await wait;
      return 1;
    });
    expect(
      await intent.submit({ value: 3 }, async () => {
        calls++;
        return 2;
      }),
    ).toBeUndefined();
    release();
    expect(await first).toBe(1);
    expect(calls).toBe(1);
  });
});
