import { z } from "../../zod.js";
import { IdSchema, InstantSchema, orNull } from "../../common/index.js";
import { StaffBriefSchema } from "../a01-system/structures.js";

export const AssignmentContactParamsSchema = z.strictObject({ assignmentHistoryId: IdSchema });
export const AssignmentContactBodySchema = z.strictObject({ note: z.string().max(200).optional() });
export const AssignmentContactViewSchema = z
  .strictObject({
    assignmentHistoryId: IdSchema,
    storeId: IdSchema,
    toStaff: StaffBriefSchema,
    contactDueAt: InstantSchema,
    contactedAt: orNull(InstantSchema),
    contactedBy: orNull(StaffBriefSchema),
  })
  .openapi("AssignmentContactView");
export type AssignmentContactBody = z.infer<typeof AssignmentContactBodySchema>;
