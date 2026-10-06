// a05 §2.1 公共片段；W1-14 首次使用，未挂载交付接口。
import { z } from "../../zod.js";
import { IdSchema, DictRefSchema, orNull } from "../../common/index.js";
import { QUALIFICATION_STATUS } from "../../enums/index.js";
import { zodEnum } from "../../enums/zod.js";
export const AdminStoreBriefSchema = z
  .strictObject({
    storeId: IdSchema,
    storeName: orNull(z.string()),
    entityId: IdSchema,
    entityName: orNull(z.string()),
    city: orNull(DictRefSchema),
    district: orNull(DictRefSchema),
    qualificationStatus: zodEnum(QUALIFICATION_STATUS),
  })
  .openapi("AdminStoreBrief");
export const AdminChecklistItemViewSchema = z
  .strictObject({
    key: z.string(),
    label: z.string(),
    result: z.enum(["pass", "fail", "na"]),
    note: orNull(z.string()),
    merchantVisible: z.boolean(),
  })
  .openapi("AdminChecklistItemView");
export const ChecklistResultInputSchema = z
  .strictObject({
    checklistVersionNo: z.int().min(1),
    results: z
      .array(
        z.strictObject({
          key: z.string(),
          result: z.enum(["pass", "fail", "na"]),
          note: z.string().max(200).optional(),
        }),
      )
      .max(100),
  })
  .openapi("ChecklistResultInput");
