import { IdSchema, InstantSchema } from "../../common/index.js";
import { z } from "../../zod.js";

export const PortalSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const PortalTicketParamsSchema = z.strictObject({ portalTicketId: IdSchema });
export const PortalTicketCreatedSchema = z
  .strictObject({
    portalTicketId: IdSchema,
    qrUrl: z.url(),
    shortCode: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/),
    pairDigits: z.string().regex(/^\d{2}$/),
    pollSecret: PortalSecretSchema,
    expiresAt: InstantSchema,
    pollIntervalMs: z.literal(2000),
  })
  .openapi("PortalTicketCreated");
export const PortalTicketStatusViewSchema = z
  .strictObject({
    portalTicketId: IdSchema,
    status: z.enum(["pending", "approved", "rejected", "expired", "consumed"]),
    expiresAt: InstantSchema,
  })
  .openapi("PortalTicketStatusView");
export const PortalSessionViewSchema = z
  .strictObject({
    portalSessionId: IdSchema,
    storeId: IdSchema,
    storeName: z.string().nullable(),
    isStoreArchived: z.boolean(),
    entityId: IdSchema,
    entityName: z.string().nullable(),
    authorizerPhoneMask: z.string().nullable(),
    grantScope: z.literal("store"),
    capabilities: z.array(z.string()),
    authorizedAt: InstantSchema,
    expiresAt: InstantSchema,
    serverTime: InstantSchema,
  })
  .openapi("PortalSessionView");
export const PortalTicketExchangeResultSchema = z
  .strictObject({
    status: z.enum(["consumed", "rejected"]),
    session: PortalSessionViewSchema.nullable(),
    rejectReason: z.enum(["secret_mismatch", "attempts_exceeded", "window_passed"]).nullable(),
  })
  .openapi("PortalTicketExchangeResult");
export type PortalTicketCreated = z.infer<typeof PortalTicketCreatedSchema>;
export type PortalTicketStatusView = z.infer<typeof PortalTicketStatusViewSchema>;
export type PortalSessionView = z.infer<typeof PortalSessionViewSchema>;
export type PortalTicketExchangeResult = z.infer<typeof PortalTicketExchangeResultSchema>;
