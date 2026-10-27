import { describe, expect, it, vi } from "vitest";
import {
  billingScope,
  createBillingIntent,
  createBillingRead,
  moneyText,
  plansSearch,
} from "./model";
import { billingConflict, billingError, billingResult, BillingFailure } from "./api";
import { packBody, packSearch } from "../point-packs/model";
import { paramText, paramsSearch, pricingChangeBody } from "../params/model";
import { PointPackCreateBodySchema } from "@liyoxi/contract";
import type { AccessSnapshot } from "../../../lib/permissions";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const access: AccessSnapshot = {
  staff: {
    id: "0199e187-e72a-7000-8000-000000000001",
    name: "虚构员工",
    roleKey: "finance",
    roleName: "财务",
  },
  isLead: false,
  moduleLevels: { billing: "e" },
  dataScope: "own",
  releases: {},
  actions: ["billing.plan.edit"],
};
describe("W417前三页私有输入与生命周期", () => {
  it("decimal-string金额不丢精度，零款/零点/空值分开；URL仅接受合法ID、分页和筛选", () => {
    expect(moneyText("900719925474099301")).toBe("¥9,007,199,254,740,993.01");
    expect(moneyText(0)).toBe("¥0");
    expect(moneyText("0")).toBe("¥0");
    expect(moneyText(null)).toBe("—");
    expect(moneyText("1e4")).toBe("—");
    expect(plansSearch({ planId: "bad", revisionPage: -1, revisionSize: 100 })).toEqual({
      planId: undefined,
      revisionPage: 1,
      revisionSize: 10,
      includeDelisted: true,
    });
    expect(
      plansSearch({
        planId: access.staff.id,
        revisionPage: "2",
        revisionSize: "50",
        includeDelisted: "false",
      }),
    ).toMatchObject({
      planId: access.staff.id,
      revisionPage: 2,
      revisionSize: 50,
      includeDelisted: false,
    });
    expect(packSearch({ listed: "yes" })).toEqual({ listed: undefined });
    expect(packSearch({ listed: "false" })).toEqual({ listed: "false" });
    expect(
      paramsSearch({
        page: "3",
        pageSize: "20",
        tab: "history",
        key: "noticeDays",
        kind: "billing_param",
        createdFrom: "2030-02-30",
      }),
    ).toMatchObject({
      page: 3,
      pageSize: 20,
      tab: "history",
      key: "noticeDays",
      kind: "billing_param",
      createdFrom: undefined,
    });
    for (const changed of [
      { ...access, dataScope: "all" as const },
      { ...access, actions: [] },
      { ...access, staff: { ...access.staff, id: "0199e187-e72a-7000-8000-000000000002" } },
    ])
      expect(billingScope(changed)).not.toBe(billingScope(access));
  });
  it("同步双击只发一次；网络失败同正文同键重试，成功和改动各换新键", async () => {
    let sequence = 0;
    const intent = createBillingIntent("fixture", () => `fixture:${++sequence}`),
      first = deferred<string>();
    const calls: { key: string; body: unknown }[] = [];
    const body = { name: "虚构名称", lockVersion: 7 };
    const send = (key: string) => {
      calls.push({ key, body });
      return first.promise;
    };
    const pending = intent.submit(body, send);
    expect(intent.pending).toBe(true);
    expect(await intent.submit(body, send)).toBeUndefined();
    first.resolve("saved");
    expect(await pending).toBe("saved");
    expect(calls).toEqual([{ key: "fixture:1", body }]);
    const failing = vi.fn(async (_key: string) => {
      throw new Error("虚构断网");
    });
    await expect(intent.submit(body, failing)).rejects.toThrow("断网");
    const failedKey = failing.mock.calls[0]?.[0];
    const retry = vi.fn(async (_key: string) => "saved");
    expect(await intent.submit(body, retry)).toBe("saved");
    expect(retry.mock.calls[0]?.[0]).toBe(failedKey);
    intent.change();
    const changed = vi.fn(async (_key: string) => "next");
    await intent.submit({ ...body, name: "修改后" }, changed);
    expect(changed.mock.calls[0]?.[0]).not.toBe(failedKey);
  });
  it("关闭/角色切换后的迟到成功不提交；重新激活时旧finally不能解除新提交闩", async () => {
    const intent = createBillingIntent("fixture"),
      old = deferred<string>(),
      next = deferred<string>();
    let oldSignal: AbortSignal | undefined;
    const previous = intent.submit({ name: "旧" }, (_key, signal) => {
      oldSignal = signal;
      return old.promise;
    });
    intent.close();
    expect(oldSignal?.aborted).toBe(true);
    expect(await intent.submit({}, async () => "closed")).toBeUndefined();
    intent.activate();
    const current = intent.submit({ name: "新" }, () => next.promise);
    old.resolve("old");
    expect(await previous).toBeUndefined();
    expect(intent.pending).toBe(true);
    next.resolve("new");
    expect(await current).toBe("new");
    expect(intent.pending).toBe(false);
  });
  it("旧报价/详情被新输入或关闭失效，当前错误仍抛出，关闭后不再发请求", async () => {
    const read = createBillingRead(),
      old = deferred<string>(),
      current = deferred<string>();
    let signal: AbortSignal | undefined;
    const first = read.run((own) => {
      signal = own;
      return old.promise;
    });
    const second = read.run(() => current.promise);
    expect(signal?.aborted).toBe(true);
    current.resolve("new");
    old.resolve("old");
    expect(await first).toBeUndefined();
    expect(await second).toBe("new");
    await expect(
      read.run(async () => {
        throw new Error("真实当前错误");
      }),
    ).rejects.toThrow("当前错误");
    const late = deferred<string>(),
      pending = read.run(() => late.promise);
    read.invalidate();
    late.resolve("late");
    expect(await pending).toBeUndefined();
    read.close();
    const closed = vi.fn(async () => "closed");
    expect(await read.run(closed)).toBeUndefined();
    expect(closed).not.toHaveBeenCalled();
  });
  it("积分包元分只解析输入、不算单价；更新携带打开时版本，非法金额/点数拒绝", () => {
    expect(packBody({ points: 100, priceYuan: "0.01", position: 0 }, { lockVersion: 7 })).toEqual({
      points: 100,
      priceFen: 1,
      position: 0,
      lockVersion: 7,
    });
    for (const draft of [
      { points: 99, priceYuan: "2", position: 0 },
      { points: 100, priceYuan: "0", position: 0 },
      { points: 100, priceYuan: "1.001", position: 0 },
    ])
      expect(() => packBody(draft)).toThrow();
  });
  it("参数只保存所选字段且保留0/null；默认值不冒充当前值，不法枚举/顺序/重复拒绝", () => {
    const values = {
      adFreeRevisions: 0,
      cancelDeductionBp: {
        planConfirm: 0,
        adAndSample: null,
        samplePending: 200,
        postSample: null,
        adInProduction: 300,
      },
      noticeDays: 30,
    };
    expect(
      pricingChangeBody({
        selected: ["adFreeRevisions", "cancelDeductionBp"],
        values,
        effectiveDate: "2030-11-20",
      }),
    ).toEqual({
      params: [
        { key: "adFreeRevisions", value: 0, effectiveDate: "2030-11-20" },
        { key: "cancelDeductionBp", value: values.cancelDeductionBp, effectiveDate: "2030-11-20" },
      ],
      notice: {},
    });
    expect(paramText(values.cancelDeductionBp)).toContain("方案确认后：0");
    expect(paramText(values.cancelDeductionBp)).toContain("由客服填写、财务核定");
    expect(() =>
      pricingChangeBody({
        selected: ["enabledCycles"],
        values: { enabledCycles: [0] },
        effectiveDate: null,
      }),
    ).toThrow();
    expect(() =>
      pricingChangeBody({
        selected: [],
        values: {},
        effectiveDate: null,
        tiers: { S: 100, A: 200, B: 100, C: 100 },
      }),
    ).toThrow();
    expect(() =>
      pricingChangeBody({
        selected: ["adFreeRevisions", "adFreeRevisions"],
        values,
        effectiveDate: null,
      }),
    ).toThrow();
  });
  it("已消费HTTP错误body仍保留字段/最早日与冲突符号，规范输入错误可读且不伪成功", async () => {
    const response = new Response(null, { status: 400 });
    let failure: unknown;
    try {
      await billingResult({
        response,
        error: {
          code: 40000,
          error: "VALIDATION_FAILED",
          message: "虚构校验失败",
          details: {
            earliestEffectiveDate: "2030-11-20",
            fieldErrors: [{ path: "params.0.value", message: "虚构字段错误" }],
          },
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BillingFailure);
    expect(billingError(failure)).toContain("params.0.value：虚构字段错误");
    expect(billingError(failure)).toContain("最早生效日 2030-11-20");
    expect(billingConflict(failure)).toBe(false);
    expect(
      billingConflict(
        new BillingFailure({
          status: 409,
          requestId: null,
          body: null,
          disposition: "invalidate",
          symbol: "VERSION_CONFLICT",
          message: "所见版本变更",
        }),
      ),
    ).toBe(true);
    try {
      PointPackCreateBodySchema.parse({});
    } catch (error) {
      expect(billingError(error)).toContain("points：");
    }
  });
});
