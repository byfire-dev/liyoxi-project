import { describe, expect, it } from "vitest";
import { createAdminApi } from "../../../lib/api";
import { createFlowOpsApi, FlowOpsFailure } from "./api";
const id = "0199e187-e72a-7000-8000-000000000001";
function make(
  status = 200,
  response: unknown = {
    code: 0,
    data: { items: [], page: 1, pageSize: 20, total: 0 },
    message: "ok",
  },
) {
  const requests: Request[] = [];
  const api = createAdminApi({
    baseUrl: "http://admin.test",
    build: "w223",
    fetch: async (request) => {
      requests.push(request as Request);
      return new Response(JSON.stringify(response), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
    handlers: {
      redirectToLogin() {},
      stepUp: async () => true,
      refreshAccess() {},
      invalidateQueries() {},
      notify() {},
      showBlocked() {},
      buildMismatch() {},
    },
  });
  return { requests, client: createFlowOpsApi({ api }) };
}
describe("实际中央客户端流程运维绑定", () => {
  it("三个真路径保留CSV与正确分页运输，不主动POST", async () => {
    const { client, requests } = make();
    await client.timers({ page: 2, pageSize: 10, status: "failed,scheduled" });
    await client.outbox({ page: 1, pageSize: 20, status: "dead", subscriber: "notify.onBizEvent" });
    await client.webhooks({
      cursor: "YWJj",
      limit: 10,
      provider: "wechatpay,wechat",
      processState: "failed,dead",
    });
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/api/v1/admin/timers",
      "/api/v1/admin/outbox-deliveries",
      "/api/v1/admin/webhook-events",
    ]);
    expect(new URL(requests[0]!.url).searchParams.get("status")).toBe("failed,scheduled");
    expect(new URL(requests[2]!.url).searchParams.has("page")).toBe(false);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("四POST只有正式body并原样传当前确认幂等键/中央admin头", async () => {
    const { client, requests } = make();
    await client.reschedule(id, {}, "key-reschedule");
    await client.cancel(id, { reason: "测试取消原因" }, "key-cancel");
    await client.retryOutbox(
      id,
      { subscriber: "notify.onBizEvent", note: "测试重投" },
      "key-outbox",
    );
    await client.retryWebhook(id, { note: "测试复位" }, "key-webhook");
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      `/api/v1/admin/timers/${id}/reschedule`,
      `/api/v1/admin/timers/${id}/cancel`,
      `/api/v1/admin/outbox-events/${id}/retry`,
      `/api/v1/admin/webhook-events/${id}/retry`,
    ]);
    expect(await Promise.all(requests.map((r) => r.json()))).toEqual([
      {},
      { reason: "测试取消原因" },
      { subscriber: "notify.onBizEvent", note: "测试重投" },
      { note: "测试复位" },
    ]);
    expect(requests.map((r) => r.headers.get("Idempotency-Key"))).toEqual([
      "key-reschedule",
      "key-cancel",
      "key-outbox",
      "key-webhook",
    ]);
    expect(
      requests.every(
        (r) => r.headers.get("X-LYX-Admin") === "1" && r.credentials === "same-origin",
      ),
    ).toBe(true);
  });
  it("409保留真实STATE_NOT_ALLOWED与status给页面刷新，不伪成功", async () => {
    const { client, requests } = make(409, {
      code: 41009,
      error: "STATE_NOT_ALLOWED",
      message: "当前状态不能执行该操作",
    });
    await expect(
      client.cancel(id, { reason: "测试取消原因" }, "key-conflict"),
    ).rejects.toMatchObject({ code: "STATE_NOT_ALLOWED", status: 409 });
    expect(requests).toHaveLength(1);
    await expect(client.timers({})).rejects.toBeInstanceOf(FlowOpsFailure);
  });
});
