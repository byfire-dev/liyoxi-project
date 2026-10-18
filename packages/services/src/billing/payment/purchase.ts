import { createWechatChannel } from "./wechat-channel.js";
import { createBillingChannelRead } from "./channel-read.js";
import { createPointPacks } from "../catalog/point-packs.js";
import { createWechatPrepay } from "./wechat-prepay.js";
import { BillingWalletSchema } from "@liyoxi/contract";
import type {
  AdminPaymentOrderCreateBody,
  AdminTransferProofCreateBody,
  TransferProofApproveReviewBody,
  TransferProofRejectReviewBody,
  PaymentOrderCreateBody,
  PlanQuoteBody,
  TransferProofConfirmBody,
  TransferProofRejectBody,
} from "@liyoxi/contract";
import { quoteAd } from "@liyoxi/shared/pricing";
import { AppError } from "../../kernel/index.js";
import type { IdempotencyContext, IdentityContext } from "../../kernel/index.js";
import type { StaffContext } from "../../authz/index.js";
import { getWalletView } from "../read/index.js";
import { paramsAt } from "../pricing/index.js";
import { quotePlan, listPlans } from "../catalog/index.js";
import { getPurchasePolicy } from "../policy/index.js";
import type { PurchaseClient } from "../policy/index.js";
import {
  createOrder,
  submitProof,
  confirmProof,
  rejectProof,
  isSerialConflict,
  normalizeBankSerial,
} from "./purchase-write.js";
import {
  merchantOrderView,
  adminOrderView,
  proofDetailView,
  proofInScope,
  orderInScope,
  proofQueueView,
  queueWhere,
  assertProofView,
  dictRef,
} from "./purchase-read.js";
import { byEntity } from "../../authz/index.js";
import {
  createAdminOrder,
  createAdminTransferProof,
  assertTransferStaff,
} from "./transfer-admin.js";
import { decideTransferReview } from "./transfer-review.js";
import type { BillingPurchaseDeps, PurchaseActor } from "./purchase-context.js";
export function createBillingPurchase(deps: BillingPurchaseDeps) {
  const policy = (
    tx: Parameters<typeof getPurchasePolicy>[0],
    actor: PurchaseActor,
    client: PurchaseClient,
    type?: string,
    amount?: number,
  ) =>
    getPurchasePolicy(
      tx,
      deps.config,
      actor.membership.entityId,
      deps.clock.now(),
      client,
      type,
      amount,
      deps.wechatPay?.provider.configured ?? false,
    );
  const wechatChannel = createWechatChannel(deps);
  return {
    pointPacks: createPointPacks(deps),
    ...createBillingChannelRead(deps),
    wechatChannel,
    syncOrder: wechatChannel.sync,
    cancelOrder: wechatChannel.cancel,
    wechatPrepay: createWechatPrepay(deps),
    getPurchasePolicy: (actor: PurchaseActor, client: PurchaseClient) =>
      deps.tx.run((tx) => policy(tx, actor, client)),
    listPlans: (actor: PurchaseActor, client: PurchaseClient) =>
      deps.tx.run(async (tx) =>
        listPlans(tx, actor.membership.entityId, deps.clock.now(), await policy(tx, actor, client)),
      ),
    quotePlanPurchase: (actor: PurchaseActor, client: PurchaseClient, input: PlanQuoteBody) =>
      deps.tx.run(
        async (tx) =>
          (
            await quotePlan(
              tx,
              actor.membership.entityId,
              deps.clock.now(),
              input,
              (type, amount) => policy(tx, actor, client, type, amount),
            )
          ).quote,
      ),
    wallet: (actor: PurchaseActor, client: PurchaseClient) =>
      deps.tx.run(async (tx) => {
        const view = await getWalletView(tx, actor.membership.entityId, deps.clock.now()),
          params = await paramsAt(tx, deps.clock.now());
        const purchasePolicy = await policy(tx, actor, client, "topup");
        const blockReason =
          view.subscription.status !== "active"
            ? "no_active_plan"
            : view.subscription.isRefundPending
              ? "refund_in_progress"
              : purchasePolicy.mode !== "in_app"
                ? "not_offered"
                : null;
        return BillingWalletSchema.parse({
          ...view,
          subscription: {
            ...view.subscription,
            endsAt: view.subscription.endsAt?.toISOString() ?? null,
          },
          points: {
            ...view.points,
            planPointsExpireAt: view.points.planPointsExpireAt?.toISOString() ?? null,
            lastExpired: view.points.lastExpired
              ? {
                  ...view.points.lastExpired,
                  expiredAt: view.points.lastExpired.expiredAt.toISOString(),
                }
              : null,
          },
          usage: await deps.tenant.getQuotaUsage(tx, actor.membership.entityId),
          topUp: { canTopUp: blockReason === null, blockReason },
          rules: {
            adUnitPoints: params.adUnitPoints,
            discountedAdUnitPoints:
              view.subscription.status === "active" && view.subscription.benefits
                ? quoteAd(params.adUnitPoints, view.subscription.benefits.discountBp)
                : null,
            adFreeRevisions: params.adFreeRevisions,
            topModelSurchargeBp: params.topModelSurchargeBp,
          },
        });
      }),
    createOrder: (
      actor: PurchaseActor,
      client: PurchaseClient,
      input: PaymentOrderCreateBody,
      options: { idem?: IdempotencyContext } = {},
    ) => deps.tx.run((tx) => createOrder(tx, deps, actor, client, input), options),
    getOrder: (actor: PurchaseActor, client: PurchaseClient, id: string) =>
      deps.tx.run(async (tx) => {
        const o = await tx.billingOrder.findFirst({
          where: { id, entityId: actor.membership.entityId },
        });
        if (!o) throw new AppError("NOT_FOUND");
        return merchantOrderView(tx, deps, o, client);
      }),
    submitProof: (
      actor: PurchaseActor,
      client: PurchaseClient,
      id: string,
      fileId: string,
      options: { idem?: IdempotencyContext } = {},
    ) => deps.tx.run((tx) => submitProof(tx, deps, actor, client, id, fileId), options),
    createAdminOrder: async (
      ctx: IdentityContext,
      staff: StaffContext,
      input: AdminPaymentOrderCreateBody,
      options: { idem?: IdempotencyContext } = {},
    ) => {
      await deps.tx.run(async (tx) => {
        await assertTransferStaff(tx, deps, ctx, staff, "order.payment.create_offline");
        if (
          !(await tx.entity.findFirst({
            where: { id: input.entityId, ...byEntity(staff.scope).entity },
          }))
        )
          throw new AppError("NOT_FOUND");
      });
      return deps.tx.run((tx) => createAdminOrder(tx, deps, ctx, staff, input), options);
    },
    createAdminTransferProof: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: AdminTransferProofCreateBody,
      options: { idem?: IdempotencyContext } = {},
    ) => {
      await deps.tx.run(async (tx) => {
        await assertTransferStaff(tx, deps, ctx, staff, "finance.receipt.confirm");
        await orderInScope(tx, staff.scope, id);
      });
      return deps.tx.run(
        (tx) => createAdminTransferProof(tx, deps, ctx, staff, id, input),
        options,
      );
    },
    approveTransferReview: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: TransferProofApproveReviewBody,
      options: { idem?: IdempotencyContext } = {},
    ) => {
      if (!deps.approval) throw new AppError("INTERNAL");
      await deps.tx.run(async (tx) => {
        await assertTransferStaff(tx, deps, ctx, staff, "finance.receipt.confirm");
        await proofInScope(tx, staff.scope, id);
      });
      return deps.tx.run(async (tx) => {
        await assertTransferStaff(tx, deps, ctx, staff, "finance.receipt.confirm");
        const result = await decideTransferReview(
          tx,
          deps,
          deps.approval!,
          ctx,
          staff,
          id,
          input,
          true,
        );
        return { ...result, outcome: "paid" as const };
      }, options);
    },
    rejectTransferReview: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: TransferProofRejectReviewBody,
      options: { idem?: IdempotencyContext } = {},
    ) => {
      if (!deps.approval) throw new AppError("INTERNAL");
      // 驳回仍查权限和scope；只有路由已声明的再验证豁免。
      await deps.tx.run(async (tx) => {
        await assertTransferStaff(tx, deps, ctx, staff, "finance.receipt.confirm", true);
        await proofInScope(tx, staff.scope, id);
      });
      return deps.tx.run(async (tx) => {
        await assertTransferStaff(tx, deps, ctx, staff, "finance.receipt.confirm", true);
        return decideTransferReview(tx, deps, deps.approval!, ctx, staff, id, input, false);
      }, options);
    },
    getAdminOrder: (staff: StaffContext, id: string) =>
      deps.tx.run(async (tx) =>
        adminOrderView(tx, deps, await orderInScope(tx, staff.scope, id), staff),
      ),
    listProofs: (input: {
      tab: "pending" | "processed_today";
      q?: string;
      page: number;
      pageSize: number;
    }) =>
      deps.tx.run(async (tx) => {
        const where = queueWhere(deps.clock.now(), input.tab, input.q);
        // 升级凭证优先；不能用类型字母序，也不能在分页后才重排。
        const pattern = input.q ? `%${input.q.replace(/[\\%_]/g, "\\$&")}%` : null;
        const ids =
          input.tab === "pending"
            ? await tx.$queryRaw<{ id: string }[]>`
          SELECT p.id::text FROM transfer_proof p
          JOIN billing_order o ON o.id=p.billing_order_id JOIN entity e ON e.id=p.entity_id
          WHERE p.review_status='pending' AND (${pattern}::text IS NULL OR o.order_no ILIKE ${pattern} OR e.name ILIKE ${pattern})
          ORDER BY CASE WHEN o.type='plan_upgrade' THEN 0 ELSE 1 END, p.uploaded_at, p.id
          LIMIT ${input.pageSize} OFFSET ${(input.page - 1) * input.pageSize}`
            : null;
        const found = ids
          ? await tx.transferProof.findMany({
              where: { ...where, id: { in: ids.map((r) => r.id) } },
            })
          : await tx.transferProof.findMany({
              where,
              orderBy: [{ reviewedAt: "desc" }, { id: "asc" }],
              skip: (input.page - 1) * input.pageSize,
              take: input.pageSize,
            });
        const rows = ids ? ids.flatMap((r) => found.filter((p) => p.id === r.id)) : found;
        return {
          items: await Promise.all(rows.map((p) => proofQueueView(tx, deps, p))),
          page: input.page,
          pageSize: input.pageSize,
          total: await tx.transferProof.count({ where }),
        };
      }),
    proofSummary: (q?: string) =>
      deps.tx.run(async (tx) => {
        const pending = queueWhere(deps.clock.now(), "pending", q),
          processed = queueWhere(deps.clock.now(), "processed_today", q),
          rows = await tx.transferProof.findMany({
            where: pending,
            select: { billingOrder: { select: { amountFen: true } } },
          });
        return {
          pending: rows.length,
          processed_today: await tx.transferProof.count({ where: processed }),
          pendingAmountFen: rows
            .reduce((sum, r) => sum + BigInt(r.billingOrder.amountFen), 0n)
            .toString(),
        };
      }),
    getProof: (staff: StaffContext, id: string) =>
      deps.tx.run(async (tx) => {
        assertProofView(staff);
        return proofDetailView(tx, deps, await proofInScope(tx, staff.scope, id), staff);
      }),
    async confirmProof(
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: TransferProofConfirmBody,
      options: { idem?: IdempotencyContext } = {},
    ) {
      try {
        return await deps.tx.run((tx) => confirmProof(tx, deps, ctx, staff, id, input), options);
      } catch (error) {
        if (!isSerialConflict(error)) throw error;
        const conflicts = await deps.tx.run(async (tx) => {
          const rows = await tx.paymentTxn.findMany({
            where: {
              channel: "bank_transfer",
              channelTxnNo: normalizeBankSerial(input.bankSerialNo),
            },
            include: { billingOrder: { select: { orderNo: true } } },
          });
          return Promise.all(
            rows.map(async (r) => ({
              ref: r.billingOrder?.orderNo ?? r.outTradeNo,
              payerBank: await dictRef(tx, "bank", r.payerBank),
            })),
          );
        });
        throw new AppError("BANK_SERIAL_DUPLICATE", { details: { conflicts }, cause: error });
      }
    },
    rejectProof: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: TransferProofRejectBody,
      options: { idem?: IdempotencyContext } = {},
    ) => deps.tx.run((tx) => rejectProof(tx, deps, ctx, staff, id, input), options),
  };
}
export type BillingPurchase = ReturnType<typeof createBillingPurchase>;
export type { BillingPurchaseDeps, PurchaseActor } from "./purchase-context.js";
