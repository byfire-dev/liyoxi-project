import { z } from "../../zod.js";
import { AuditLogItemSchema } from "../a01-system/audit-logs.js";
import { AdminCursorQuerySchema, adminCursorPage } from "../a01-system/structures.js";

export const StoreActivityQuerySchema = AdminCursorQuerySchema.extend({
  actorType: z
    .string()
    .max(100)
    .regex(/^(merchant|staff|system)(,(merchant|staff|system))*$/)
    .optional(),
})
  .strict()
  .openapi("StoreActivityQuery");
export type StoreActivityQuery = z.infer<typeof StoreActivityQuerySchema>;
export const StoreActivityItemSchema = AuditLogItemSchema.extend({
  stream: z.enum(["ops", "activity"]),
  reason: z.object({ code: z.string().nullable(), text: z.string().nullable() }).nullable(),
  changedKeys: z.array(z.string()),
  isEntityLevel: z.boolean(),
}).openapi("StoreActivityItem");
export const StoreActivityPageSchema =
  adminCursorPage(StoreActivityItemSchema).openapi("StoreActivityPage");
