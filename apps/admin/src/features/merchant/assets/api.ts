import {
  AdminStoreAssetDetailSchema,
  AdminStoreAssetRowSchema,
  AdminStoreAssetSummarySchema,
  MediaFileViewSchema,
  StaffBriefSchema,
  adminPage,
  z,
} from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure } from "../../../lib/api-errors";
import { MerchantFailure } from "../detail/api";
// 只放开正式 x-open-enum 读字段；列表和业务状态继续按实际闭集契约解析。
const FileRead = MediaFileViewSchema.extend({ kind: z.string(), moderationState: z.string() });
const StaffRead = StaffBriefSchema.extend({ roleKey: z.string(), status: z.string() });
const DetailRead = AdminStoreAssetDetailSchema.extend({
  files: z.array(FileRead),
  reviewedBy: StaffRead.nullable(),
});
const PageRead = adminPage(AdminStoreAssetRowSchema);
export type AssetRow = z.output<typeof AdminStoreAssetRowSchema>;
export type AssetDetail = z.output<typeof DetailRead>;
export type AssetQuery = NonNullable<operations["admin.storeAsset.list"]["parameters"]["query"]>;
export type AssetSummaryQuery = NonNullable<
  operations["admin.storeAsset.summary"]["parameters"]["query"]
>;
async function unwrap<T>(result: {
  data?: { data: T };
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (result.data) return result.data.data;
  const failure = await readFailure(
    result.error === undefined
      ? result.response
      : new Response(JSON.stringify(result.error), {
          status: result.response.status,
          headers: result.response.headers,
        }),
  );
  throw new MerchantFailure(failure.message, failure.symbol, failure.status, failure.body?.details);
}
function parse<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("素材响应不符合契约，请刷新重试");
  return parsed.data;
}
export function createAssetReadApi({ api }: Pick<AppServices, "api">) {
  return {
    list: (query: AssetQuery, signal?: AbortSignal) =>
      api.client
        .GET("/api/v1/admin/store-assets", { params: { query }, signal })
        .then(unwrap)
        .then((value) => parse(PageRead, value)),
    summary: (query: AssetSummaryQuery, signal?: AbortSignal) =>
      api.client
        .GET("/api/v1/admin/store-assets/summary", { params: { query }, signal })
        .then(unwrap)
        .then((value) => parse(AdminStoreAssetSummarySchema, value)),
    async detail(
      row: Pick<AssetRow, "storeAssetId" | "storeId">,
      storeId: string,
      signal?: AbortSignal,
    ) {
      if (row.storeId !== storeId) throw new Error("所选素材不属于当前门店，请重新选择");
      const result = await api.client.GET("/api/v1/admin/store-assets/{storeAssetId}", {
        params: { path: { storeAssetId: row.storeAssetId } },
        signal,
      });
      const value = parse(DetailRead, await unwrap(result));
      if (value.storeId !== storeId || value.storeAssetId !== row.storeAssetId)
        throw new Error("素材归属已变化，请刷新列表");
      return value;
    },
  };
}
export type AssetReadApi = ReturnType<typeof createAssetReadApi>;
