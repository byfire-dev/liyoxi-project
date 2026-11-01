import { AdminSampleRequestChangeBodySchema, StaffListQuerySchema } from "@liyoxi/contract";
import { expect, it, vi } from "vitest";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import { createTicketActionIntent, type TicketCommand } from "./m5-actions";
import { createM5TicketApi, type M5Ticket } from "./m5-api";
const id = "019aa000-0000-7000-8000-000000000001";
const hooks = (): ApiHandlers => ({
  redirectToLogin: vi.fn(),
  stepUp: vi.fn(async () => false),
  refreshAccess: vi.fn(),
  invalidateQueries: vi.fn(),
  notify: vi.fn(),
  showBlocked: vi.fn(),
  buildMismatch: vi.fn(),
});
it("工单余下操作沿真实typed路径、当前版次和原键；取料现签不复用写意图键", async () => {
  const requests: Request[] = [],
    controller = new AbortController();
  const api = createM5TicketApi({
    api: createAdminApi({
      baseUrl: "https://fictional-admin.test",
      build: "w513",
      handlers: hooks(),
      fetch: async (request) => {
        requests.push(request.clone());
        return new Response(JSON.stringify({ code: 0, message: "ok", data: {} }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    }),
  });
  const signal = controller.signal,
    key = "one-intent";
  await api.assignEditor(
    id,
    { staffId: id, reasonCode: "staff_change", note: "真实转派" },
    key,
    signal,
  );
  await api.assignPublisher(id, { staffId: id }, key, signal);
  const force = {
    toStep: "plan_confirm" as const,
    note: "已核对商家方案变动与工单事实",
    confirm: { ticketNo: "GD000001", fromStep: "sample_confirm" as const },
  };
  await api.force(id, force, key, signal);
  await api.reevaluate(id, key, signal);
  await api.rework(id, { reason: "重新核对" }, key, signal);
  await api.remind(id, { scene: "confirm_sample" }, key, signal);
  await api.reschedule(id, { agreedLaunchDate: "2026-11-10", reason: "商家改期" }, key, signal);
  await api.reissue(id, { episodeNos: [1], reasonCode: "other", note: "补发第1集" }, key, signal);
  await api.cancelReissue(id, {}, key, signal);
  await api.publishReissue(
    id,
    { precheck: { checklistVersionNo: 1, results: [{ key: "checked", result: "pass" }] } },
    key,
    signal,
  );
  await api.markSent(id, key, signal);
  await api.feedback(
    id,
    {
      versionNo: 3,
      feedbackKind: "ad_content",
      adId: id,
      note: "修改广告",
      feedbackTimeMs: 1250,
      feedbackFileIds: [id],
    },
    key,
    signal,
  );
  await api.normalize(id, {}, key, signal);
  await api.recheck(id, key, signal);
  await api.restamp(
    id,
    { tools: [{ name: "工具", version: "1", usedFor: "字幕" }], note: "补写实际标识" },
    key,
    signal,
  );
  await api.materialDownload(id, { kind: "master", episodeNos: [1] }, signal);
  await api.materialDownload(id, { kind: "master", episodeNos: [1] }, signal);
  const prefix = "/api/v1/admin";
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ...[
      "assign-editor",
      "assign-publisher",
      "force-transition",
      "reevaluate",
      "rework",
      "remind",
    ].map((name) => ["POST", `${prefix}/delivery-tickets/${id}/${name}`]),
    ["POST", `${prefix}/order-items/${id}/reschedule-launch`],
    ["POST", `${prefix}/delivery-tickets/${id}/reissues`],
    ["POST", `${prefix}/reissues/${id}/cancel`],
    ["POST", `${prefix}/reissues/${id}/publish`],
    ["POST", `${prefix}/samples/${id}/mark-sent`],
    ["POST", `${prefix}/samples/${id}/request-change`],
    ...["normalize", "recheck", "restamp"].map((name) => [
      "POST",
      `${prefix}/production-records/${id}/${name}`,
    ]),
    ["POST", `${prefix}/delivery-tickets/${id}/materials/download-urls`],
    ["POST", `${prefix}/delivery-tickets/${id}/materials/download-urls`],
  ]);
  expect(
    requests
      .slice(0, 15)
      .every(
        (request) =>
          request.headers.get("Idempotency-Key") === key &&
          request.headers.get("X-LYX-Admin") === "1",
      ),
  ).toBe(true);
  // Existing central transport attaches a fresh request key to every POST, even none endpoints.
  // Signing has no cached write intent: each invocation reaches the server with a new request key.
  expect(requests[15]!.headers.get("Idempotency-Key")).not.toBe(key);
  expect(requests[15]!.headers.get("Idempotency-Key")).not.toBe(
    requests[16]!.headers.get("Idempotency-Key"),
  );
  expect(await requests[2]!.json()).toEqual(force);
  expect(await requests[11]!.json()).toMatchObject({
    versionNo: 3,
    feedbackTimeMs: 1250,
    feedbackFileIds: [id],
  });
  expect(await requests[15]!.json()).toEqual({ kind: "master", episodeNos: [1] });
});
it("候选/在办/活动/制作逐文件查询精确传scope参数且取消传播到请求", async () => {
  const requests: Request[] = [];
  const api = createM5TicketApi({
    api: createAdminApi({
      baseUrl: "https://fictional-admin.test",
      build: "w513",
      handlers: hooks(),
      fetch: async (request) => {
        requests.push(request);
        return new Response(JSON.stringify({ code: 0, data: {}, message: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    }),
  });
  const controller = new AbortController();
  await api.candidates("editor", controller.signal);
  await api.openWork(id, controller.signal);
  await api.activity(id, controller.signal, "next-cursor");
  await api.productionRecord(id, id, controller.signal);
  expect(Object.fromEntries(new URL(requests[0]!.url).searchParams)).toEqual({
    roleKey: "editor",
    status: "active",
    pool: "editor",
    pageSize: "100",
  });
  expect(() =>
    StaffListQuerySchema.parse(Object.fromEntries(new URL(requests[0]!.url).searchParams)),
  ).not.toThrow();
  expect(new URL(requests[1]!.url).pathname).toBe(`/api/v1/admin/staff/${id}/open-work`);
  expect(Object.fromEntries(new URL(requests[2]!.url).searchParams)).toEqual({
    cursor: "next-cursor",
    limit: "30",
  });
  expect(Object.fromEntries(new URL(requests[3]!.url).searchParams)).toEqual({
    orderItemId: id,
    fileIds: id,
    pageSize: "100",
  });
  controller.abort();
  expect(requests.every((request) => request.signal.aborted)).toBe(true);
});

it("实际typed代录入口免费额度409后停止原写，不重发或转商家付费修改路径", async () => {
  const requests: Request[] = [];
  const api = createM5TicketApi({
    api: createAdminApi({
      baseUrl: "https://fictional-admin.test",
      build: "w513",
      handlers: hooks(),
      fetch: async (request) => {
        requests.push(request.clone());
        return new Response(
          JSON.stringify({
            code: 45314,
            error: "AD_FREE_REVISION_EXHAUSTED",
            message: "免费修改次数已用完",
            details: {},
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      },
    }),
  });
  const body = AdminSampleRequestChangeBodySchema.parse({
    versionNo: 3,
    feedbackKind: "ad_content",
    adId: id,
    note: "请修正当前样片中的广告文案",
    feedbackTimeMs: 1250,
    feedbackFileIds: [id],
  });
  const command: TicketCommand = { action: "feedback", targetId: id, body },
    intent = createTicketActionIntent(() => "free-only-key");
  const read = async () => ({ deliveryTicketId: id }) as M5Ticket;
  const submit = () =>
    intent.submit(
      command,
      read,
      () => {},
      (key, signal) => api.feedback(id, body, key, signal),
    );
  await expect(submit()).rejects.toMatchObject({ code: "AD_FREE_REVISION_EXHAUSTED", status: 409 });
  await expect(submit()).rejects.toMatchObject({ code: "RECONFIRM_REQUIRED" });
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]!.url).pathname).toBe(`/api/v1/admin/samples/${id}/request-change`);
  expect(await requests[0]!.json()).toEqual(body);
  expect(body).not.toHaveProperty("acceptChargePoints");
});
