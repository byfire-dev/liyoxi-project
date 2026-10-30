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
  "order.item.launch_rescheduled": z.strictObject({
    v: z.literal(1),
    orderItemId: IdSchema,
    dramaOrderId: IdSchema,
    prevDate: z.iso.date().nullable(),
    newDate: z.iso.date(),
  }),
  "package.reissue_opened": z.strictObject({
    v: z.literal(1),
    deliveryReissueId: IdSchema,
    deliveryTicketId: IdSchema,
    orderItemId: IdSchema,
    episodeNos: z.array(z.int().positive()).min(1),
    reasonCode: z.string().min(1),
  }),
  "package.reissued": z.strictObject({
    v: z.literal(1),
    deliveryReissueId: IdSchema,
    deliveryReleaseId: IdSchema,
    deliveryTicketId: IdSchema,
    orderItemId: IdSchema,
    episodeNos: z.array(z.int().positive()).min(1),
    grantExpiresAt: z.iso.datetime(),
  }),
  "sample.uploaded": z.strictObject(sample),
  "sample.check_rejected": z.strictObject(sample),
  "sample.superseded": z.strictObject(sample),
  "sample.qc_passed": z.strictObject(sample),
  "sample.qc_failed": z.strictObject(sample),
  "sample.pushed": z.strictObject(sample),
  "sample.change_requested": z.strictObject({
    ...sample,
    feedbackKind: z.enum(["compose", "ad_content"]),
  }),
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
  "ticket.terminated": z
    .strictObject({
      v: z.literal(1),
      deliveryTicketId: IdSchema,
      orderItemId: IdSchema,
      cancelRequestId: IdSchema,
      fromState: z.enum(DELIVERY_TICKET_STEP.values).exclude(["archived", "terminated"]),
      toState: z.enum(["terminated", "takedown"]),
      transition: z.literal("ticket.terminate"),
    })
    .refine((p) =>
      ["in_service", "takedown"].includes(p.fromState)
        ? p.toState === "takedown"
        : p.toState === "terminated",
    ),
  "ticket.held": z.strictObject({
    v: z.literal(1),
    deliveryTicketId: IdSchema,
    orderItemId: IdSchema,
    reason: z.enum(DELIVERY_TICKET_PAUSE_REASON.values),
    refId: IdSchema,
    ...transition,
  }),
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
