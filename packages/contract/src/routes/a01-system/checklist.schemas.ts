import { z } from "../../zod.js";
import { IdSchema, InstantSchema, orNull } from "../../common/index.js";
import { CHECKLIST_TEMPLATE_CODE, CHECKLIST_TEMPLATE_STATUS } from "../../enums/index.js";
import { zodEnum } from "../../enums/zod.js";
import { ChecklistItemsSchema } from "../../config/schemas.js";
import { StaffBriefSchema } from "./structures.js";
const csv = (values: readonly string[]) =>
  z
    .string()
    .refine((v) => v.split(",").every((s) => values.includes(s)))
    .transform((v) => [...new Set(v.split(","))]);
export const ChecklistTemplateListQuerySchema = z.object({
  code: csv(CHECKLIST_TEMPLATE_CODE.values).optional(),
  status: csv(CHECKLIST_TEMPLATE_STATUS.values).optional(),
  allVersions: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});
export const ChecklistTemplateViewSchema = z
  .strictObject({
    checklistTemplateId: IdSchema,
    code: zodEnum(CHECKLIST_TEMPLATE_CODE),
    versionNo: z.int().min(1),
    status: zodEnum(CHECKLIST_TEMPLATE_STATUS),
    items: ChecklistItemsSchema,
    activatedAt: orNull(InstantSchema),
    retiredAt: orNull(InstantSchema),
    createdBy: orNull(StaffBriefSchema),
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    lockVersion: z.int().min(0),
    actions: z.array(z.enum(["activate", "discard"])),
  })
  .openapi("ChecklistTemplateView");
export const ChecklistTemplateListSchema = z.strictObject({
  items: z.array(ChecklistTemplateViewSchema),
});
