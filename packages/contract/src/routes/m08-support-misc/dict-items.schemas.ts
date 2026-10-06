// m08 2.3、3.2：小程序可见的有界字典集合，与后台字典结构分开。
import { z } from "../../zod.js";

export const MerchantDictItemListQuerySchema = z.object({
  typeKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*(?:,[a-z][a-z0-9_]*){0,9}$/)
    .transform((value) => value.split(",")),
  parentCode: z.string().min(1).optional(),
  includeDisabled: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export const MerchantDictItemViewSchema = z
  .object({
    code: z.string(),
    parentCode: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    tags: z.array(z.string()),
    ext: z.record(z.string(), z.unknown()),
    position: z.int(),
    isSelectable: z.boolean(),
  })
  .openapi("MerchantDictItemView");
export type MerchantDictItemView = z.infer<typeof MerchantDictItemViewSchema>;

export const DictTypeItemsSchema = z
  .object({
    typeKey: z.string(),
    name: z.string(),
    structure: z.enum(["flat", "tree"]),
    versionNo: z.int().min(1),
    items: z.array(MerchantDictItemViewSchema),
  })
  .openapi("DictTypeItems");
export type DictTypeItems = z.infer<typeof DictTypeItemsSchema>;
export const DictItemListResultSchema = z.object({ items: z.array(DictTypeItemsSchema).max(10) });
export type DictItemListResult = z.infer<typeof DictItemListResultSchema>;
