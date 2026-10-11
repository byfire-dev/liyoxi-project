import { z } from "../../zod.js";
import { IdSchema } from "../../common/index.js";

export const STORE_COPY_OPTIONS = ["basic", "service", "media", "brand_assets"] as const;
export const StoreCreateBodySchema = z
  .strictObject({
    name: z
      .string()
      .trim()
      .refine((value) => [...value].length >= 2 && [...value].length <= 30),
    addressDetail: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim().length > 0),
    industryCode: z.string().min(1).max(64),
    categoryCode: z.string().min(1).max(64),
    copyFromStoreId: IdSchema.nullable().optional(),
    copyOptions: z.array(z.enum(STORE_COPY_OPTIONS)).max(4).optional(),
  })
  .refine((value) => new Set(value.copyOptions).size === (value.copyOptions?.length ?? 0), {
    path: ["copyOptions"],
    message: "复制项不能重复",
  })
  .refine((value) => !value.copyOptions?.length || !!value.copyFromStoreId, {
    path: ["copyFromStoreId"],
    message: "勾选复制项时必须提供来源门店",
  })
  .openapi("StoreCreateBody");
export type StoreCreateBody = z.infer<typeof StoreCreateBodySchema>;
