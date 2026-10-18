import { AdminStoreAssetRowSchema, AdminStoreAssetDetailSchema } from "@liyoxi/contract";
import { describe, expect, it } from "vitest";
import { createAdminApi } from "../../../lib/api";
import type { AccessSnapshot } from "../../../lib/permissions";
import { assetListQuery, assetSearch, assetSummaryQuery } from "./model";
import { createAssetWriteApi, type AssetDemand, type AssetVocabulary } from "./write-api";
import {
  assetDraft,
  assetPermission,
  canAssetAction,
  canDemandAction,
  prepareAsset,
  prepareDemand,
  tagOptions,
} from "./write-model";

const id = "0199e187-e72a-7000-8000-000000000001",
  other = "0199e187-e72a-7000-8000-000000000002",
  fileId = "0199e187-e72a-7000-8000-000000000003",
  at = "2030-10-14T04:00:00.000Z";
const row = AdminStoreAssetRowSchema.parse({
  storeAssetId: id,
  storeId: id,
  storeName: "虚构门店",
  type: "text",
  title: "虚构文字",
  fileCount: 0,
  durationMs: null,
  pageCount: null,
  charCount: 8,
  thumbnail: null,
  usability: "need_portrait_auth",
  processingState: "processed",
  moderationState: "pass",
  adoptedCount: 0,
  createdAt: at,
  uploader: {
    actorType: "staff",
    role: null,
    displayName: "虚构员工",
    merchantUserId: null,
    staffId: other,
  },
  contentTags: [],
  hasUnconfirmedAutoTags: false,
  usageTags: [],
  timelinessTag: null,
  adminStatus: "organized",
  isInsightPartial: true,
  portraitAuth: { fileCount: 0, authorizedAt: null },
  reviewDueAt: null,
  isReviewOverdue: false,
  assetDemandId: null,
  sourceStoreAssetId: null,
  actions: ["review", "reprocess", "delete", "portrait-auth", "confirm-portrait-auth"],
});
const detail = AdminStoreAssetDetailSchema.parse({
  ...row,
  textBody: "虚构素材正文",
  note: null,
  files: [],
  transcript: null,
  keypoints: [],
  structuredItems: [],
  techSpecLabel: null,
  suggestion: null,
  insightSteps: [],
  portraitAuthFileIds: [],
  reviewedBy: null,
  reviewedAt: at,
  usages: [],
  lockVersion: 7,
});
const staff = {
  staffId: other,
  staffNo: 1001,
  name: "虚构员工",
  roleKey: "cs",
  isLead: false,
  status: "active",
};
const demand: AssetDemand = {
  assetDemandId: other,
  storeId: id,
  title: "虚构需求",
  shootingNote: null,
  dueDate: "2030-10-20",
  status: "open",
  isOverdue: false,
  receivedCount: 0,
  createdAt: at,
  notifyScope: "owner_only",
  createdBy: staff,
  closedAt: null,
  actions: ["complete", "cancel"],
};
const vocabulary: AssetVocabulary = ["content", "usage", "timeliness"].map((dimension, index) => ({
  dictItemId: id,
  typeKey: "asset_tag",
  code: `fixture_${dimension}`,
  parentCode: null,
  name: `虚构${dimension}`,
  description: null,
  isEnabled: true,
  tags: [],
  ext: { dimension },
  position: index,
  refCount: null,
  updatedAt: at,
  lockVersion: 0,
}));
const access: AccessSnapshot = {
  staff: { id: other, name: "虚构员工", roleKey: "cs", roleName: "客服" },
  isLead: false,
  moduleLevels: { merchant: "v" },
  dataScope: "own",
  releases: {},
  actions: [
    "merchant.asset.review",
    "merchant.asset.upload_on_behalf",
    "merchant.asset.demand.create",
  ],
};
const reviewedDraft = () => ({
  ...assetDraft({ kind: "review", row: detail }),
  content: ["fixture_content"],
  usage: ["fixture_usage"],
  timeliness: "fixture_timeliness",
});
const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, message: "ok", data }), {
    headers: { "Content-Type": "application/json" },
  });
