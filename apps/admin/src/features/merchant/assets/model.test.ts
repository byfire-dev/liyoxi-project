import {
  AdminStoreAssetListQuerySchema,
  AdminStoreAssetSummaryQuerySchema,
} from "@liyoxi/contract";
import { describe, expect, it } from "vitest";
import { createAdminApi } from "../../../lib/api";
import type { AccessSnapshot } from "../../../lib/permissions";
import { createQueryClient } from "../../../lib/query";
import { merchantDetailSearch, merchantScope } from "../detail/model";
import { createAssetReadApi, type AssetDetail, type AssetRow } from "./api";
import {
  ASSET_READ_KEY,
  adminLabels,
  assetListQuery,
  assetSearch,
  assetSummaryQuery,
  canReadAssets,
  fileKindLabel,
  insightLabels,
  processingLabels,
  selectedAsset,
  signedAssetUrl,
} from "./model";

const id = "0199e187-e72a-7000-8000-000000000001",
  other = "0199e187-e72a-7000-8000-000000000002",
  fileId = "0199e187-e72a-7000-8000-000000000003",
  now = "2030-10-14T04:00:00.000Z",
  expiresAt = "2030-10-14T04:05:00.000Z";
const row: AssetRow = {
  storeAssetId: id,
  storeId: id,
  storeName: "虚构门店",
  type: "document",
  title: "虚构素材",
  fileCount: 1,
  durationMs: null,
  pageCount: 2,
  charCount: 8,
  thumbnail: null,
  usability: null,
  processingState: "processed",
  moderationState: "pass",
  adoptedCount: 0,
  createdAt: now,
  uploader: {
    actorType: "staff",
    role: null,
    displayName: "虚构上传员工",
    merchantUserId: null,
    staffId: other,
  },
  contentTags: [],
  hasUnconfirmedAutoTags: false,
  usageTags: [],
  timelinessTag: null,
  adminStatus: "organizing",
  isInsightPartial: true,
  portraitAuth: { fileCount: 0, authorizedAt: null },
  reviewDueAt: null,
  isReviewOverdue: false,
  assetDemandId: null,
  sourceStoreAssetId: null,
  actions: ["review", "delete"],
};
const detail: AssetDetail = {
  ...row,
  textBody: "<script>虚构正文按文本展示</script>",
  note: null,
  files: [
    {
      fileId,
      kind: "document",
      url: "https://signed.test/document?signature=fixture",
      expiresAt,
      coverUrl: null,
      durationMs: null,
      displayWidth: null,
      displayHeight: null,
      moderationState: "pass",
    },
  ],
  transcript: { text: "虚构完整转写", segments: [{ fromMs: 0, toMs: 1000, text: "虚构分句" }] },
  keypoints: ["虚构要点"],
  structuredItems: [{ name: "虚构项目", priceText: null }],
  techSpecLabel: "两页文档",
  suggestion: {
    contentTags: [{ code: "fixture", name: "机器建议内容" }],
    usageTags: [],
    timeliness: {
      tag: { code: "season", name: "机器建议时效" },
      validStartDate: "2030-10-01",
      validEndDate: "2030-10-31",
    },
    faceHint: "identifiable_customer",
    qualityNotes: ["仅机器建议，不构成人工授权"],
    description: null,
  },
  insightSteps: [
    { kind: "doc_text", status: "ok" },
    { kind: "digest", status: "failed" },
  ],
  portraitAuthFileIds: [],
  reviewedBy: null,
  reviewedAt: null,
  usages: [],
  lockVersion: 7,
};
const summary = {
  tabs: { all: 3, organizing: 2, adopted: 1 },
  organizedCount: 1,
  types: { image: 0, video: 0, recording: 0, audio: 0, document: 1, text: 2 },
  awaitingPortraitConfirmCount: 0,
  reviewOverdueCount: 0,
};
const access: AccessSnapshot = {
  staff: { id: other, name: "虚构员工", roleKey: "cs", roleName: "客服" },
  isLead: false,
  moduleLevels: { merchant: "v" },
  actions: [],
  dataScope: "own",
  releases: {},
};
const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, message: "ok", data }), {
    headers: { "Content-Type": "application/json" },
  });
