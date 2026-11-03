import { expect, it, vi } from "vitest";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import { allPublishAccounts, createPublishApi, publishError, PublishFailure } from "./publish-api";
import { createVerifyApi } from "../../publish/verify/api";
const id = "019aa000-0000-7000-8000-000000000001";
const handlers = (): ApiHandlers => ({
  redirectToLogin: vi.fn(),
  stepUp: vi.fn(async () => true),
  refreshAccess: vi.fn(),
  invalidateQueries: vi.fn(),
  notify: vi.fn(),
  showBlocked: vi.fn(),
  buildMismatch: vi.fn(),
});
const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, message: "ok", data }), {
    headers: { "Content-Type": "application/json" },
  });
it("真实中央客户端：pack仅显式调用且HTTP200，step-up原键重放；撤销body不带虚构版本", async () => {
  const requests: Request[] = [],
    hooks = handlers();
  const api = createAdminApi({
    baseUrl: "https://publish.test",
    build: "w608",
    handlers: hooks,
    fetch: async (request) => {
      requests.push(request.clone());
      if (requests.length === 1)
        return new Response(JSON.stringify({ error: "STEP_UP_REQUIRED", message: "请再验证" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      if (new URL(request.url).pathname.endsWith("/revoke"))
        return ok({ launchSubmissionId: "019aa000-0000-7000-8000-000000000002" });
      return ok({
        deliveryReleaseId: id,
        zipState: "building",
        zipGen: 2,
        zipBundleId: id,
        zipFileId: null,
        publishListFileId: null,
      });
    },
  });
  const publish = createPublishApi({ api }),
    verify = createVerifyApi({ api }),
    signal = new AbortController().signal;
  expect(requests).toHaveLength(0);
  await publish.pack(id, "pack-one", signal);
  expect(hooks.stepUp).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(2);
  expect(requests.map((r) => r.headers.get("Idempotency-Key"))).toEqual(["pack-one", "pack-one"]);
  expect(await requests[1]!.json()).toEqual({});
  await verify.revoke(
    id,
    { reason: "修正核验", confirm: { roundNo: 2, verifiedEpisodeCount: 3 } },
    "revoke-one",
    signal,
  );
  expect(new URL(requests[2]!.url).pathname).toBe(`/api/v1/admin/launch-submissions/${id}/revoke`);
  expect(await requests[2]!.json()).toEqual({
    reason: "修正核验",
    confirm: { roundNo: 2, verifiedEpisodeCount: 3 },
  });
  await publish.get(id, signal);
  await publish.history(id, signal);
  expect(requests.slice(-2).map((r) => r.method)).toEqual(["GET", "GET"]);
  expect(new URL(requests.at(-1)!.url).pathname).toBe(`/api/v1/admin/order-items/${id}/downloads`);
});
it("全门店候选翻完全部页、去重，并过滤跨店及非available；分页缺失不能假完整", async () => {
  const requests: Request[] = [];
  const api = createPublishApi({
    api: createAdminApi({
      baseUrl: "https://publish.test",
      build: "w608",
      handlers: handlers(),
      fetch: async (request) => {
        requests.push(request);
        const page = Number(new URL(request.url).searchParams.get("page"));
        const row = (channelAccountId: string, storeId = id, status = "available") => ({
          channelAccountId,
          store: { storeId },
          platform: "douyin",
          status,
          accountName: channelAccountId,
        });
        return ok({
          page,
          pageSize: 2,
          total: 4,
          items:
            page === 1
              ? [row("old"), row("cross-store", "other")]
              : [row("new"), row("disabled", id, "abnormal")],
        });
      },
    }),
  });
  expect((await allPublishAccounts(api, id)).map((r) => r.channelAccountId)).toEqual([
    "old",
    "new",
  ]);
  expect(requests.map((r) => new URL(r.url).searchParams.get("page"))).toEqual(["1", "2"]);
  expect(
    requests.every(
      (r) =>
        new URL(r.url).searchParams.get("storeId") === id &&
        new URL(r.url).searchParams.get("status") === "available",
    ),
  ).toBe(true);
  await expect(
    allPublishAccounts(
      { accounts: vi.fn().mockResolvedValue({ page: 1, pageSize: 2, total: 3, items: [] }) },
      id,
    ),
  ).rejects.toThrow("分页不完整");
});
it("import保全部行列问题，正文保格式与空值", async () => {
  const issues = [
    { rowNo: 2, column: "标题", message: "标题过长" },
    { rowNo: 3, column: "话题", message: "话题重复" },
  ];
  const requests: Request[] = [];
  const api = createPublishApi({
    api: createAdminApi({
      baseUrl: "https://publish.test",
      build: "w608",
      handlers: handlers(),
      fetch: async (request) => {
        requests.push(request.clone());
        return new Response(
          JSON.stringify({
            error: "VALIDATION_FAILED",
            message: "清单行错误",
            details: { rows: issues },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      },
    }),
  });
  const failure = await api
    .import(
      id,
      { lockVersion: 7, format: "tsv", content: "集数\t标题\n1\t" },
      "import-one",
      new AbortController().signal,
    )
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(PublishFailure);
  expect(publishError(failure)).toContain("第 2 行 · 标题：标题过长");
  expect(publishError(failure)).toContain("话题重复");
  expect(await requests[0]!.json()).toEqual({
    lockVersion: 7,
    format: "tsv",
    content: "集数\t标题\n1\t",
  });
});
