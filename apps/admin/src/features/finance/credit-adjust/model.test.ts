import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { financeScope } from "../payments/model";
import { writeTableSearch } from "../../../lib/table-search";
import { access, extensionCase, ids, pointCase } from "./fixtures.test-support";
import {
  adjustmentFilters,
  adjustmentSearch,
  adjustmentTable,
  adjustmentView,
  refreshAdjustmentDetail,
  allowedDecisions,
  approveReady,
  createDecisionIntent,
  readableKinds,
} from "./model";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("仅请求实际viewModules交集，URL保存筛选/页码且无权类型不被替换，真实动作与发起人身份共同限制审批", () => {
  const finance = { ...access, moduleLevels: { finance: "v" as const } };
  expect(readableKinds(finance)).toEqual(["points_adjust"]);
  expect(readableKinds({ ...access, moduleLevels: { order: "v" } })).toEqual([
    "subscription_extend",
  ]);
  expect(readableKinds(null)).toEqual([]);
  const search = adjustmentSearch({
    id: ids.pointApproval,
    kind: "subscription_extend",
    status: "pending",
    tab: "all",
    page: "2",
    pageSize: "10",
    q: "  申请  ",
    overdue: "false",
    submittedFrom: "2030-10-01",
  });
  expect(adjustmentFilters(search, readableKinds(finance))).toMatchObject({
    kind: "subscription_extend",
    q: "申请",
    status: "pending",
    overdue: "false",
  });
  expect(readableKinds(finance)).not.toContain(search.kind);
  expect(adjustmentView(search, readableKinds(finance))).toMatchObject({
    denied: true,
    enabled: false,
    selectedId: undefined,
  });
  expect(
    adjustmentView(
      { ...search, kind: "points_adjust", submittedFrom: "2030-10-20", submittedTo: "2030-10-01" },
      readableKinds(finance),
    ),
  ).toMatchObject({ invalidRange: true, enabled: false, selectedId: undefined });
  expect(
    adjustmentView({ ...search, kind: "points_adjust" }, readableKinds(finance)).selectedId,
  ).toBe(ids.pointApproval);
  expect(adjustmentSearch(writeTableSearch(adjustmentTable(search)))).toEqual({
    ...search,
    id: undefined,
  });
  expect(
    adjustmentSearch({ id: ids.point, page: -3, pageSize: 100, submittedFrom: "2030-02-30" }),
  ).toMatchObject({ id: ids.point, page: 1, pageSize: 20, submittedFrom: undefined });
  const value = pointCase();
  expect(allowedDecisions(value, access)).toEqual(["approve", "reject", "withdraw"]);
  expect(
    allowedDecisions(value, { ...access, staff: { ...access.staff, id: ids.requester } }),
  ).toEqual(["withdraw"]);
  expect(allowedDecisions(value, { ...access, actions: [] })).toEqual(["withdraw"]);
  value.row.actions = [];
  expect(allowedDecisions(value, access)).toEqual([]);
  const extension = extensionCase();
  expect(approveReady(extension)).toBe(true);
  extension.row.preview = null;
  expect(approveReady(extension)).toBe(false);
  expect(financeScope(finance)).not.toBe(financeScope(access));
});
it("同意图同步双击只发一次；网络未知同正文同键，改确认内容才换键，三动作独立且有界", async () => {
  let serial = 0;
  const intent = createDecisionIntent(() => `approval:${++serial}`),
    waiting = deferred<string>(),
    keys: string[] = [];
  const first = intent.submit("approve", { lockVersion: 7, points: 100 }, (key) => {
    keys.push(key);
    return waiting.promise;
  });
  expect(await intent.submit("approve", {}, async () => "duplicate")).toBeUndefined();
  waiting.resolve("done");
  expect(await first).toBe("done");
  expect(keys).toHaveLength(1);
  const failed = vi.fn(async (_key: string) => {
    throw new Error("虚构网络未知");
  });
  await expect(intent.submit("reject", { note: "依据不足" }, failed)).rejects.toThrow("网络未知");
  await expect(intent.submit("reject", { note: "依据不足" }, failed)).rejects.toThrow();
  expect(failed.mock.calls[1]?.[0]).toBe(failed.mock.calls[0]?.[0]);
  await expect(intent.submit("reject", { note: "更正依据" }, failed)).rejects.toThrow();
  expect(failed.mock.calls[2]?.[0]).not.toBe(failed.mock.calls[0]?.[0]);
});
it("卸载/权限scope失效会取消在途；迟到成功或异常都不落当前scope，旧finally不解除新请求闩", async () => {
  const intent = createDecisionIntent(),
    old = deferred<string>(),
    next = deferred<string>();
  let signal: AbortSignal | undefined;
  const previous = intent.submit("approve", { id: ids.point }, (_key, own) => {
    signal = own;
    return old.promise;
  });
  intent.close();
  expect(signal?.aborted).toBe(true);
  expect(await intent.submit("approve", {}, async () => "closed")).toBeUndefined();
  intent.activate();
  const current = intent.submit("withdraw", { id: ids.extension }, () => next.promise);
  old.resolve("late");
  expect(await previous).toBeUndefined();
  expect(intent.pending).toBe(true);
  next.resolve("current");
  expect(await current).toBe("current");
  expect(intent.pending).toBe(false);
  let reject!: (error: Error) => void;
  const pending = intent.submit(
    "reject",
    {},
    () =>
      new Promise<string>((_done, fail) => {
        reject = fail;
      }),
  );
  intent.close();
  reject(new Error("旧scope迟到错误"));
  expect(await pending).toBeUndefined();
});

it("写后/409刷新先取消精确detail旧GET，迟到旧结果不能覆盖；scope失效时新结果也不发布", async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    key = ["finance", "scope-A", "detail", ids.pointApproval],
    old = deferred<{ status: string }>();
  const prior = cache.fetchQuery({ queryKey: key, queryFn: () => old.promise });
  const cancelled = expect(prior).rejects.toMatchObject({ revert: true });
  const current = await refreshAdjustmentDetail(
    cache,
    key,
    new AbortController().signal,
    async () => ({ status: "approved" }),
  );
  expect(current.status).toBe("approved");
  await cancelled;
  old.resolve({ status: "pending" });
  await Promise.resolve();
  expect(cache.getQueryData(key)).toEqual({ status: "approved" });
  const late = deferred<{ status: string }>(),
    controller = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>((done) => {
    entered = done;
  });
  const reading = refreshAdjustmentDetail(cache, key, controller.signal, () => {
    entered();
    return late.promise;
  });
  const stopped = expect(reading).rejects.toMatchObject({ name: "AbortError" });
  await ready;
  controller.abort();
  late.resolve({ status: "withdrawn" });
  await stopped;
  expect(cache.getQueryData(key)).toEqual({ status: "approved" });
  cache.clear();
});