function transport(reply: (request: Request, index: number) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const api = createAssetReadApi({
    api: createAdminApi({
      baseUrl: "http://admin.test",
      build: "w318",
      fetch: async (input) => {
        if (!(input instanceof Request)) throw new Error("必须使用真实Request");
        requests.push(input.clone());
        return reply(input, requests.length);
      },
      handlers: {
        redirectToLogin() {},
        stepUp: async () => false,
        refreshAccess() {},
        invalidateQueries() {},
        notify() {},
        showBlocked() {},
        buildMismatch() {},
      },
    }),
  });
  return { api, requests };
}

describe("W318商家素材只读checkpoint", () => {
  it("正式筛选和两种排序同范围，路径门店固定且只读权限与当前页选择有效", () => {
    const raw = {
      storeId: other,
      assetTab: "organizing",
      assetId: id,
      q: " 虚构素材 ",
      type: "text,document",
      usability: "ready,reference_only",
      hasPortraitAuthFiles: false,
      assetDemandId: other,
      page: 3,
      pageSize: 50,
      sort: "reviewDueAt",
      private: "drop",
    };
    const list = assetListQuery(id, raw),
      { page, pageSize, sort, tab, ...filters } = list;
    expect({ page, pageSize, sort, tab }).toEqual({
      page: 3,
      pageSize: 50,
      sort: "reviewDueAt",
      tab: "organizing",
    });
    expect(list).toMatchObject({
      storeId: id,
      q: "虚构素材",
      type: "text,document",
      hasPortraitAuthFiles: "false",
    });
    expect(list).not.toHaveProperty("assetId");
    expect(assetSummaryQuery(id, raw)).toEqual(filters);
    expect(AdminStoreAssetListQuerySchema.safeParse(list).success).toBe(true);
    expect(AdminStoreAssetSummaryQuerySchema.safeParse(filters).success).toBe(true);
    for (const order of ["-createdAt", "reviewDueAt"]) {
      expect(assetSearch({ sort: order }).sort).toBe(order);
      expect(
        AdminStoreAssetListQuerySchema.safeParse(assetListQuery(id, { sort: order })).success,
      ).toBe(true);
    }
    expect(
      assetSearch({
        sort: "createdAt",
        assetId: "bad",
        page: -1,
        pageSize: 100,
        type: "unknown",
        q: "x".repeat(40),
      }),
    ).toEqual({
      assetTab: "all",
      page: "1",
      pageSize: "20",
      sort: "-createdAt",
      q: "x".repeat(30),
    });
    expect(() => assetListQuery("not-a-store-id", raw)).toThrow("门店地址不正确");
    expect(merchantDetailSearch({ tab: "assets", ...raw })).toMatchObject({
      tab: "assets",
      assetTab: "organizing",
      assetId: id,
    });
    expect(merchantDetailSearch({ tab: "qualification", assetId: id })).toEqual({
      tab: "qualification",
    });
    expect(canReadAssets(access)).toBe(true);
    expect(canReadAssets(null)).toBe(false);
    expect(canReadAssets({ ...access, moduleLevels: { system: "e" } })).toBe(false);
    expect(selectedAsset([row], id, id)).toBe(row);
    expect(selectedAsset([row], id, other)).toBeUndefined();
    expect(selectedAsset([], id, id)).toBeUndefined();
  });

  it("真实GET带相同过滤，旧员工范围迟到结果不会覆盖当前门店列表且无写请求", async () => {
    let release!: (response: Response) => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { api, requests } = transport((request, index) => {
      if (index === 1)
        return new Promise<Response>((resolve) => {
          release = resolve;
          entered();
        });
      return new URL(request.url).pathname.endsWith("summary")
        ? ok(summary)
        : ok({ items: [row], total: 3, page: 1, pageSize: 20 });
    });
    const cache = createQueryClient(),
      oldQuery = assetListQuery(id, { q: "旧范围" }),
      query = assetListQuery(id, {
        q: "新范围",
        type: "text,document",
        hasPortraitAuthFiles: false,
      }),
      oldKey = [...ASSET_READ_KEY, merchantScope(access), id, "list", oldQuery],
      key = [...ASSET_READ_KEY, merchantScope({ ...access, dataScope: "all" }), id, "list", query];
    try {
      const slow = cache.fetchQuery({
        queryKey: oldKey,
        queryFn: ({ signal }) => api.list(oldQuery, signal),
      });
      await ready;
      await cache.fetchQuery({ queryKey: key, queryFn: ({ signal }) => api.list(query, signal) });
      expect(await api.summary(assetSummaryQuery(id, query))).toEqual(summary);
      release(ok({ items: [], total: 0, page: 1, pageSize: 20 }));
      await slow;
      expect(cache.getQueryData(key)).toMatchObject({ total: 3, items: [row] });
      expect(cache.getQueryData(oldKey)).toMatchObject({ total: 0, items: [] });
      const listParams = new URL(requests[1]!.url).searchParams;
      for (const field of ["page", "pageSize", "sort", "tab"]) listParams.delete(field);
      expect(Object.fromEntries(new URL(requests[2]!.url).searchParams)).toEqual(
        Object.fromEntries(listParams),
      );
      expect(
        requests.every(
          (request) => request.method === "GET" && !request.headers.has("Idempotency-Key"),
        ),
      ).toBe(true);
    } finally {
      cache.clear();
    }
  });

  it("详情现签/所属与正式响应重验，开放枚举保守中文，机器结果不成为人工授权并可中止", async () => {
    let reply: (request: Request) => Response | Promise<Response> = () => ok(detail);
    const { api, requests } = transport((request) => reply(request));
    await expect(api.detail({ ...row, storeId: other }, id)).rejects.toThrow("不属于当前门店");
    expect(requests).toHaveLength(0);
    const actual = await api.detail(row, id);
    expect(actual).toEqual(detail);
    expect(actual).toMatchObject({
      processingState: "processed",
      adminStatus: "organizing",
      reviewedAt: null,
      portraitAuth: { authorizedAt: null },
      techSpecLabel: "两页文档",
      timelinessTag: null,
      suggestion: { timeliness: { tag: { name: "机器建议时效" } } },
    });
    expect(processingLabels[actual.processingState]).toBe("已处理");
    expect(adminLabels[actual.adminStatus]).toBe("待整理");
    expect(insightLabels[actual.insightSteps[0]!.kind]).toBe("文档全文");
    expect(signedAssetUrl(actual.files[0]!.url, actual.files[0]!.expiresAt, Date.parse(now))).toBe(
      detail.files[0]!.url,
    );
    for (const url of [
      "javascript:alert(1)",
      "data:text/plain,private",
      "/objects/private",
      "not a url",
    ])
      expect(signedAssetUrl(url, expiresAt, Date.parse(now))).toBeUndefined();
    expect(signedAssetUrl(detail.files[0]!.url, expiresAt, Date.parse(expiresAt))).toBeUndefined();
    expect(signedAssetUrl(detail.files[0]!.url, null)).toBeUndefined();
    reply = () =>
      ok({
        ...detail,
        files: [{ ...detail.files[0], kind: "future_file", moderationState: "future_moderation" }],
        reviewedBy: {
          staffId: other,
          staffNo: 1001,
          name: "虚构审核员工",
          roleKey: "future_role",
          isLead: false,
          status: "future_status",
        },
      });
    const future = await api.detail(row, id);
    expect(future.files[0]!.kind).toBe("future_file");
    expect(fileKindLabel("document")).toBe("文档");
    for (const kind of ["future_file", "__proto__", "toString"])
      expect(fileKindLabel(kind)).toBe("未识别文件类型");
    reply = () => ok({ ...detail, processingState: "invented" });
    await expect(api.detail(row, id)).rejects.toThrow("不符合契约");
    reply = () => ok({ ...detail, storeId: other });
    await expect(api.detail(row, id)).rejects.toThrow("素材归属已变化");
    reply = () =>
      new Response(
        JSON.stringify({ code: 40300, error: "PERMISSION_DENIED", message: "没有访问权限" }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      );
    await expect(api.detail(row, id)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      status: 403,
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    reply = (request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(new DOMException("离开当前素材", "AbortError")),
          { once: true },
        );
        entered();
      });
    const controller = new AbortController(),
      pending = api.detail(row, id, controller.signal);
    await ready;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requests.at(-1)!.signal.aborted).toBe(true);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });
});
