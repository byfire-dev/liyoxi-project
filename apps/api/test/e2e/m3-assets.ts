// W3-19：素材业务写入只走公开 HTTP；替身仅提供虚构图片字节与外部模型响应。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { M3Support } from "@liyoxi/services/testing";
import type { M1ChainContext } from "./runner.js";
import { createM1Caller, type M1Result } from "./runner-api.js";

export interface M3AssetsReport {
  readonly referenceAssetIds: readonly string[];
  readonly imageAssetId: string;
  readonly textAssetId: string;
  readonly portraitFileId: string;
  readonly unconfiguredSteps: readonly string[];
  readonly configuredInsightKinds: readonly string[];
}
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4o8AAAAASUVORK5CYII=",
    "base64",
  ),
);

export async function createM3Assets(
  context: M1ChainContext,
  m3: M3Support,
): Promise<M3AssetsReport> {
  assert.equal(context.support, m3, "素材与订单必须使用同一隔离支架");
  assert.equal(m3.runtime.env.APP_ENV, "test");
  const call = createM1Caller(context.api),
    merchant = context.owner.headers,
    admin = context.admin.headers;
  const assetParams = (storeAssetId: string) => ({ storeAssetId });

  async function readTagGroup() {
    const dictionaries = await call("m.dictItem.list", merchant, {
      query: { typeKey: "asset_tag" },
    });
    const group = dictionaries.items.find((item) => item.typeKey === "asset_tag");
    assert.ok(group, "必须从实际分组响应读取素材标签");
    return group.items;
  }
  let tagItems = await readTagGroup();
  // 前置种子只有内容标签；缺失维度通过正式字典接口分配编码，再读商家可选事实。
  for (const dimension of ["content", "usage", "timeliness"] as const) {
    if (tagItems.some((item) => item.isSelectable && item.ext.dimension === dimension)) continue;
    await call("admin.dictItem.create", admin, {
      body: {
        typeKey: "asset_tag",
        name: `M3虚构${dimension}`,
        description: "隔离素材合流演示标签",
        ext: { dimension },
      },
    });
    tagItems = await readTagGroup();
  }
  const tagCode = (dimension: "content" | "usage" | "timeliness") => {
    const item = tagItems.find((one) => one.isSelectable && one.ext.dimension === dimension);
    assert.ok(item, `正式字典缺少可选 ${dimension} 标签`);
    return item.code;
  };
  const contentCode = tagCode("content"),
    usageCode = tagCode("usage"),
    timelinessCode = tagCode("timeliness");

  async function storedImage(category: "store_asset" | "portrait_auth") {
    const registration = await call("m.file.create", merchant, {
      body: {
        category,
        files: [
          {
            fileName: `m3-${category}.png`,
            sizeBytes: String(png.length),
            clientToken: randomUUID(),
          },
        ],
      },
    });
    assert.equal(registration.items.length, 1);
    const file = registration.items[0]!;
    assert.equal(file.mode, "post");
    assert.ok(file.post, "商家小图必须取得真实预签表单");
    assert.equal(
      m3.providers.storage.upload(
        { ...file.post, key: file.key, expiresAt: new Date(file.expiresAt) },
        png,
      ),
      204,
    );
    await call("m.file.complete", merchant, { params: { fileId: file.fileId }, body: {} });
    await m3.promote(file.fileId);
    const stored = await call("m.file.get", merchant, { params: { fileId: file.fileId } });
    assert.equal(stored.status, "stored");
    assert.equal(stored.category, category);
    return file.fileId;
  }
  async function review(
    detail: M1Result<"admin.storeAsset.get">,
    usability: "ready" | "need_portrait_auth",
  ) {
    return call("admin.storeAsset.review", admin, {
      params: assetParams(detail.storeAssetId),
      body: {
        lockVersion: detail.lockVersion,
        contentTagCodes: [contentCode],
        usageTagCodes: [usageCode],
        timeliness: { tagCode: timelinessCode },
        usability,
      },
    });
  }

  // 正式预算为零仍执行真实任务并留 skipped 洞察；必须先排完这一代再切配置。
  m3.configureUnderstanding(false);
  const imageFileId = await storedImage("store_asset");
  const image = await call("m.storeAsset.create", merchant, {
    body: { type: "image", fileIds: [imageFileId] },
  });
  await m3.drainMedia({ assetIds: [image.storeAssetId] });
  let imageDetail = await call("admin.storeAsset.get", admin, {
    params: assetParams(image.storeAssetId),
  });
  assert.equal(imageDetail.processingState, "processed");
  assert.equal(imageDetail.isInsightPartial, true);
  const unconfiguredSteps = imageDetail.insightSteps
    .filter((step) => step.status === "skipped")
    .map((step) => step.kind);
  assert.ok(unconfiguredSteps.includes("vision"), "视觉预算未配置必须明确降级");
  assert.ok(unconfiguredSteps.includes("digest"), "摘要预算未配置必须明确降级");
  assert.equal(imageDetail.suggestion, null, "人工字段不能冒充模型建议");
  imageDetail = await review(imageDetail, "need_portrait_auth");
  assert.equal(imageDetail.usability, "need_portrait_auth");

  // 虚构授权图片只证明真实文件链；补交不等于授权，必须由后台实际确认。
  const portraitFileId = await storedImage("portrait_auth");
  await call("m.storeAsset.portraitAuth.create", merchant, {
    params: assetParams(image.storeAssetId),
    body: { fileIds: [portraitFileId] },
  });
  imageDetail = await call("admin.storeAsset.get", admin, {
    params: assetParams(image.storeAssetId),
  });
  assert.deepEqual(imageDetail.portraitAuthFileIds, [portraitFileId]);
  assert.equal(imageDetail.portraitAuth.authorizedAt, null);
  assert.equal(imageDetail.usability, "need_portrait_auth");
  imageDetail = await call("admin.storeAsset.confirmPortraitAuth", admin, {
    params: assetParams(image.storeAssetId),
    body: {
      lockVersion: imageDetail.lockVersion,
      usability: "ready",
      note: "虚构素材授权材料的隔离流程演示",
    },
  });
  assert.ok(imageDetail.portraitAuth.authorizedAt);
  assert.equal(imageDetail.usability, "ready");

  // 模型开关与预算是两个独立事实：先真实 HTTP 保存正式参数，再启用外部替身。
  const budgetKey = "media.model.daily_call_cap";
  const parameters = await call("admin.paramValue.list", admin, { query: { keys: budgetKey } });
  const parameter = parameters.items.find((item) => item.key === budgetKey);
  assert.ok(parameter, "必须消费已登记的正式模型日额度参数");
  const saved = await call("admin.paramValue.replace", admin, {
    body: {
      items: [{ key: budgetKey, value: 8, expectedRev: parameter.latestRev }],
      reason: "M3隔离素材理解验收",
    },
  });
  assert.equal(saved.items.find((item) => item.key === budgetKey)?.value, 8);
  m3.configureUnderstanding(true);
  m3.providers.llm.digestReplies.push({
    title: "M3虚构门店介绍",
    keypoints: ["虚构门店提供安静的阅读空间"],
    contentTags: [contentCode],
    suggestedUsage: [usageCode],
    suggestedTimeliness: { code: timelinessCode },
    faceHint: "none",
    qualityNotes: [],
  });
  const text = await call("m.storeAsset.create", merchant, {
    body: { type: "text", textBody: "虚构门店提供安静的阅读空间。仅用于隔离接口合流演示。" },
  });
  await m3.drainMedia({ assetIds: [text.storeAssetId] });
  let textDetail = await call("admin.storeAsset.get", admin, {
    params: assetParams(text.storeAssetId),
  });
  assert.equal(textDetail.processingState, "processed");
  assert.equal(textDetail.insightSteps.find((step) => step.kind === "digest")?.status, "ok");
  assert.deepEqual(textDetail.keypoints, ["虚构门店提供安静的阅读空间"]);
  assert.ok(textDetail.suggestion?.contentTags.some((tag) => tag.code === contentCode));
  assert.ok(textDetail.suggestion?.usageTags.some((tag) => tag.code === usageCode));
  const configuredInsightKinds = textDetail.insightSteps
    .filter((step) => step.status === "ok")
    .map((step) => step.kind);
  textDetail = await review(textDetail, "ready");
  assert.equal(textDetail.usability, "ready");
  // 仅切回替身配置；已完成洞察和业务事实不回写、不删除。
  m3.configureUnderstanding(false);

  const referenceAssetIds = [image.storeAssetId, text.storeAssetId];
  for (const storeAssetId of referenceAssetIds) {
    const detail = await call("m.storeAsset.get", merchant, { params: assetParams(storeAssetId) });
    assert.equal(detail.isSelectableAsReference, true);
    assert.equal(detail.adoptedCount, 0);
    const staffDetail = await call("admin.storeAsset.get", admin, {
      params: assetParams(storeAssetId),
    });
    assert.equal(staffDetail.storeId, context.owner.storeId);
    assert.deepEqual(staffDetail.usages, []);
  }
  return {
    referenceAssetIds,
    imageAssetId: image.storeAssetId,
    textAssetId: text.storeAssetId,
    portraitFileId,
    unconfiguredSteps,
    configuredInsightKinds,
  };
}

