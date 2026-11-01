import { inspectionReady } from "./api";
import { expect, it, vi } from "vitest";
import { adSearch, createAdWorkspace, segmentsInput } from "./model";
import { adDetail, id, inspection } from "./test-data.fixture";
it("URL只保留真实广告筛选，非法页签/值回落；分段按毫秒递增", () => {
  expect(
    adSearch({
      tab: "pending_confirm",
      q: "门店",
      overdueOnly: "true",
      type: "ending",
      admin: "all",
    }),
  ).toEqual({
    tab: "pending_confirm",
    q: "门店",
    id: undefined,
    overdueOnly: true,
    type: "ending",
  });
  expect(adSearch({ tab: "invented", type: "bad" }).tab).toBe("todo");
  expect(segmentsInput("0,1000,广告\n1000,3000,门店")).toEqual([
    { index: 0, fromMs: 0, toMs: 1000, label: "广告" },
    { index: 1, fromMs: 1000, toMs: 3000, label: "门店" },
  ]);
  expect(() => segmentsInput("1000,500,广告")).toThrow();
});
it("同步屏障拒双击，超时先GET后原key重试；换输入换key", async () => {
  let release!: () => void,
    sequence = 0;
  const wait = new Promise<void>((done) => {
      release = done;
    }),
    events: string[] = [],
    keys: string[] = [];
  const get = vi.fn(async () => {
    events.push("get");
    return adDetail();
  });
  const write = vi.fn(async (_ad: string, _command: unknown, key: string) => {
    keys.push(key);
    events.push("write");
    if (keys.length === 1) {
      await wait;
      throw new Error("unknown");
    }
    return adDetail();
  });
  const workspace = createAdWorkspace({ get, write }, id(1), () => `w514-${++sequence}`);
  const first = workspace.submit({ kind: "return", body: { reason: "素材不足" } });
  expect(await workspace.submit({ kind: "return", body: { reason: "素材不足" } })).toBeNull();
  release();
  await expect(first).rejects.toThrow("unknown");
  await workspace.submit({ kind: "return", body: { reason: "素材不足" } });
  await workspace.submit({ kind: "return", body: { reason: "补齐门头" } });
  expect(keys).toEqual(["w514-1", "w514-1", "w514-2"]);
  expect(events).toEqual(["write", "get", "write", "write"]);
});
it("关闭面板/切对象中止旧意图；迟到GET或写结果不再绑定新广告", async () => {
  let release!: () => void;
  const wait = new Promise<void>((done) => {
    release = done;
  });
  const write = vi.fn(async () => {
    await wait;
    return adDetail();
  });
  const old = createAdWorkspace({ get: vi.fn(async () => adDetail()), write }, id(1));
  const pending = old.submit({ kind: "remind", body: {} });
  old.close();
  release();
  expect(await pending).toBeNull();
  expect(await old.submit({ kind: "remind", body: {} })).toBeNull();
  const next = createAdWorkspace({ get: vi.fn(async () => adDetail()), write }, id(9));
  expect(await next.submit({ kind: "remind", body: {} })).toBeNull();
});
it("未知结果重读后动作已消失只展示真实事实，不再POST也不伪造业务成功", async () => {
  const fresh = {
    ...adDetail(),
    status: "returned" as const,
    returnReason: "素材不足",
    actions: [],
  };
  const api = {
    get: vi.fn(async () => fresh),
    write: vi.fn(async () => {
      throw new Error("unknown");
    }),
  };
  const workspace = createAdWorkspace(api, id(1));
  await expect(workspace.submit({ kind: "return", body: { reason: "素材不足" } })).rejects.toThrow(
    "unknown",
  );
  expect(await workspace.submit({ kind: "return", body: { reason: "素材不足" } })).toEqual(fresh);
  expect(api.write).toHaveBeenCalledTimes(1);
  expect(api.get).toHaveBeenCalledTimes(1);
});

it("登记就绪仅取当前广告/文件的真实ready+gate pass，空/拦截/迟到文件均拒绝", () => {
  expect(inspectionReady(inspection(), id(6), id(1))).toBe(true);
  expect(inspectionReady(null, id(6), id(1))).toBe(false);
  expect(inspectionReady({ ...inspection(), pipelineState: "checking" }, id(6), id(1))).toBe(false);
  expect(
    inspectionReady(
      { ...inspection(), check: { ...inspection().check, gate: "reject" } },
      id(6),
      id(1),
    ),
  ).toBe(false);
  expect(inspectionReady(inspection(), id(90), id(1))).toBe(false);
  expect(inspectionReady(inspection(), id(6), id(90))).toBe(false);
});
