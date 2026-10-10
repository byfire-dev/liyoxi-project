import { expect, it } from "vitest";
import { mStoreAssetPortraitAuthCreate } from "./store-assets.js";
import {
  adminStoreAssetConfirmPortraitAuth,
  adminStoreAssetPortraitAuthCreate,
  adminStoreAssetReview,
} from "../a03-merchant/store-assets.js";
import {
  StoreAssetCreateBodySchema,
  StoreAssetDetailSchema,
  StoreAssetListQuerySchema,
  PortraitAuthBodySchema,
  AssetFeedbackBodySchema,
} from "./store-assets.schemas.js";
import {
  AdminStoreAssetReviewBodySchema,
  AdminStoreAssetDetailSchema,
  AdminStoreAssetReprocessBodySchema,
  AdminAssetDemandCreateBodySchema,
  AdminStoreAssetListQuerySchema,
} from "../a03-merchant/store-assets.schemas.js";

const id = "01900000-0000-7000-8000-000000000001";
it("六类素材遵守正文/文件/录音单文件边界，未知字段和超限拒绝", () => {
  for (const type of ["image", "video", "recording", "audio", "document"])
    expect(StoreAssetCreateBodySchema.parse({ type, fileIds: [id] })).toEqual({
      type,
      fileIds: [id],
    });
  expect(StoreAssetCreateBodySchema.parse({ type: "text", textBody: "实际正文" })).toEqual({
    type: "text",
    textBody: "实际正文",
  });
  for (const invalid of [
    { type: "text", textBody: "正文", fileIds: [id] },
    { type: "text", textBody: "正文", note: "说明" },
    { type: "image", textBody: "正文" },
    { type: "recording", fileIds: [id, id] },
    { type: "audio", fileIds: [] },
    { type: "text", textBody: "字".repeat(501) },
    { type: "unknown", fileIds: [id] },
    { type: "image", fileIds: [id], ready: true },
  ])
    expect(StoreAssetCreateBodySchema.safeParse(invalid).success).toBe(false);
});

it("ID回显不能混筛选，boolean只接受正式query字符串且严格校验重复项", () => {
  expect(StoreAssetListQuerySchema.parse({ ids: id }).ids).toBe(id);
  expect(
    StoreAssetListQuerySchema.parse({ isSelectableAsReference: "false" }).isSelectableAsReference,
  ).toBe(false);
  for (const invalid of [
    { ids: `${id},${id}` },
    { ids: id, q: "混筛选" },
    { ids: "bad-id" },
    { isSelectableAsReference: "1" },
    { status: "ready,ready" },
    { unknown: "true" },
  ])
    expect(StoreAssetListQuerySchema.safeParse(invalid).success).toBe(false);
  expect(AdminStoreAssetListQuerySchema.safeParse({ tab: "all" }).success).toBe(false);
  expect(AdminStoreAssetListQuerySchema.safeParse({ tab: "organizing" }).success).toBe(true);
});

it("复核CAS、三维标签和成对时效必需；重处理步骤不能重复或为未知kind", () => {
  const valid = {
    lockVersion: 0,
    contentTagCodes: ["content"],
    usageTagCodes: ["usage"],
    timeliness: { tagCode: "time", validStartDate: "2026-10-10", validEndDate: "2026-10-11" },
    usability: "need_portrait_auth",
  };
  expect(AdminStoreAssetReviewBodySchema.parse(valid)).toEqual(valid);
  for (const invalid of [
    { ...valid, lockVersion: -1 },
    { ...valid, contentTagCodes: [] },
    { ...valid, usageTagCodes: ["usage", "usage"] },
    { ...valid, timeliness: { tagCode: "time", validStartDate: "2026-10-10" } },
    {
      ...valid,
      timeliness: { tagCode: "time", validStartDate: "2026-10-11", validEndDate: "2026-10-10" },
    },
  ])
    expect(AdminStoreAssetReviewBodySchema.safeParse(invalid).success).toBe(false);
  expect(
    AdminStoreAssetReprocessBodySchema.parse({ kinds: ["structured_items", "digest"] }).kinds,
  ).toEqual(["structured_items", "digest"]);
  expect(
    AdminStoreAssetReprocessBodySchema.safeParse({ kinds: ["digest", "digest"] }).success,
  ).toBe(false);
  expect(AdminStoreAssetReprocessBodySchema.safeParse({ kinds: ["probe"] }).success).toBe(false);
});

it("肖像/反馈/需求写严格上限，通知对象沿原枚举", () => {
  expect(PortraitAuthBodySchema.safeParse({ fileIds: [id, id] }).success).toBe(false);
  expect(AssetFeedbackBodySchema.safeParse({ content: "字".repeat(201) }).success).toBe(false);
  const demand = {
    storeId: id,
    title: "招牌内容",
    dueDate: "2026-10-10",
    notifyScope: "owner_and_clerks",
  };
  expect(AdminAssetDemandCreateBodySchema.parse(demand)).toEqual(demand);
  expect(
    AdminAssetDemandCreateBodySchema.safeParse({ ...demand, notifyScope: "owner" }).success,
  ).toBe(false);
  expect(
    AdminAssetDemandCreateBodySchema.safeParse({ ...demand, title: "字".repeat(21) }).success,
  ).toBe(false);
});

it("四个详情写接口按正式数组段路径脱敏回放，签名字段全部覆盖", () => {
  for (const route of [
    mStoreAssetPortraitAuthCreate,
    adminStoreAssetConfirmPortraitAuth,
    adminStoreAssetPortraitAuthCreate,
    adminStoreAssetReview,
  ])
    expect(route["x-redact-on-replay"]).toEqual([
      "thumbnail",
      "files[].url",
      "files[].expiresAt",
      "files[].coverUrl",
    ]);
});

it("商家要点按C57命名但保留原字符串数组，后台与菜单价格类型不变", () => {
  const highlights = ["同一真实要点", "第二条要点"];
  expect(StoreAssetDetailSchema.shape.highlights.parse(highlights)).toEqual(highlights);
  expect("keypoints" in StoreAssetDetailSchema.shape).toBe(false);
  expect(AdminStoreAssetDetailSchema.shape.keypoints.parse(highlights)).toEqual(highlights);
  expect(StoreAssetDetailSchema.shape.highlights.safeParse([1]).success).toBe(false);
  expect(
    StoreAssetDetailSchema.shape.structuredItems.parse([{ name: "套餐", priceText: "68元" }]),
  ).toEqual([{ name: "套餐", priceText: "68元" }]);
  expect(
    StoreAssetDetailSchema.shape.structuredItems.safeParse([{ name: "套餐", priceText: 68 }])
      .success,
  ).toBe(false);
});