export async function verifyM3AssetUsage(
  context: M1ChainContext,
  report: M3AssetsReport,
  orderId: string,
  orderItemId: string,
): Promise<readonly { storeAssetId: string; referenceCount: number; adoptedCount: number }[]> {
  const call = createM1Caller(context.api);
  const result: { storeAssetId: string; referenceCount: number; adoptedCount: number }[] = [];
  for (const storeAssetId of report.referenceAssetIds) {
    const detail = await call("admin.storeAsset.get", context.admin.headers, {
      params: { storeAssetId },
    });
    assert.equal(detail.storeId, context.owner.storeId);
    const reference = detail.usages.filter(
      (usage) =>
        usage.usedByType === "drama_order" &&
        usage.usedById === orderId &&
        usage.role === "reference",
    );
    const adopted = detail.usages.filter(
      (usage) =>
        usage.usedByType === "order_item" &&
        usage.usedById === orderItemId &&
        usage.role === "adopted",
    );
    assert.equal(reference.length, 1, "本单引用必须由真实订单接口记账一次");
    assert.equal(adopted.length, 1, "双集提交应按订单项去重记账一次采用");
    assert.equal(detail.usages.length, 2, "本单仅有一条参考和一条订单项采用");
    assert.equal(detail.adoptedCount, 1);
    result.push({ storeAssetId, referenceCount: reference.length, adoptedCount: adopted.length });
  }
  return result;
}
