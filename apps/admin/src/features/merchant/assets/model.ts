import {
  AdminStoreAssetListQuerySchema,
  AdminAssetDemandListQuerySchema,
  IdSchema,
  z,
} from "@liyoxi/contract";
import { readContractQuery } from "../../../lib/contract-query";
import { hasModuleLevel, type AccessSnapshot } from "../../../lib/permissions";
import type { AssetDetail, AssetQuery, AssetRow, AssetSummaryQuery } from "./api";
const fields = AdminStoreAssetListQuerySchema.shape;
const demandFields = AdminAssetDemandListQuerySchema.shape;
const SearchSchema = z.strictObject({
  assetTab: fields.tab,
  assetId: IdSchema.optional(),
  q: fields.q,
  type: fields.type,
  usability: fields.usability,
  hasPortraitAuthFiles: fields.hasPortraitAuthFiles,
  assetDemandId: fields.assetDemandId,
  page: fields.page,
  pageSize: fields.pageSize,
  sort: fields.sort,
  demandStatus: demandFields.status,
  demandPage: demandFields.page,
  demandPageSize: demandFields.pageSize,
});
export const ASSET_KEYS = [
  "assetTab",
  "assetId",
  "q",
  "type",
  "usability",
  "hasPortraitAuthFiles",
  "assetDemandId",
  "page",
  "pageSize",
  "sort",
  "demandStatus",
  "demandPage",
  "demandPageSize",
] as const;
export const ASSET_FILTERS = [
  "type",
  "usability",
  "hasPortraitAuthFiles",
  "assetDemandId",
] as const;
export const ASSET_READ_KEY = ["merchant", "assets", "read"] as const;
export const typeLabels = {
  image: "图片",
  video: "视频",
  recording: "录音",
  audio: "音频",
  document: "文档",
  text: "文本",
} satisfies Record<AssetRow["type"], string>;
export const adminLabels = {
  organizing: "待整理",
  organized: "已整理",
  adopted: "已采用",
} satisfies Record<AssetRow["adminStatus"], string>;
export const processingLabels = {
  pending: "待处理",
  processing: "处理中",
  processed: "已处理",
} satisfies Record<AssetRow["processingState"], string>;
export const insightLabels = {
  transcript: "语音转写",
  vision: "画面理解",
  doc_text: "文档全文",
  structured_items: "结构化项目",
  digest: "综合洞察",
  tech_spec: "技术规格",
} satisfies Record<AssetDetail["insightSteps"][number]["kind"], string>;
export function fileKindLabel(kind: string): string {
  return Object.entries(typeLabels).find(([value]) => value === kind)?.[1] ?? "未识别文件类型";
}
export const canReadAssets = (access: AccessSnapshot | null) => hasModuleLevel(access, "merchant");
export function assetSearch(raw: Readonly<Record<string, unknown>>): Record<string, string> {
  const input = { ...raw };
  for (const key of ["pageSize", "demandPageSize"])
    if (![10, 20, 50].includes(Number(input[key]))) delete input[key];
  return readContractQuery(SearchSchema, input, {
    keys: ASSET_KEYS,
    defaults: { assetTab: "all", page: "1", pageSize: "20", sort: "-createdAt" },
    keywordLimit: 30,
  }).wire;
}
export function assetListQuery(
  storeId: string,
  raw: Readonly<Record<string, unknown>>,
): AssetQuery {
  if (!IdSchema.safeParse(storeId).success) throw new Error("门店地址不正确");
  const {
    assetTab,
    assetId,
    page,
    pageSize,
    sort,
    hasPortraitAuthFiles,
    demandStatus,
    demandPage,
    demandPageSize,
    ...filters
  } = assetSearch(raw);
  void assetId;
  void demandStatus;
  void demandPage;
  void demandPageSize;
  return {
    ...filters,
    storeId,
    page: Number(page),
    pageSize: Number(pageSize),
    tab: assetTab === "organizing" ? "organizing" : assetTab === "adopted" ? "adopted" : "all",
    sort: sort === "reviewDueAt" ? "reviewDueAt" : "-createdAt",
    ...(hasPortraitAuthFiles
      ? { hasPortraitAuthFiles: hasPortraitAuthFiles === "true" ? "true" : "false" }
      : {}),
  };
}
export function assetSummaryQuery(
  storeId: string,
  raw: Readonly<Record<string, unknown>>,
): AssetSummaryQuery {
  const { page, pageSize, sort, tab, ...filters } = assetListQuery(storeId, raw);
  void page;
  void pageSize;
  void sort;
  void tab;
  return filters;
}
export function selectedAsset(
  rows: readonly AssetRow[] | undefined,
  id: string | undefined,
  storeId: string,
): AssetRow | undefined {
  return rows?.find((row) => row.storeAssetId === id && row.storeId === storeId);
}
/** 不拼对象地址；仅消费本次详情真实签名且未过期的http(s)链接。 */
export function signedAssetUrl(
  url: string | null,
  expiresAt: string | null,
  now = Date.now(),
): string | undefined {
  if (!url || !expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now)
    return undefined;
  try {
    return ["https:", "http:"].includes(new URL(url).protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}
