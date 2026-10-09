import { z } from "../zod.js";
import { IdSchema } from "../common/index.js";
import { DELIVERY_TICKET_PAUSE_REASON, DELIVERY_TICKET_STEP } from "../enums/index.js";
const transition = {
  fromState: z.union([z.string(), z.null()]),
  toState: z.string(),
  transition: z.string(),
};
const ticket = {
  v: z.literal(1),
  deliveryTicketId: IdSchema,
  dramaOrderId: IdSchema,
  ...transition,
};
const plan = {
  v: z.literal(1),
  deliveryPlanId: IdSchema,
  dramaOrderId: IdSchema,
  versionNo: z.int().positive(),
  ...transition,
};
const sample = {
  v: z.literal(1),
  sampleId: IdSchema,
  deliveryTicketId: IdSchema,
  dramaOrderId: IdSchema,
  versionNo: z.int().positive(),
  ...transition,
};
export const payloads = {
  "sample.uploaded": z.strictObject(sample),
  "sample.check_rejected": z.strictObject(sample),
  "sample.superseded": z.strictObject(sample),
  "sample.qc_passed": z.strictObject(sample),
  "sample.qc_failed": z.strictObject(sample),
  "sample.pushed": z.strictObject(sample),
  "sample.confirmed": z.strictObject({
    ...sample,
    viewedVia: z.enum(["weapp", "album", "portal", "wecom"]),
  }),
  "ticket.episode_qc_failed": z.strictObject({
    v: z.literal(1),
    deliveryTicketId: IdSchema,
    orderItemId: IdSchema,
    episodeNos: z.array(z.int().positive()),
    qcRecordIds: z.array(IdSchema),
  }),
  "package.delivered": z.strictObject({
    v: z.literal(1),
    deliveryReleaseId: IdSchema,
    deliveryTicketId: IdSchema,
    orderItemId: IdSchema,
    episodeCount: z.int().positive(),
    grantExpiresAt: z.string().datetime(),
  }),
  "ticket.created": z.strictObject({
    ...ticket,
    orderItemId: IdSchema,
    deliveryManagerId: z.union([IdSchema, z.null()]),
  }),
  "ticket.assigned": z.strictObject({ ...ticket, deliveryManagerId: IdSchema }),
  "ticket.resumed": z.strictObject({
    v: z.literal(1),
    deliveryTicketId: IdSchema,
    orderItemId: IdSchema,
    reason: z.enum(DELIVERY_TICKET_PAUSE_REASON.values),
    refId: IdSchema,
    ...transition,
  }),
  "ticket.sla_breached": z.strictObject({
    v: z.literal(1),
    deliveryTicketId: IdSchema,
    deliveryTicketStageId: IdSchema,
    step: z.enum(DELIVERY_TICKET_STEP.values),
    dueAt: z.iso.datetime(),
  }),
  "ticket.step_changed": z.strictObject({
    ...ticket,
    orderItemId: IdSchema,
    isForced: z.boolean(),
  }),
  "plan.pushed": z.strictObject(plan),
  "plan.change_requested": z.strictObject(plan),
  "plan.confirmed": z.strictObject(plan),
};
