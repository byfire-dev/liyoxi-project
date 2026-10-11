import { IdSchema, MessageDeepLinkSchema, NOTIFY_SCENES } from "@liyoxi/contract";
import { z } from "zod";
import type { NotificationSpec, NotifyFact } from "./context.js";

/** A narrow safe projection, never a complete domain row or untrusted event payload. */
export const NotifyFactSchema = z.strictObject({
  bizType: z.string().regex(/^[a-z][a-z0-9_]*$/),
  bizId: IdSchema,
  entityId: IdSchema.nullable(),
  storeId: IdSchema.nullable(),
  status: z.string().max(32),
  version: z.int().nonnegative(),
  name: z.string().max(100),
  orderId: IdSchema.optional(),
  orderItemId: IdSchema.optional(),
  deliveryTicketId: IdSchema.optional(),
  excludeWechatIdentityId: IdSchema.optional(),
  targetDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  amountFen: z.int().nonnegative().max(2_147_483_647).optional(),
  quantity: z.int().min(-2_147_483_647).max(2_147_483_647).optional(),
  balance: z.int().nonnegative().max(4_294_967_294).optional(),
  occurredAt: z.iso.datetime().optional(),
  detail: z.string().max(100).optional(),
  guardBizType: z
    .enum([
      "drama_order",
      "delivery_plan",
      "delivery_release",
      "channel_account",
      "launch_task",
      "sample",
      "billing_order",
      "store_asset",
      "billing_account",
      "invitation",
    ])
    .optional(),
  guardBizId: IdSchema.optional(),
  merchantUserIds: z.array(IdSchema).optional(),
  staffIds: z.array(IdSchema).optional(),
  summary: z.string().max(200).optional(),
  summaryNoPrice: z.string().max(200).nullable().optional(),
  link: MessageDeepLinkSchema.optional(),
});

const wallet = () => ({ route: "wallet.home" as const, params: {} });
const points = () => ({ route: "points.ledger" as const, params: {} });
const order = (v: NotifyFact) => ({
  route: "order.detail" as const,
  params: { orderId: v.orderId ?? v.bizId, storeId: v.storeId! },
});
const payment = (v: NotifyFact) => ({
  route: "payment.result" as const,
  params: { paymentOrderId: v.bizId },
});
const spec = (
  sceneKey: string,
  reader: string,
  refField: string,
  category: NotificationSpec["category"],
  link: NotificationSpec["link"],
  pendingStatus?: readonly string[],
  ownerOnly = true,
): NotificationSpec => ({
  sceneKey,
  reader,
  refField,
  category,
  ownerOnly,
  link,
  ...(pendingStatus === undefined ? {} : { pendingStatus }),
});

/** Actual M2 producers only. The remaining catalog keys stay future coverage, not fake handlers. */
const staffSpec = (
  sceneKey: string,
  reader: string,
  refField: string,
  route: string,
  pendingStatus?: readonly string[],
): NotificationSpec => ({
  ...spec(
    sceneKey,
    reader,
    refField,
    "delivery",
    () => ({ route: "messages.list", params: {} }),
    pendingStatus,
  ),
  staffLink: (fact): { route: string; params: Record<string, string> } => ({
    route,
    params:
      route === "approval.mine"
        ? { approvalRequestId: fact.bizId }
        : route === "merchant.detail"
          ? { entityId: fact.entityId! }
          : route === "order.receipts" || route === "finance.reconcile"
            ? {}
            : { deliveryTicketId: fact.deliveryTicketId ?? fact.bizId },
  }),
});

