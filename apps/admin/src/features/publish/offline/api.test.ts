import { expect, it } from "vitest";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import { createPatrolApi, PublishFailure } from "../patrol/api";
import { createHealthApi } from "../accounts/health-api";
import { createOfflineApi, type CheckBody } from "./api";
const id = "019a0000-0000-7000-8000-000000000001";
function transport(reply: (request: Request) => Response | Promise<Response>) {
  const handlers: ApiHandlers = {
    redirectToLogin() {},
    stepUp: async () => false,
    refreshAccess() {},
    invalidateQueries() {},
    notify() {},
    showBlocked() {},
    buildMismatch() {},
  };
  return {
    api: createAdminApi({
      baseUrl: "https://publish.example.test",
      build: "w609",
      handlers,
      fetch: async (request) => reply(request),
    }),
  };
}
const ok = (data: unknown = {}) =>
  new Response(JSON.stringify({ code: 0, data }), {
    headers: { "Content-Type": "application/json" },
  });
it("两类列表与汇总范围一致；证据签发逐文件，不存签名URL到写入数据", async () => {
  const seen: Request[] = [],
    services = transport((request) => {
      seen.push(request.clone());
      return ok();
    }),
    patrol = createPatrolApi(services),
    offline = createOfflineApi(services),
    health = createHealthApi(services);
  const scope = { storeId: id, q: "测试门店" };
  await patrol.list({ ...scope, tab: "abnormal", page: 2, pageSize: 20, source: "manual" });
  await patrol.summary({ ...scope, source: "manual" });
  await offline.list({ ...scope, tab: "pending", page: 2, pageSize: 20, isOverdue: "true" });
  await offline.summary({ ...scope, isOverdue: "true" });
  await health.list({ ...scope, status: "abnormal", page: 2, pageSize: 20, platform: "douyin" });
  await health.summary({ ...scope, platform: "douyin" });
  for (let i = 0; i < 6; i += 2) {
    const list = new URL(seen[i]!.url).searchParams,
      summary = new URL(seen[i + 1]!.url).searchParams;
    for (const key of ["tab", "status", "page", "pageSize"]) list.delete(key);
    expect([...list]).toEqual([...summary]);
  }
  await patrol.evidence(id);
  expect(new URL(seen.at(-1)!.url).pathname).toBe(`/api/v1/admin/files/${id}/download-urls`);
  expect(await seen.at(-1)!.json()).toEqual({ disposition: "inline" });
});
it("核查/批量核查按每项body提交；仍在线与升级只note，提醒strict空体且原key保留", async () => {
  const seen: Request[] = [],
    api = createOfflineApi(
      transport((request) => {
        seen.push(request.clone());
        return ok();
      }),
    );
  const body: CheckBody = {
    checklistCode: "takedown.check",
    checklistVersionNo: 3,
    results: [{ key: "absent", result: "pass" }],
    evidenceFileIds: [id, id.replace(/1$/, "2")],
  };
  await api.check(id, body, "same-check");
  await api.batch({ items: [{ takedownTaskId: id, ...body }] }, "same-batch");
  await api.online(id, { note: "抽查仍在线" }, "same-online");
  await api.escalate(id, {}, "same-escalate");
  await api.breach(id, "same-breach");
  expect(await Promise.all(seen.map((request) => request.json()))).toEqual([
    body,
    { items: [{ takedownTaskId: id, ...body }] },
    { note: "抽查仍在线" },
    {},
    {},
  ]);
  expect(seen.map((request) => request.headers.get("Idempotency-Key"))).toEqual([
    "same-check",
    "same-batch",
    "same-online",
    "same-escalate",
    "same-breach",
  ]);
});
it("巡检异常不触发账号标记；恢复和正常保留新证据，提醒不加截图", async () => {
  const seen: Request[] = [],
    services = transport((request) => {
      seen.push(request.clone());
      return ok();
    }),
    api = createPatrolApi(services);
  const body = {
    checklistVersionNo: 3,
    results: [{ key: "play", result: "pass" as const }],
    evidenceFileIds: [id],
  };
  await api.abnormal(
    id,
    { abnormalKindCode: "issue", note: "链接异常", evidenceFileIds: [id] },
    "same-abnormal",
  );
  await api.recover(id, body, "same-recover");
  await api.normal(id, body, "same-normal");
  await api.remind(id, "same-remind");
  expect(seen.every((request) => !request.url.includes("channel-accounts"))).toBe(true);
  expect(await seen.at(-1)!.json()).toEqual({});
  await createHealthApi(services).abnormal(
    id,
    { reasonCode: "account_reason", note: "资料异常" },
    "account-key",
  );
  expect(new URL(seen.at(-1)!.url).pathname).toBe(
    `/api/v1/admin/channel-accounts/${id}/mark-abnormal`,
  );
});
it("保留原子拒绝逐项原因和限频时间，不从HTTP码猜成功", async () => {
  const details = {
    items: [
      { index: 0, takedownTaskId: id, error: "CHECKLIST_VERSION_STALE", message: "清单版本已更新" },
    ],
  };
  const api = createOfflineApi(
    transport(
      () =>
        new Response(
          JSON.stringify({
            code: 1,
            error: "TAKEDOWN_BATCH_REJECTED",
            message: "本批未处理",
            details,
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  await expect(api.batch({ items: [] }, "reject-key")).rejects.toMatchObject({
    code: "TAKEDOWN_BATCH_REJECTED",
    details,
  });
  const patrol = createPatrolApi(
    transport(
      () =>
        new Response(
          JSON.stringify({
            error: "REMINDED_TODAY",
            message: "今日已提醒",
            details: { nextAvailableDate: "2026-11-05" },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  await expect(patrol.remind(id, "limited-key")).rejects.toBeInstanceOf(PublishFailure);
});
