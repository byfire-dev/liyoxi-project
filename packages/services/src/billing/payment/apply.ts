import { wechatReceiptMatches } from "./channel-success.js";
// 唯一入账入口（03 1.3、08 2.1、D2 4.5）；钱先成为已支付事实，再在保存点内履约。
import { fulfillResultSchema } from "@liyoxi/contract";
import type { BillingOrder, Prisma } from "@liyoxi/db";
import { record } from "../../audit/index.js";
import { AppError, createIdentityContext, lockRows } from "../../kernel/index.js";
import { fulfillOpKey } from "../subscription/index.js";
import { openPaymentException } from "./exception.js";
import type { Payment, PaymentDeps, PaymentExceptionKind } from "./types.js";

export function createPayment(deps: PaymentDeps): Payment {
  return {
    async applyPayment(tx, input) {
      const first = await tx.paymentTxn.findUnique({ where: { id: input.paymentTxnId } });
      if (first === null) throw new AppError("NOT_FOUND");
      // 无关联仅保存差异；重建/人工关联须走W4-11显式入口，不能从普通重放虚构业务单。
      if (first.billingOrderId === null) {
        await lockRows(tx, "payment_txn", [first.id]);
        const receipt = await tx.paymentTxn.findUniqueOrThrow({ where: { id: first.id } });
        if (receipt.billingOrderId !== null) throw new AppError("ACCOUNT_BUSY");
        if (
          receipt.status === "succeeded" &&
          receipt.refundedFen >= (receipt.channelAmountFen ?? 0)
        )
          return { result: { status: "orphan", paymentExceptionId: null }, replayed: false };
        if (receipt.status !== "succeeded" || !receipt.channelAmountFen)
          throw new AppError("STATE_NOT_ALLOWED");
        const ctx =
          input.ctx ??
          createIdentityContext({ actor: { type: "system", job: "billing.apply_payment" } });
        const paymentExceptionId = await openPaymentException(tx, deps, ctx, {
          kind: receipt.channel === "wechat_jsapi" ? "bill_only" : "bank_unmatched",
          order: null,
          receipt,
        });
        return { result: { status: "orphan", paymentExceptionId }, replayed: false };
      }
      await lockRows(tx, "billing_order", [first.billingOrderId]);
      await lockRows(tx, "payment_txn", [first.id]);
      const order = await tx.billingOrder.findUniqueOrThrow({
        where: { id: first.billingOrderId },
      });
      const receipt = await tx.paymentTxn.findUniqueOrThrow({ where: { id: first.id } });
      if (
        receipt.billingOrderId !== order.id ||
        receipt.entityId !== order.entityId ||
        receipt.channel !== order.channel
      )
        throw new AppError("INTERNAL");
      if (!["bank_transfer", "wechat_jsapi"].includes(receipt.channel))
        throw new AppError("INTERNAL");
      if (receipt.appliedAt !== null)
        return {
          result: {
            status: "applied",
            billingOrderId: order.id,
            fulfillment: fulfillResultSchema.parse(order.fulfillmentResult),
          },
          replayed: true,
        };
      if (receipt.status !== "succeeded" || receipt.refundedFen >= (receipt.channelAmountFen ?? 0))
        return { result: { status: "skipped", billingOrderId: order.id }, replayed: false };
      if (receipt.channelAmountFen === null || receipt.channelSuccessAt === null)
        throw new AppError("INTERNAL");
      const now = deps.clock.now();
      const ctx =
        input.ctx ??
        createIdentityContext({
          actor: { type: "system", job: "billing.apply_payment" },
          entityId: order.entityId,
          storeId: order.storeId,
        });
      const reclassify = async () => {
        const prior = await tx.paymentException.findMany({
          where: { paymentTxnId: receipt.id, kind: "bill_only", status: "open" },
          orderBy: { id: "asc" },
          select: { id: true },
        });
        for (const row of prior)
          await deps.flow.transition(tx, ctx, {
            machine: "payment_exception",
            stateField: "status",
            id: row.id,
            event: "payment_exception.reclassify",
            set: { resolved_at: now },
            args: { paymentTxnId: receipt.id },
            entityId: order.entityId,
            storeId: order.storeId,
            emit: {
              type: "payment_exception.auto_healed",
              payload: { v: 1, paymentExceptionId: row.id },
              dedupeKey: `payment_exception.auto_healed:${row.id}`,
            },
          });
        if (prior.length)
          await tx.billingOrder.update({
            where: { id: order.id },
            data: {
              hasOpenException:
                (await tx.paymentException.count({
                  where: { billingOrderId: order.id, status: { in: ["open", "resolving"] } },
                })) > 0,
              updatedAt: now,
            },
          });
      };
      const exception = async (kind: PaymentExceptionKind, current: BillingOrder = order) => {
        const paymentExceptionId = await openPaymentException(tx, deps, ctx, {
          kind,
          order: current,
          receipt,
        });
        await reclassify();
        await deps.onStep?.("exception.open");
        return {
          result: {
            status: "exception" as const,
            billingOrderId: order.id,
            kind,
            paymentExceptionId,
          },
          replayed: false,
        };
      };
      const mismatch =
        receipt.channelAmountFen !== order.amountFen
          ? "amount_mismatch"
          : !wechatReceiptMatches(order, receipt)
            ? "payer_mismatch"
            : null;
      if (mismatch) {
        if (["pending_payment", "pending_confirmation"].includes(order.status))
          await deps.flow.transition(tx, ctx, {
            machine: "billing_order",
            stateField: "status",
            id: order.id,
            event: "billing_order.cancel_mismatch",
            set: { cancelled_at: now, cancel_reason: mismatch, transfer_state: null },
            reasonCode: mismatch,
            args: { paymentTxnId: receipt.id },
            entityId: order.entityId,
            storeId: order.storeId,
            audit: {
              stream: "ops",
              category: "payment",
              action: "billing.order.cancel",
              summary: mismatch === "amount_mismatch" ? "实收与应付不符" : "付款人与下单记录不符",
              target: { type: "billing_order", id: order.id },
            },
            emit: {
              type: "billing_order.cancelled",
              payload: {
                v: 1,
                billingOrderId: order.id,
                entityId: order.entityId,
                cancelReason: mismatch,
              },
            },
          });
        await deps.timers.cancel(tx, {
          subject: { type: "billing_order", id: order.id },
          kinds: [receipt.channel === "wechat_jsapi" ? "po.expire" : "po.transfer_ttl"],
        });
        return exception(
          mismatch,
          await tx.billingOrder.findUniqueOrThrow({ where: { id: order.id } }),
        );
      }
      if (order.status === "paid" || order.status === "refunded")
        return exception("duplicate_receipt");
      if (order.status === "cancelled") return exception("paid_after_cancel");
      if (!["pending_payment", "pending_confirmation"].includes(order.status))
        throw new AppError("STATE_NOT_ALLOWED");
      await deps.flow.transition(tx, ctx, {
        machine: "billing_order",
        stateField: "status",
        id: order.id,
        event:
          order.status === "pending_confirmation"
            ? order.transferState === "confirm_review" && receipt.reviewedByStaffId !== null
              ? "billing_order.approve_review"
              : "billing_order.confirm_transfer"
            : "billing_order.apply_payment",
        set: {
          paid_amount_fen: receipt.channelAmountFen,
          paid_at: receipt.channelSuccessAt,
          paid_payment_txn_id: receipt.id,
          applied_at: now,
          transfer_state: null,
        },
        args: { paymentTxnId: receipt.id },
        entityId: order.entityId,
        storeId: order.storeId,
        audit: {
          stream: "ops",
          category: "payment",
          action: "billing.order.pay",
          summary: "付款已入账",
          target: { type: "billing_order", id: order.id },
        },
        emit: {
          type: "billing_order.paid",
          payload: {
            v: 1,
            billingOrderId: order.id,
            entityId: order.entityId,
            storeId: order.storeId,
            orderType: order.type as "plan_new" | "plan_renew" | "plan_upgrade" | "topup",
            channel: receipt.channel === "wechat_jsapi" ? "wechat_jsapi" : "bank_transfer",
            amountFen: receipt.channelAmountFen,
            paidPaymentTxnId: receipt.id,
            placedByUserId: order.placedByUserId,
          },
          dedupeKey: `billing_order.paid:${order.id}`,
        },
      });
      await deps.onStep?.("order.pay");
      await reclassify();
      await tx.paymentTxn.update({
        where: { id: receipt.id },
        data: { appliedAt: now, updatedAt: now },
      });
      await deps.onStep?.("txn.apply");
      // ACCOUNT_BUSY 与可重试数据库错误原样外抛；不把整个入账失败转成受阻。
      const { result } = await deps.fulfillment.fulfill(tx, { billingOrderId: order.id, ctx });
      const fulfilledAt =
        result.status === "done"
          ? (
              await tx.ledgerOperation.findUniqueOrThrow({
                where: { opKey: fulfillOpKey(order.id) },
              })
            ).occurredAt
          : null;
      await tx.billingOrder.update({
        where: { id: order.id },
        data: {
          fulfillmentStatus: result.status,
          fulfillmentResult: result as Prisma.InputJsonValue,
          fulfilledAt,
          fulfillmentNote:
            result.status === "blocked" ? result.reasonCode : result.notes.join(", ") || null,
          updatedAt: deps.clock.now(),
        },
      });
      await record(
        tx,
        ctx.actor,
        {
          requestId: ctx.requestId,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          authMethod: null,
          sessionId: null,
        },
        {
          stream: "ops",
          category: "payment",
          action: "billing.order.fulfill",
          summary: result.status === "done" ? "付款履约完成" : "付款履约受阻",
          target: { type: "billing_order", id: order.id },
          entityId: order.entityId,
          storeId: order.storeId,
          meta: { status: result.status },
        },
      );
      await deps.onStep?.("order.fulfill");
      if (result.status === "blocked") {
        const blocked = await exception(
          "fulfillment_blocked",
          await tx.billingOrder.findUniqueOrThrow({ where: { id: order.id } }),
        );
        await deps.events.emit(tx, ctx, {
          type: "billing_order.fulfillment_blocked",
          aggregate: { type: "billing_order", id: order.id },
          entityId: order.entityId,
          storeId: order.storeId,
          payload: {
            v: 1,
            billingOrderId: order.id,
            entityId: order.entityId,
            paymentExceptionId: blocked.result.paymentExceptionId,
          },
          dedupeKey: `billing_order.fulfillment_blocked:${order.id}`,
        });
      }
      await deps.timers.cancel(tx, {
        subject: { type: "billing_order", id: order.id },
        kinds: [receipt.channel === "wechat_jsapi" ? "po.expire" : "po.transfer_ttl"],
      });
      await deps.onStep?.("timers.cancel");
      return {
        result: { status: "applied", billingOrderId: order.id, fulfillment: result },
        replayed: false,
      };
    },
  };
}