export const INVITATION_JOIN_SPEC = spec(
  "m.member_changed",
  "acceptedInvitationForNotify",
  "invitationId",
  "store",
  (v) => ({ route: "store.members", params: { storeId: v.storeId! } }),
  ["accepted"],
);
export const EVENT_SCENES: Readonly<Record<string, readonly NotificationSpec[]>> = {
  "entity_member.joined": [INVITATION_JOIN_SPEC],
  "entity_member.stores_changed": [
    spec(
      "m.member_changed",
      "memberStoresForNotify",
      "entityMemberId",
      "store",
      (v) => ({
        route: "store.members",
        params: { storeId: v.storeId! },
      }),
      undefined,
      false,
    ),
  ],
  "entity_member.removed": [
    spec(
      "m.member_changed",
      "storeArchiveForNotify",
      "entityMemberId",
      "store",
      () => ({ route: "messages.list", params: {} }),
      undefined,
      false,
    ),
  ],
  "store.archived": [
    staffSpec("s.merchant_changed", "storeArchiveForNotify", "storeId", "merchant.detail"),
  ],
  "ticket.created": [
    staffSpec(
      "s.work_ticket_assigned",
      "ticketManagerForNotify",
      "deliveryTicketId",
      "delivery.ticket_detail",
    ),
  ],
  "ticket.assigned": [
    staffSpec(
      "s.work_ticket_assigned",
      "ticketManagerForNotify",
      "deliveryTicketId",
      "delivery.ticket_detail",
    ),
  ],
  "ticket.step_changed": [
    staffSpec(
      "s.delivery_progress",
      "ticketForNotify",
      "deliveryTicketId",
      "delivery.ticket_detail",
    ),
  ],
  "plan.confirmed": [
    staffSpec(
      "s.delivery_progress",
      "planManagerForNotify",
      "deliveryPlanId",
      "delivery.ticket_detail",
    ),
  ],
  "plan.change_requested": [
    staffSpec(
      "s.delivery_progress",
      "planManagerForNotify",
      "deliveryPlanId",
      "delivery.ticket_detail",
    ),
  ],
  "sample.qc_failed": [
    staffSpec("s.delivery_progress", "sampleEditorForNotify", "sampleId", "delivery.ticket_detail"),
  ],
  "sample.confirmed": [
    staffSpec(
      "s.delivery_progress",
      "sampleManagerForNotify",
      "sampleId",
      "delivery.ticket_detail",
    ),
  ],
  "ticket.episode_qc_failed": [
    staffSpec(
      "s.delivery_progress",
      "ticketEditorForNotify",
      "deliveryTicketId",
      "delivery.ticket_detail",
    ),
  ],
  "transfer.proof_submitted": [
    staffSpec("s.receipt_pending", "transferForNotify", "transferProofId", "order.receipts", [
      "pending",
    ]),
  ],
  "transfer.rejected": [
    spec("m.transfer_rejected", "billingOrderForNotify", "billingOrderId", "plan_points", (v) => ({
      route: "payment.detail",
      params: { paymentOrderId: v.bizId },
    })),
  ],
  "payment_exception.opened": [
    staffSpec(
      "s.payment_exception",
      "paymentExceptionForNotify",
      "paymentExceptionId",
      "finance.reconcile",
      ["open", "resolving"],
    ),
  ],
  "account.verified": [
    spec("m.channel_account_result", "accountNoticeFact", "channelAccountId", "launch", (v) => ({
      route: "account.detail",
      params: { channelAccountId: v.bizId, storeId: v.storeId! },
    })),
  ],
  "account.abnormal": [
    spec("m.channel_account_result", "accountNoticeFact", "channelAccountId", "launch", (v) => ({
      route: "account.detail",
      params: { channelAccountId: v.bizId, storeId: v.storeId! },
    })),
  ],
  "launch.verified": [
    spec("m.verify_result", "launchNoticeFact", "launchTaskId", "launch", (v) => ({
      route: "publish.task",
      params: { launchTaskId: v.bizId, storeId: v.storeId! },
    })),
  ],
  "launch.returned": [
    spec("m.verify_result", "launchNoticeFact", "launchTaskId", "launch", (v) => ({
      route: "publish.task",
      params: { launchTaskId: v.bizId, storeId: v.storeId! },
    })),
  ],
  "package.delivered": [
    spec("m.delivered", "releaseForNotify", "deliveryReleaseId", "delivery", (v) =>
      MessageDeepLinkSchema.parse(v.link),
    ),
  ],
  "approval.submitted": [
    staffSpec("s.approval_pending", "approvalForNotify", "approvalRequestId", "approval.mine", [
      "pending",
    ]),
  ],
  "approval.approved": [
    staffSpec("s.approval_decided", "approvalForNotify", "approvalRequestId", "approval.mine"),
  ],
  "approval.rejected": [
    staffSpec("s.approval_decided", "approvalForNotify", "approvalRequestId", "approval.mine"),
  ],
  "approval.sla_breached": [
    staffSpec("s.approval_overdue", "approvalForNotify", "approvalRequestId", "approval.mine", [
      "pending",
    ]),
  ],
  "billing_order.paid": [
    spec("m.pay_success", "billingOrderForNotify", "billingOrderId", "plan_points", payment, [
      "paid",
      "refunded",
    ]),
  ],
  "billing.subscription.activated": [
    spec("m.plan_activated", "termForNotify", "termId", "plan_points", wallet),
  ],
  "billing.subscription.renewal_scheduled": [
    spec("m.plan_renewed", "termForNotify", "termId", "plan_points", wallet),
  ],
  "billing.points.granted": [
    spec("m.points_changed", "billingAccountForNotify", "entityId", "plan_points", points),
  ],
  "billing.points.purchased": [
    spec("m.points_changed", "billingAccountForNotify", "entityId", "plan_points", points),
  ],
  "billing.points.returned": [
    spec("m.points_changed", "billingAccountForNotify", "entityId", "plan_points", points),
  ],
  "billing.points.adjusted": [
    spec("m.points_changed", "billingAccountForNotify", "entityId", "plan_points", points),
  ],
  "billing.points.captured": [
    spec("m.points_captured", "billingAccountForNotify", "entityId", "plan_points", points),
  ],
  "billing.points.expired": [
    spec("m.points_expired", "billingAccountForNotify", "entityId", "plan_points", points),
  ],
  "order.submitted": [spec("m.order_submitted", "orderForNotify", "dramaOrderId", "order", order)],
  "order.started": [spec("m.order_progress", "orderForNotify", "dramaOrderId", "order", order)],
  "plan.pushed": [
    spec(
      "m.plan_pending",
      "planForNotify",
      "deliveryPlanId",
      "delivery",
      (v) => ({
        route: "delivery.plan",
        params: { deliveryPlanId: v.bizId, storeId: v.storeId! },
      }),
      ["pending_confirm"],
    ),
  ],
  "sample.pushed": [
    spec(
      "m.sample_pending",
      "sampleForNotify",
      "sampleId",
      "delivery",
      (v) => ({
        route: "delivery.sample",
        params: { orderItemId: v.orderItemId!, storeId: v.storeId! },
      }),
      ["pushed"],
    ),
  ],
  "asset.adopted": [
    spec(
      "m.asset_feedback",
      "assetForNotify",
      "storeAssetId",
      "store",
      (v) => ({
        route: "asset.detail",
        params: { storeAssetId: v.bizId, storeId: v.storeId! },
      }),
      ["adopted"],
      false,
    ),
  ],
  "site_notice.announced": [
    spec(
      "m.rule_change_notice",
      "siteNoticeForNotify",
      "siteNoticeId",
      "plan_points",
      (v) => MessageDeepLinkSchema.parse(v.link),
      ["announced"],
    ),
  ],
  "site_notice.withdrawn": [
    spec(
      "m.rule_change_withdrawn",
      "siteNoticeForNotify",
      "siteNoticeId",
      "plan_points",
      (v) => MessageDeepLinkSchema.parse(v.link),
      ["withdrawn"],
    ),
  ],
  "store.qualification.submitted": [
    spec("m.store_review_submitted", "storeForNotify", "storeId", "review", (v) => ({
      route: "profile.review",
      params: { storeId: v.storeId! },
    })),
  ],
  "store.qualification.approved": [
    spec("m.review_result", "storeForNotify", "storeId", "review", (v) => ({
      route: "profile.review",
      params: { storeId: v.storeId! },
    })),
  ],
  "store.qualification.rejected": [
    spec("m.review_result", "storeForNotify", "storeId", "review", (v) => ({
      route: "profile.review",
      params: { storeId: v.storeId! },
    })),
  ],
  "merchant_user.wechat_bound": [
    spec(
      "m.account_security",
      "merchantAccountForNotify",
      "merchantUserId",
      "store",
      () => ({ route: "messages.list", params: {} }),
      undefined,
      false,
    ),
  ],
};

