import { IdSchema, InstantSchema } from "../../common/index.js";
import { z } from "../../zod.js";

export const PortalLookupQuerySchema = z.strictObject({
  code: z
    .string()
    .max(128)
    .refine(
      (code) =>
        /^[A-Za-z0-9_-]{22}$/.test(code) ||
        /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code.replace(/[\s-]/g, "").toUpperCase()),
    ),
});
export const PortalApproveBodySchema = z.strictObject({ pairDigits: z.string().regex(/^\d{2}$/) });
export const PortalSessionParamsSchema = z.strictObject({ portalSessionId: IdSchema });
export const PortalTicketPreviewSchema = z
  .strictObject({
    portalTicketId: IdSchema,
    browser: z.string(),
    regionHint: z.string().nullable(),
    createdAt: InstantSchema,
    expiresAt: InstantSchema,
    pairChoices: z.array(z.string().regex(/^\d{2}$/)).length(3),
    storeId: IdSchema,
    storeName: z.string().nullable(),
  })
  .openapi("PortalTicketPreview");
export const PortalTicketDecisionSchema = z
  .strictObject({
    portalTicketId: IdSchema,
    status: z.enum(["approved", "rejected"]),
    rejectReason: z.enum(["pair_mismatch", "by_owner"]).nullable(),
    approvedAt: InstantSchema.nullable(),
    storeId: IdSchema.nullable(),
  })
  .openapi("PortalTicketDecision");
export const PortalSessionItemSchema = z
  .strictObject({
    portalSessionId: IdSchema,
    storeId: IdSchema,
    storeName: z.string().nullable(),
    grantScope: z.literal("store"),
    browser: z.string(),
    regionHint: z.string().nullable(),
    authorizedAt: InstantSchema,
    expiresAt: InstantSchema,
    revokedAt: InstantSchema.nullable(),
  })
  .openapi("PortalSessionItem");
export const PortalSessionListSchema = z
  .strictObject({ items: z.array(PortalSessionItemSchema) })
  .openapi("PortalSessionList");
export type PortalTicketPreview = z.infer<typeof PortalTicketPreviewSchema>;
export type PortalTicketDecision = z.infer<typeof PortalTicketDecisionSchema>;
export type PortalSessionItem = z.infer<typeof PortalSessionItemSchema>;
