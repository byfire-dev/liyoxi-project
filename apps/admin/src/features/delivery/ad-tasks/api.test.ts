import { expect, it, vi } from "vitest";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import { createAdTasksApi, type Command } from "./api";
import { adDetail, fileView, id, inspection } from "./test-data.fixture";
const handlers = (): ApiHandlers => ({
  redirectToLogin: vi.fn(),
  stepUp: vi.fn(async () => true),
  refreshAccess: vi.fn(),
  invalidateQueries: vi.fn(),
  notify: vi.fn(),
  showBlocked: vi.fn(),
  buildMismatch: vi.fn(),
});
function fixture(respond?: (request: Request) => Response | undefined) {
  const requests: Request[] = [];
  const api = createAdTasksApi({
    api: createAdminApi({
      build: "w514",
      baseUrl: "https://fictional-admin.test",
      handlers: handlers(),
      sleep: async () => {},
      fetch: async (request) => {
        requests.push(request.clone());
        return (
          respond?.(request) ??
          new Response(
            JSON.stringify({
              code: 0,
              data: new URL(request.url).pathname.includes("/files/")
                ? fileView()
                : new URL(request.url).pathname.endsWith("/production-records")
                  ? { items: [inspection()], page: 1, pageSize: 20, total: 1 }
                  : adDetail(),
              message: "ok",
            }),
            { headers: { "Content-Type": "application/json" } },
          )
        );
      },
    }),
  });
  return { api, requests };
}
it("八种写口均写前GET核动作/当前版本，原key经中央头发送，写后GET不用回执私签", async () => {
  const { api, requests } = fixture();
  const commands: Command[] = [
    { kind: "assign", body: { staffId: id(7) } },
    { kind: "return", body: { reason: "补齐素材" } },
    { kind: "create-version", body: { fileId: id(6) } },
    { kind: "request-change", body: { versionNo: 1, note: "调整字幕" } },
    { kind: "remind", body: {} },
    {
      kind: "cancel",
      body: {
        reasonCode: "merchant_request",
        note: "商家申请取消",
        expect: { totalRefundPoints: 100 },
      },
    },
    { kind: "push", versionId: id(5), body: { includeWecom: false } },
    { kind: "mark-sent", versionId: id(5), body: {} },
  ];
  let offset = 0;
  for (const [index, command] of commands.entries()) {
    await api.write(id(1), command, `w514-${index}`);
    const group = requests.slice(offset);
    offset = requests.length;
    const before = group[0],
      write = group.at(-2),
      after = group.at(-1);
    expect(before!.method).toBe("GET");
    expect(after!.method).toBe("GET");
    expect(write!.method).toBe("POST");
    expect(write!.headers.get("Idempotency-Key")).toBe(`w514-${index}`);
    expect(write!.headers.get("X-LYX-Admin")).toBe("1");
    expect(await write!.json()).toEqual(command.body);
  }
  expect(requests.filter((r) => r.method === "POST").map((r) => new URL(r.url).pathname)).toEqual([
    `/api/v1/admin/ads/${id(1)}/assign`,
    `/api/v1/admin/ads/${id(1)}/return`,
    `/api/v1/admin/ads/${id(1)}/ad-versions`,
    `/api/v1/admin/ads/${id(1)}/request-change`,
    `/api/v1/admin/ads/${id(1)}/remind`,
    `/api/v1/admin/ads/${id(1)}/cancel-requests`,
    `/api/v1/admin/ad-versions/${id(5)}/push`,
    `/api/v1/admin/ad-versions/${id(5)}/mark-sent`,
  ]);
});
it("错scope/权限、旧版本不发POST；错误私签不进入本页异常文本", async () => {
  const { api, requests } = fixture((request) =>
    request.method === "GET"
      ? new Response(
          JSON.stringify({ code: 0, data: { ...adDetail(), actions: [] }, message: "ok" }),
          { headers: { "Content-Type": "application/json" } },
        )
      : undefined,
  );
  await expect(
    api.write(id(1), { kind: "return", body: { reason: "补充" } }, "key"),
  ).rejects.toMatchObject({ code: "PRECONDITION_CHANGED" });
  await expect(
    api.write(id(1), { kind: "request-change", body: { versionNo: 9, note: "过期版" } }, "key"),
  ).rejects.toMatchObject({ code: "PRECONDITION_CHANGED" });
  expect(requests.every((r) => r.method === "GET")).toBe(true);
  const bad = fixture(
    () =>
      new Response(
        JSON.stringify({
          error: "FILE_NOT_USABLE",
          message: "https://private.invalid?signature=secret",
          details: { url: "secret" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
  );
  await expect(bad.api.get(id(1))).rejects.toThrow("该文件不可用于此广告");
});
it("staff真实在办参数、scope相同list/summary与取消预览没有新增幂等写", async () => {
  const { api, requests } = fixture();
  await api.list({
    tab: "todo",
    sort: "urgency",
    page: 1,
    pageSize: 50,
    q: "门店",
    overdueOnly: true,
  });
  await api.summary({ q: "门店", overdueOnly: true });
  await api.staff(2);
  await api.openWork(id(7));
  await api.cancelQuote(id(1), "merchant_request");
  const staff = new URL(requests[2]!.url);
  expect(Object.fromEntries(staff.searchParams)).toMatchObject({
    roleKey: "editor",
    recommendPool: "editor",
    withLoad: "true",
    sort: "openWorkCount",
    status: "active",
    page: "2",
    pageSize: "50",
  });
  for (const request of requests.slice(0, 2))
    expect(new URL(request.url).searchParams.get("overdueOnly")).toBe("true");
  expect(await requests.at(-1)!.json()).toEqual({ reasonCode: "merchant_request" });
});

it("未入库、拦截、错误分类/门店/上传人文件全部零登记POST", async () => {
  for (const patch of [
    { status: "pending" },
    { moderationState: "block" },
    { category: "poster" },
    { storeId: id(90) },
    { uploader: { actorId: id(90) } },
  ]) {
    const { api, requests } = fixture((request) =>
      new URL(request.url).pathname.includes("/files/")
        ? new Response(
            JSON.stringify({ code: 0, data: { ...fileView(), ...patch }, message: "ok" }),
            { headers: { "Content-Type": "application/json" } },
          )
        : undefined,
    );
    await expect(
      api.write(id(1), { kind: "create-version", body: { fileId: id(6) } }, "same-file"),
    ).rejects.toMatchObject({ code: "FILE_NOT_USABLE" });
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  }
});

it("既有M3检查读口绑定当前文件/广告；uploading/checking/rejected零登记POST", async () => {
  for (const pipelineState of ["uploading", "checking", "rejected"] as const) {
    const { api, requests } = fixture((request) =>
      new URL(request.url).pathname.endsWith("/production-records")
        ? new Response(
            JSON.stringify({
              code: 0,
              data: {
                items: [{ ...inspection(), pipelineState }],
                page: 1,
                pageSize: 20,
                total: 1,
              },
              message: "ok",
            }),
            { headers: { "Content-Type": "application/json" } },
          )
        : undefined,
    );
    await expect(
      api.write(id(1), { kind: "create-version", body: { fileId: id(6) } }, "same-inspection"),
    ).rejects.toMatchObject({ code: "PRODUCTION_NOT_READY" });
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(Object.fromEntries(new URL(requests.at(-1)!.url).searchParams)).toEqual({
      fileIds: id(6),
      adId: id(1),
      kind: "ad",
    });
  }
});

it("预览只取事件后新GET的当前版次签名，过期/关闭均不返回可开窗地址", async () => {
  const respond = (expiresAt: string) => () => {
    const detail = adDetail();
    detail.versions[0]!.preview = {
      url: "https://fictional-preview.test/current",
      expiresAt,
      posterUrl: null,
    };
    return new Response(JSON.stringify({ code: 0, data: detail, message: "ok" }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const fresh = fixture(respond("2100-01-01T00:00:00.000Z"));
  await expect(fresh.api.previewUrl(id(1), id(5), new AbortController().signal)).resolves.toBe(
    "https://fictional-preview.test/current",
  );
  expect(fresh.requests.map((request) => request.method)).toEqual(["GET"]);
  await expect(fresh.api.previewUrl(id(1), id(90), new AbortController().signal)).rejects.toThrow(
    "暂无可用预览",
  );
  const expired = fixture(respond("2000-01-01T00:00:00.000Z"));
  await expect(expired.api.previewUrl(id(1), id(5), new AbortController().signal)).rejects.toThrow(
    "暂无可用预览",
  );
  const closed = new AbortController();
  closed.abort();
  const beforeRequest = fresh.requests.length;
  await expect(fresh.api.previewUrl(id(1), id(5), closed.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(fresh.requests).toHaveLength(beforeRequest);
  const owner = new AbortController();
  const late = fixture(() => {
    owner.abort();
    return respond("2100-01-01T00:00:00.000Z")();
  });
  await expect(late.api.previewUrl(id(1), id(5), owner.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
});
