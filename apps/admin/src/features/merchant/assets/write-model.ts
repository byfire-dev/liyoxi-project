import {
  AdminStoreAssetReviewBodySchema,
  AdminStoreAssetCreateBodySchema,
  AdminStoreAssetConfirmPortraitBodySchema,
  AdminStoreAssetDeleteBodySchema,
  AdminStoreAssetReprocessBodySchema,
  PortraitAuthBodySchema,
  AdminAssetDemandCreateBodySchema,
  AdminAssetDemandCancelBodySchema,
} from "@liyoxi/contract";
import { canAction, type AccessSnapshot } from "../../../lib/permissions";
import type { AssetDetail } from "./api";
import { canReadAssets } from "./model";
import type { AssetDemand, AssetVocabulary, AssetWriteApi } from "./write-api";

export type AssetAction =
  "review" | "reprocess" | "delete" | "portrait-auth" | "confirm-portrait-auth";
export type AssetIntent =
  { kind: "create"; storeId: string; demandId?: string } | { kind: AssetAction; row: AssetDetail };
export const assetActionLabels: Record<AssetAction | "create", string> = {
  create: "代传素材",
  review: "整理素材",
  reprocess: "重新识别",
  delete: "删除素材",
  "portrait-auth": "补交肖像材料",
  "confirm-portrait-auth": "确认肖像授权",
};
export const assetPermission = (access: AccessSnapshot | null, permission: string) =>
  canReadAssets(access) && canAction(access, permission);