function transport(reply?: (request: Request, index: number) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const api = createAssetWriteApi({
    api: createAdminApi({
      baseUrl: "http://admin.test",
      build: "w318-write",
      fetch: async (input) => {
        if (!(input instanceof Request)) throw new Error("必须使用真实Request");
        requests.push(input.clone());
        if (reply) return reply(input, requests.length);
        const path = new URL(input.url).pathname;
        if (path.endsWith("/delete"))
          return new Response(JSON.stringify({ code: 0, message: "ok" }), {
            headers: { "Content-Type": "application/json" },
          });
        if (path.includes("asset-demands"))
          return input.method === "GET"
            ? ok({ items: [demand], total: 1, page: 1, pageSize: 20 })
            : ok(demand);
        if (path.endsWith("/reprocess") || path.endsWith("/store-assets")) return ok(row);
        return ok(detail);
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

describe("W318素材写闭环聚合", () => {
  it("人工结论不被默认覆盖，三维字典和server actions共同约束，所见版本与材料缺失守卫真实", () => {
    expect(assetDraft({ kind: "review", row: detail }).usability).toBe("need_portrait_auth");
    expect(
      assetDraft({ kind: "review", row: { ...detail, usability: "need_reshoot" } }).usability,
    ).toBe("need_reshoot");
    expect(assetDraft({ kind: "confirm-portrait-auth", row: detail }).usability).toBe(
      "reference_only",
    );
    expect(canAssetAction(access, detail, "review")).toBe(true);
    expect(canAssetAction({ ...access, actions: [] }, detail, "review")).toBe(false);
    expect(canAssetAction(access, { ...detail, actions: [] }, "review")).toBe(false);
    expect(
      assetPermission({ ...access, moduleLevels: { system: "e" } }, "merchant.asset.review"),
    ).toBe(false);
    expect(tagOptions(vocabulary, "content")).toEqual([
      { value: "fixture_content", label: "虚构content" },
    ]);
    expect(
      tagOptions(
        vocabulary.map((item) => ({ ...item, isEnabled: false })),
        "usage",
      ),
    ).toEqual([]);
    const prepared = prepareAsset({ kind: "review", row: detail }, reviewedDraft(), [], vocabulary);
    expect(prepared.body).toEqual({
      lockVersion: 7,
      title: "虚构文字",
      contentTagCodes: ["fixture_content"],
      usageTagCodes: ["fixture_usage"],
      timeliness: { tagCode: "fixture_timeliness" },
      usability: "need_portrait_auth",
    });
    for (const draft of [
      { ...reviewedDraft(), content: [] },
      { ...reviewedDraft(), content: ["fixture_usage"] },
      { ...reviewedDraft(), from: "2030-10-21" },
      { ...reviewedDraft(), from: "2030-10-21", to: "2030-10-20" },
    ])
      expect(() => prepareAsset({ kind: "review", row: detail }, draft, [], vocabulary)).toThrow();
    expect(() =>
      prepareAsset(
        { kind: "review", row: { ...detail, processingState: "pending" } },
        reviewedDraft(),
        [],
        vocabulary,
      ),
    ).toThrow("尚未处理完成");
    expect(() =>
      prepareAsset(
        { kind: "review", row: { ...detail, actions: [] } },
        reviewedDraft(),
        [],
        vocabulary,
      ),
    ).toThrow("不允许");
    expect(() =>
      prepareAsset(
        { kind: "confirm-portrait-auth", row: detail },
        assetDraft({ kind: "confirm-portrait-auth", row: detail }),
        [],
        vocabulary,
      ),
    ).toThrow("还没有肖像授权材料");
  });

  it("真实POST保留打开时版本、失败同键重试与原正文，重识别/确认/软删除按各自正式信封", async () => {
    const current = { ...detail, lockVersion: 9 };
    const prepared = prepareAsset(
      { kind: "review", row: current },
      reviewedDraft(),
      [],
      vocabulary,
    );
    current.lockVersion = 10;
    const failed = transport((_request, index) =>
      index === 1
        ? new Response(
            JSON.stringify({
              code: 50300,
              error: "PROVIDER_UNAVAILABLE",
              message: "虚构依赖不可用",
            }),
            {
              status: 503,
              headers: { "Content-Type": "application/json" },
            },
          )
        : ok(detail),
    );
    await expect(prepared.send(failed.api, "asset-write:retry")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      status: 503,
    });
    await prepared.send(failed.api, "asset-write:retry");
    expect(failed.requests).toHaveLength(2);
    const bodies = await Promise.all(failed.requests.map((request) => request.json()));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toMatchObject({ lockVersion: 9 });
    expect(failed.requests.map((request) => request.headers.get("Idempotency-Key"))).toEqual([
      "asset-write:retry",
      "asset-write:retry",
    ]);
    const client = transport();
    await prepareAsset(
      { kind: "reprocess", row: detail },
      { ...reviewedDraft(), kinds: ["digest"] },
      [],
      vocabulary,
    ).send(client.api, "asset-write:reprocess");
    const withProof = {
      ...detail,
      portraitAuthFileIds: [fileId],
      portraitAuth: { fileCount: 1, authorizedAt: null },
    };
    await prepareAsset(
      { kind: "confirm-portrait-auth", row: withProof },
      assetDraft({ kind: "confirm-portrait-auth", row: withProof }),
      [],
      vocabulary,
    ).send(client.api, "asset-write:confirm");
    await expect(
      prepareAsset(
        { kind: "delete", row: detail },
        { ...reviewedDraft(), reason: "虚构验收结束" },
        [],
        vocabulary,
      ).send(client.api, "asset-write:delete"),
    ).resolves.toBeUndefined();
    expect(await Promise.all(client.requests.map((request) => request.json()))).toEqual([
      { kinds: ["digest"] },
      { lockVersion: 7, usability: "reference_only" },
      { reasonText: "虚构验收结束" },
    ]);
    expect(
      client.requests.every(
        (request) => request.method === "POST" && request.headers.get("X-LYX-Admin") === "1",
      ),
    ).toBe(true);
    expect(() =>
      prepareAsset({ kind: "delete", row: detail }, reviewedDraft(), [], vocabulary),
    ).toThrow();
  });

  it("代传只提交成功入库ID，文字与文件分离，肖像补交不能隐含授权，空位/重复/录音多文件均拒绝", async () => {
    const intent = { kind: "create" as const, storeId: id, demandId: other },
      draft = assetDraft(intent);
    const client = transport();
    await prepareAsset(intent, { ...draft, text: "本轮虚构文字响应" }, [fileId], vocabulary).send(
      client.api,
      "asset-write:text",
    );
    await prepareAsset(
      intent,
      { ...draft, type: "image", note: "虚构图片" },
      [fileId],
      vocabulary,
    ).send(client.api, "asset-write:image");
    const portrait = prepareAsset(
      { kind: "portrait-auth", row: detail },
      reviewedDraft(),
      [fileId],
      vocabulary,
    );
    await expect(portrait.send(client.api, "asset-write:portrait")).resolves.toMatchObject({
      usability: "need_portrait_auth",
      portraitAuth: { authorizedAt: null },
    });
    expect(await Promise.all(client.requests.map((request) => request.json()))).toEqual([
      { storeId: id, type: "text", textBody: "本轮虚构文字响应", assetDemandId: other },
      { storeId: id, type: "image", fileIds: [fileId], note: "虚构图片", assetDemandId: other },
      { fileIds: [fileId] },
    ]);
    for (const files of [[], [null], [fileId, null]])
      expect(() => prepareAsset(intent, { ...draft, type: "image" }, files, vocabulary)).toThrow(
        "成功入库",
      );
    expect(() =>
      prepareAsset(intent, { ...draft, type: "recording" }, [id, fileId], vocabulary),
    ).toThrow();
    expect(() =>
      prepareAsset(
        { kind: "portrait-auth", row: detail },
        reviewedDraft(),
        [fileId, fileId],
        vocabulary,
      ),
    ).toThrow();
    expect(portrait.body).not.toHaveProperty("usability");
    expect(portrait.body).not.toHaveProperty("authorizedAt");
  });

  it("需求分页筛选独立入URL且不泄入素材查询，创建/撤销/完成同范围权限与required正文，外店响应拒读", async () => {
    const search = assetSearch({
      demandStatus: "open,done",
      demandPage: 2,
      demandPageSize: 50,
      assetDemandId: other,
      type: "text",
    });
    expect(search).toMatchObject({
      demandStatus: "open,done",
      demandPage: "2",
      demandPageSize: "50",
    });
    for (const query of [assetListQuery(id, search), assetSummaryQuery(id, search)]) {
      expect(query).not.toHaveProperty("demandStatus");
      expect(query).not.toHaveProperty("demandPage");
      expect(query).toMatchObject({ storeId: id, assetDemandId: other, type: "text" });
    }
    expect(canDemandAction(access, demand, "complete")).toBe(true);
    expect(canDemandAction({ ...access, actions: [] }, demand, "complete")).toBe(false);
    expect(canDemandAction(access, { ...demand, actions: [] }, "cancel")).toBe(false);
    const client = transport(),
      draft = {
        title: "虚构需求",
        note: "虚构拍摄要求",
        dueDate: "2030-10-20",
        notifyScope: "owner_only",
      };
    await client.api.demands({ storeId: id, page: 2, pageSize: 50, status: "open,done" });
    await prepareDemand({ kind: "create", storeId: id }, draft).send(
      client.api,
      "asset-write:demand-create",
    );
    await prepareDemand({ kind: "complete", row: demand }, draft).send(
      client.api,
      "asset-write:demand-complete",
    );
    await prepareDemand({ kind: "cancel", row: demand }, draft).send(
      client.api,
      "asset-write:demand-cancel",
    );
    expect(Object.fromEntries(new URL(client.requests[0]!.url).searchParams)).toEqual({
      storeId: id,
      page: "2",
      pageSize: "50",
      status: "open,done",
    });
    expect(await Promise.all(client.requests.slice(1).map((request) => request.json()))).toEqual([
      {
        storeId: id,
        title: "虚构需求",
        shootingNote: "虚构拍摄要求",
        dueDate: "2030-10-20",
        notifyScope: "owner_only",
      },
      {},
      { reasonText: "虚构拍摄要求" },
    ]);
    expect(
      client.requests.slice(1).every((request) => request.headers.has("Idempotency-Key")),
    ).toBe(true);
    expect(() => prepareDemand({ kind: "cancel", row: { ...demand, actions: [] } }, draft)).toThrow(
      "不允许",
    );
    expect(() =>
      prepareDemand({ kind: "create", storeId: id }, { ...draft, dueDate: "2030-02-30" }),
    ).toThrow();
    const foreign = transport(() =>
      ok({ items: [{ ...demand, storeId: fileId }], page: 1, pageSize: 20, total: 1 }),
    );
    await expect(foreign.api.demands({ storeId: id })).rejects.toThrow("需求归属已变化");
  });
});
