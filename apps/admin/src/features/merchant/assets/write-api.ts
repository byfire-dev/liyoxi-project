import {
  AdminAssetDemandRowSchema,
  AdminAssetDemandListQuerySchema,
  AdminAssetDemandCreateBodySchema,
  AdminAssetDemandCancelBodySchema,
  AdminStoreAssetCreateBodySchema,
  AdminStoreAssetReviewBodySchema,
  AdminStoreAssetReprocessBodySchema,
  AdminStoreAssetDeleteBodySchema,
  AdminStoreAssetConfirmPortraitBodySchema,
  PortraitAuthBodySchema,
  DictItemListSchema,
  SignedUrlSchema,
  StaffBriefSchema,
  adminPage,
  z,
} from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { parseAssetDetail, parseAssetRow, unwrap } from "./api";

const StaffRead = StaffBriefSchema.extend({ roleKey: z.string(), status: z.string() });
const DemandRead = AdminAssetDemandRowSchema.extend({ createdBy: StaffRead });
export type AssetDemand = z.output<typeof DemandRead>;
export type AssetVocabulary = z.output<typeof DictItemListSchema>["items"];
export type DemandQuery = NonNullable<operations["admin.assetDemand.list"]["parameters"]["query"]>;
export type ReviewBody = z.output<typeof AdminStoreAssetReviewBodySchema>;
export type CreateBody = z.output<typeof AdminStoreAssetCreateBodySchema>;
export type ConfirmBody = z.output<typeof AdminStoreAssetConfirmPortraitBodySchema>;
export type DemandBody = z.output<typeof AdminAssetDemandCreateBodySchema>;
export function createAssetWriteApi({ api }: Pick<AppServices, "api">) {
  const c = api.client,
    headers = (key: string) => ({ "Idempotency-Key": key });
  return {
    async vocabulary(signal?: AbortSignal) {
      return DictItemListSchema.parse(
        await unwrap(
          await c.GET("/api/v1/admin/dict-items", {
            params: { query: { typeKey: "asset_tag" } },
            signal,
          }),
        ),
      ).items;
    },
    async demands(query: DemandQuery, signal?: AbortSignal) {
      AdminAssetDemandListQuerySchema.parse(query);
      const page = adminPage(DemandRead).parse(
        await unwrap(
          await c.GET("/api/v1/admin/asset-demands", {
            params: { query },
            signal,
          }),
        ),
      );
      if (page.items.some((row) => row.storeId !== query.storeId))
        throw new Error("需求归属已变化，请刷新门店");
      return page;
    },
    async review(id: string, body: ReviewBody, key: string, signal?: AbortSignal) {
      const data = await unwrap(
        await c.POST("/api/v1/admin/store-assets/{storeAssetId}/review", {
          params: { path: { storeAssetId: id } },
          body: AdminStoreAssetReviewBodySchema.parse(body),
          headers: headers(key),
          signal,
        }),
      );
      return parseAssetDetail(data);
    },
    async reprocess(
      id: string,
      body: z.output<typeof AdminStoreAssetReprocessBodySchema>,
      key: string,
      signal?: AbortSignal,
    ) {
      return parseAssetRow(
        await unwrap(
          await c.POST("/api/v1/admin/store-assets/{storeAssetId}/reprocess", {
            params: { path: { storeAssetId: id } },
            body: AdminStoreAssetReprocessBodySchema.parse(body),
            headers: headers(key),
            signal,
          }),
        ),
      );
    },
    async remove(
      id: string,
      body: z.output<typeof AdminStoreAssetDeleteBodySchema>,
      key: string,
      signal?: AbortSignal,
    ) {
      return unwrap(
        await c.POST("/api/v1/admin/store-assets/{storeAssetId}/delete", {
          params: { path: { storeAssetId: id } },
          body: AdminStoreAssetDeleteBodySchema.parse(body),
          headers: headers(key),
          signal,
        }),
      );
    },
    async portrait(
      id: string,
      body: z.output<typeof PortraitAuthBodySchema>,
      key: string,
      signal?: AbortSignal,
    ) {
      return parseAssetDetail(
        await unwrap(
          await c.POST("/api/v1/admin/store-assets/{storeAssetId}/portrait-auth", {
            params: { path: { storeAssetId: id } },
            body: PortraitAuthBodySchema.parse(body),
            headers: headers(key),
            signal,
          }),
        ),
      );
    },
    async confirm(id: string, body: ConfirmBody, key: string, signal?: AbortSignal) {
      return parseAssetDetail(
        await unwrap(
          await c.POST("/api/v1/admin/store-assets/{storeAssetId}/confirm-portrait-auth", {
            params: { path: { storeAssetId: id } },
            body: AdminStoreAssetConfirmPortraitBodySchema.parse(body),
            headers: headers(key),
            signal,
          }),
        ),
      );
    },
    async create(body: CreateBody, key: string, signal?: AbortSignal) {
      return parseAssetRow(
        await unwrap(
          await c.POST("/api/v1/admin/store-assets", {
            body: AdminStoreAssetCreateBodySchema.parse(body),
            headers: headers(key),
            signal,
          }),
        ),
      );
    },
    async createDemand(body: DemandBody, key: string, signal?: AbortSignal) {
      return DemandRead.parse(
        await unwrap(
          await c.POST("/api/v1/admin/asset-demands", {
            body: AdminAssetDemandCreateBodySchema.parse(body),
            headers: headers(key),
            signal,
          }),
        ),
      );
    },
    async cancelDemand(
      id: string,
      body: z.output<typeof AdminAssetDemandCancelBodySchema>,
      key: string,
      signal?: AbortSignal,
    ) {
      return DemandRead.parse(
        await unwrap(
          await c.POST("/api/v1/admin/asset-demands/{assetDemandId}/cancel", {
            params: { path: { assetDemandId: id } },
            body: AdminAssetDemandCancelBodySchema.parse(body),
            headers: headers(key),
            signal,
          }),
        ),
      );
    },
    async completeDemand(id: string, key: string, signal?: AbortSignal) {
      return DemandRead.parse(
        await unwrap(
          await c.POST("/api/v1/admin/asset-demands/{assetDemandId}/complete", {
            params: { path: { assetDemandId: id } },
            body: {},
            headers: headers(key),
            signal,
          }),
        ),
      );
    },
    async portraitUrl(fileId: string, signal?: AbortSignal) {
      return SignedUrlSchema.parse(
        await unwrap(
          await c.POST("/api/v1/admin/files/{fileId}/download-urls", {
            params: { path: { fileId } },
            body: { disposition: "inline", purpose: "核验肖像授权材料" },
            signal,
          }),
        ),
      );
    },
  };
}
export type AssetWriteApi = ReturnType<typeof createAssetWriteApi>;
