import { z } from "../../zod.js";
import { IdSchema, InstantSchema, openEnum, orNull } from "../../common/index.js";
import {
  StoreProfileBasicOwnerSchema,
  StoreProfileBasicPatchSchema,
  StoreProfileMediaOwnerSchema,
  StoreProfileMediaPatchSchema,
  StoreProfileServiceOwnerSchema,
  StoreProfileServicePatchSchema,
} from "../m03-profile-asset/profile.schemas.js";

/** a03§2.6：只有免审字段，修改原因/版本是控制字段。 */
export const PROXY_EDITABLE_FIELDS = [
  "brandName",
  "logoFileId",
  "businessHours",
  "storeTel",
  "avgSpendFen",
  "brandIntro",
  "serviceItems",
  "promoText",
  "groupBuyText",
  "sellingPointCodes",
  "sellingNote",
  "mediaGroups",
] as const;
export const PROXY_FORBIDDEN_FIELDS = [
  "storeName",
  "industryCode",
  "categoryCode",
  "address",
  "contactName",
  "contactPhone",
  "qualification",
] as const;
const basic = StoreProfileBasicPatchSchema.shape,
  service = StoreProfileServicePatchSchema.shape;
// 禁止键保留到领域判定，按正式FIELD_NOT_PROXY_EDITABLE返回，不能被Zod静默剥离。
const forbidden = z.unknown().optional().describe("禁止代改；出现即返回FIELD_NOT_PROXY_EDITABLE");
export const ProxyEditBodySchema = z
  .strictObject({
    lockVersion: z.int().min(0),
    reasonCode: z.enum([
      "merchant_phone_request",
      "merchant_wecom_request",
      "data_correction",
      "other",
    ]),
    note: z.string().max(60).optional(),
    brandName: basic.brandName,
    logoFileId: basic.logoFileId,
    businessHours: basic.businessHours,
    storeTel: basic.storeTel,
    avgSpendFen: basic.avgSpendFen,
    brandIntro: basic.brandIntro,
    serviceItems: service.serviceItems,
    promoText: service.promoText,
    groupBuyText: service.groupBuyText,
    sellingPointCodes: service.sellingPointCodes,
    sellingNote: service.sellingNote,
    mediaGroups: StoreProfileMediaPatchSchema.shape.groups.optional(),
    storeName: forbidden,
    industryCode: forbidden,
    categoryCode: forbidden,
    address: forbidden,
    contactName: forbidden,
    contactPhone: forbidden,
    qualification: forbidden,
  })
  .openapi("ProxyEditBody");
export const AdminStoreProfileSchema = z
  .object({
    storeId: IdSchema,
    ...StoreProfileBasicOwnerSchema.pick({
      brandName: true,
      logo: true,
      storeName: true,
      industry: true,
      category: true,
      address: true,
      businessHours: true,
      storeTel: true,
      avgSpendFen: true,
      brandIntro: true,
      completeness: true,
      pendingChange: true,
      lockVersion: true,
    }).shape,
    ...StoreProfileServiceOwnerSchema.pick({
      serviceItems: true,
      promoText: true,
      groupBuyText: true,
      sellingPoints: true,
      sellingNote: true,
    }).shape,
    media: StoreProfileMediaOwnerSchema.shape.groups,
    copiedFromStoreId: orNull(IdSchema),
    lastEditedAt: orNull(InstantSchema),
    lastEditor: orNull(
      z.object({
        actorType: openEnum(["merchant", "staff", "system", "partner"]),
        name: z.string().nullable(),
      }),
    ),
    proxyEditableFields: z.array(z.enum(PROXY_EDITABLE_FIELDS)),
    actions: z.array(z.literal("update")),
  })
  .openapi("AdminStoreProfile");
export type ProxyEditBody = z.infer<typeof ProxyEditBodySchema>;