export function canAssetAction(
  access: AccessSnapshot | null,
  row: AssetDetail,
  action: AssetAction,
) {
  return (
    row.actions.includes(action) &&
    assetPermission(
      access,
      action === "portrait-auth" ? "merchant.asset.upload_on_behalf" : "merchant.asset.review",
    )
  );
}
export function canDemandAction(
  access: AccessSnapshot | null,
  row: AssetDemand,
  action: "cancel" | "complete",
) {
  return row.actions.includes(action) && assetPermission(access, "merchant.asset.demand.create");
}
export type AssetDraft = {
  title: string;
  content: string[];
  usage: string[];
  timeliness: string;
  from: string;
  to: string;
  usability: string;
  note: string;
  reason: string;
  kinds: string[];
  type: string;
  text: string;
};
export function assetDraft(intent: AssetIntent): AssetDraft {
  const row = intent.kind === "create" ? undefined : intent.row;
  return {
    title: row?.title ?? "",
    content:
      row?.contentTags
        .filter((t) => t.source === "reviewer" && t.isConfirmed)
        .map((t) => t.tag.code) ?? [],
    usage:
      row?.usageTags
        .filter((t) => t.source === "reviewer" && t.isConfirmed)
        .map((t) => t.tag.code) ?? [],
    timeliness: row?.timelinessTag?.source === "reviewer" ? row.timelinessTag.tag.code : "",
    from: row?.timelinessTag?.source === "reviewer" ? (row.timelinessTag.validStartDate ?? "") : "",
    to: row?.timelinessTag?.source === "reviewer" ? (row.timelinessTag.validEndDate ?? "") : "",
    usability:
      intent.kind === "confirm-portrait-auth"
        ? "reference_only"
        : (row?.usability ?? "reference_only"),
    note: "",
    reason: "",
    kinds: [],
    type: "text",
    text: "",
  };
}
export function tagOptions(
  vocabulary: AssetVocabulary,
  dimension: "content" | "usage" | "timeliness",
) {
  return vocabulary
    .filter(
      (item) => item.typeKey === "asset_tag" && item.isEnabled && item.ext.dimension === dimension,
    )
    .map((item) => ({ value: item.code, label: item.name }));
}
function tags(
  vocabulary: AssetVocabulary,
  values: readonly string[],
  dimension: "content" | "usage" | "timeliness",
) {
  const options = tagOptions(vocabulary, dimension);
  if (values.some((code) => !options.some((item) => item.value === code)))
    throw new Error("标签已变化，请重新选择当前可用字典项");
  return [...values];
}
function storedIds(files: readonly (string | null)[]) {
  if (!files.length || files.some((id) => !id))
    throw new Error("请等待每份文件成功入库，或移除未完成的上传位");
  return files.map((id) => {
    if (!id) throw new Error("文件尚未入库");
    return id;
  });
}
export interface AssetPrepared {
  body: unknown;
  send(api: AssetWriteApi, key: string, signal?: AbortSignal): Promise<unknown>;
}
/** 打开时的对象与版本是本次意图快照，确认后不从背景刷新替换。 */
export function prepareAsset(
  intent: AssetIntent,
  draft: AssetDraft,
  files: readonly (string | null)[],
  vocabulary: AssetVocabulary,
): AssetPrepared {
  if (intent.kind === "create") {
    const body = AdminStoreAssetCreateBodySchema.parse({
      storeId: intent.storeId,
      type: draft.type,
      ...(draft.type === "text"
        ? { textBody: draft.text.trim() }
        : { fileIds: storedIds(files), ...(draft.note.trim() ? { note: draft.note.trim() } : {}) }),
      ...(draft.content.length
        ? { contentTagCodes: tags(vocabulary, draft.content, "content") }
        : {}),
      ...(intent.demandId ? { assetDemandId: intent.demandId } : {}),
    });
    return { body, send: (api, key, signal) => api.create(body, key, signal) };
  }
  const row = intent.row;
  if (!row.actions.includes(intent.kind)) throw new Error("当前素材已不允许此操作，请刷新核对");
  if (intent.kind === "review") {
    if (row.processingState !== "processed" || row.moderationState === "block")
      throw new Error("素材尚未处理完成或已被拦截");
    const body = AdminStoreAssetReviewBodySchema.parse({
      lockVersion: row.lockVersion,
      title: draft.title.trim() || null,
      contentTagCodes: tags(vocabulary, draft.content, "content"),
      usageTagCodes: tags(vocabulary, draft.usage, "usage"),
      timeliness: {
        tagCode: tags(vocabulary, [draft.timeliness], "timeliness")[0],
        ...(draft.from ? { validStartDate: draft.from } : {}),
        ...(draft.to ? { validEndDate: draft.to } : {}),
      },
      usability: draft.usability,
    });
    return { body, send: (api, key, signal) => api.review(row.storeAssetId, body, key, signal) };
  }
  if (intent.kind === "confirm-portrait-auth") {
    if (!row.portraitAuthFileIds.length || row.portraitAuth.fileCount < 1)
      throw new Error("还没有肖像授权材料，不能确认");
    const body = AdminStoreAssetConfirmPortraitBodySchema.parse({
      lockVersion: row.lockVersion,
      usability: draft.usability,
      ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    });
    return { body, send: (api, key, signal) => api.confirm(row.storeAssetId, body, key, signal) };
  }
  if (intent.kind === "portrait-auth") {
    const body = PortraitAuthBodySchema.parse({ fileIds: storedIds(files) });
    return { body, send: (api, key, signal) => api.portrait(row.storeAssetId, body, key, signal) };
  }
  if (intent.kind === "delete") {
    const body = AdminStoreAssetDeleteBodySchema.parse({ reasonText: draft.reason.trim() });
    return { body, send: (api, key, signal) => api.remove(row.storeAssetId, body, key, signal) };
  }
  const body = AdminStoreAssetReprocessBodySchema.parse(
    draft.kinds.length ? { kinds: draft.kinds } : {},
  );
  return { body, send: (api, key, signal) => api.reprocess(row.storeAssetId, body, key, signal) };
}
export type DemandIntent =
  { kind: "create"; storeId: string } | { kind: "cancel" | "complete"; row: AssetDemand };
export const demandLabels = {
  create: "发起素材需求",
  cancel: "撤销素材需求",
  complete: "完成素材需求",
};
export function prepareDemand(
  intent: DemandIntent,
  draft: { title: string; note: string; dueDate: string; notifyScope: string },
): AssetPrepared {
  if (intent.kind === "create") {
    const body = AdminAssetDemandCreateBodySchema.parse({
      storeId: intent.storeId,
      title: draft.title.trim(),
      dueDate: draft.dueDate,
      notifyScope: draft.notifyScope,
      ...(draft.note.trim() ? { shootingNote: draft.note.trim() } : {}),
    });
    return { body, send: (api, key, signal) => api.createDemand(body, key, signal) };
  }
  if (!intent.row.actions.includes(intent.kind))
    throw new Error("当前需求已不允许此操作，请刷新核对");
  if (intent.kind === "complete")
    return {
      body: {},
      send: (api, key, signal) => api.completeDemand(intent.row.assetDemandId, key, signal),
    };
  const body = AdminAssetDemandCancelBodySchema.parse(
    draft.note.trim() ? { reasonText: draft.note.trim() } : {},
  );
  return {
    body,
    send: (api, key, signal) => api.cancelDemand(intent.row.assetDemandId, body, key, signal),
  };
}