export const SCENE_COVERAGE = NOTIFY_SCENES.map((scene) => ({
  ...scene,
  events: Object.entries(EVENT_SCENES)
    .filter(([, list]) => list.some((s) => s.sceneKey === scene.key))
    .map(([event]) => event),
}));
export const specFor = (key: string, bizType?: string | null): NotificationSpec | undefined =>
  key === "m.member_changed" && bizType === "invitation"
    ? INVITATION_JOIN_SPEC
    : [
        ...Object.values(EVENT_SCENES)
          .flat()
          .filter((s) => s !== INVITATION_JOIN_SPEC),
        FOLLOWUP_SPEC,
        UNREACHED_SPEC,
        COPYRIGHT_SPEC,
      ].find((s) => s.sceneKey === key);

export const FOLLOWUP_SPEC = staffSpec(
  "s.followup_due",
  "followUpForNotify",
  "followUpId",
  "merchant.detail",
  ["pending"],
);
export const UNREACHED_SPEC = staffSpec(
  "s.merchant_unreached",
  "unreachedForNotify",
  "notificationId",
  "merchant.detail",
  ["unreached"],
);

export const COPYRIGHT_SPEC: NotificationSpec = {
  sceneKey: "s.copyright_expiring",
  reader: "copyrightExpiringForNotify",
  refField: "staffId",
  category: "review",
  ownerOnly: false,
  staffLink: () => ({ route: "drama.list", params: {} }),
  link: () => ({ route: "messages.list", params: {} }),
};
