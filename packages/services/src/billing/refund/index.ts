import type {
  RefundApproveBody,
  RefundCreateBody,
  RefundExecuteBody,
  RefundFilter,
  RefundListQuery,
  RefundNotAcceptedBody,
  RefundOfflineBody,
  RefundRejectBody,
  RefundRetryBody,
  RefundVoidBody,
  RefundWithdrawBody,
} from "@liyoxi/contract";
import { AppError, isAppError } from "../../kernel/index.js";
import type { IdempotencyContext, IdentityContext } from "../../kernel/index.js";
import { satisfiesLevel } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { orderInScope } from "../payment/purchase-read.js";
import { approvalOf, assertStaff, confirmMoney, lockRefund, OPEN, visible } from "./context.js";
import type { RefundDeps } from "./context.js";
import { quote } from "./quote.js";
import { recheck, submitRefund } from "./approval.js";
import { detail, list, summary } from "./read.js";
import { createRefundSaga } from "./saga.js";
import { recordOffline } from "./offline.js";
import { executionTimer, restore, transition } from "./state.js";
import { abandon } from "./abandon.js";
import type { AbandonInput, RefundConfirmers } from "./abandon.js";

type Options = { idem?: IdempotencyContext };
export function createRefunds(deps: RefundDeps) {
  const saga = createRefundSaga(deps);
  const required = (options: Options) => {
    if (options.idem?.mode !== "required") throw new AppError("INTERNAL");
  };
  const read = (staff: StaffContext, id: string) =>
    deps.tx.run((tx) => detail(tx, deps, staff, id));
  return {
    saga,
    quote: (staff: StaffContext, id: string, rule?: string) =>
      deps.tx.run(async (tx) =>
        quote(tx, deps, staff, await orderInScope(tx, staff.scope, id), rule),
      ),
    list: (staff: StaffContext, query: RefundListQuery) =>
      deps.tx.run((tx) => list(tx, deps, staff, query)),
    summary: (staff: StaffContext, query: RefundFilter) =>
      deps.tx.run((tx) => summary(tx, deps, staff, query)),
    get: read,
    async create(
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: RefundCreateBody,
      options: Options,
    ) {
      required(options);
      return deps.tx.run(async (tx) => {
        const created = await submitRefund(tx, deps, ctx, staff, id, input, options.idem!.key);
        return detail(tx, deps, staff, created);
      }, options);
    },
    async approve(
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: RefundApproveBody,
      options: Options,
    ) {
      required(options);
      try {
        return await deps.tx.run(async (tx) => {
          await assertStaff(tx, deps, ctx, staff, "finance.refund.approve");
          const request = await visible(tx, staff, id);
          const approval = await tx.approvalRequest.findUniqueOrThrow({
            where: { id: request.approvalRequestId },
          });
          if (
            input.confirm.requestNo !== approval.requestNo ||
            input.confirm.amountFen !== request.amountFen ||
            !input.confirmChecks.includes("rule_amount_checked")
          )
            throw new AppError("CONFIRM_MISMATCH");
          await approvalOf(deps).approve(tx, ctx, {
            approvalId: approval.id,
            staff,
            lockVersion: input.lockVersion,
            confirmChecks: input.confirmChecks,
            note: input.note,
          });
          return detail(tx, deps, staff, id);
        }, options);
      } catch (error) {
        if (isAppError(error) && error.error === "PRECONDITION_CHANGED")
          await deps.tx.run(async (tx) => {
            await assertStaff(tx, deps, ctx, staff, "finance.refund.approve");
            await visible(tx, staff, id);
            const state = await lockRefund(tx, id);
            if (state.request.status !== "pending_approval") return;
            const result = await recheck(tx, deps, state);
            const old =
              state.request.recheckLog &&
              typeof state.request.recheckLog === "object" &&
              !Array.isArray(state.request.recheckLog)
                ? state.request.recheckLog
                : {};
            await tx.refundRequest.update({
              where: { id },
              data: { recheckLog: { ...old, approve: result }, updatedAt: deps.clock.now() },
            });
          });
        throw error;
      }
    },
    async reject(
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: RefundRejectBody,
      options: Options,
    ) {
      required(options);
      return deps.tx.run(async (tx) => {
        await assertStaff(tx, deps, ctx, staff, "finance.refund.approve", true);
        const r = await visible(tx, staff, id);
        await approvalOf(deps).reject(tx, ctx, {
          approvalId: r.approvalRequestId,
          staff,
          note: input.note,
          reasonCodes: input.reasonCodes,
        });
        return detail(tx, deps, staff, id);
      }, options);
    },
    async withdraw(
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: RefundWithdrawBody,
      options: Options,
    ) {
      required(options);
      return deps.tx.run(async (tx) => {
        if (
          !satisfiesLevel(staff.moduleLevels.finance, "view") &&
          !satisfiesLevel(staff.moduleLevels.order, "view")
        )
          throw new AppError("PERMISSION_DENIED");
        const r = await visible(tx, staff, id, true);
        await approvalOf(deps).withdraw(tx, ctx, {
          approvalId: r.approvalRequestId,
          staff,
          note: input.note,
        });
        return detail(tx, deps, staff, id);
      }, options);
    },
    async void(
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: RefundVoidBody,
      options: Options,
    ) {
      required(options);
      return deps.tx.run(async (tx) => {
        await assertStaff(tx, deps, ctx, staff, "finance.refund.approve");
        await visible(tx, staff, id);
        const state = await lockRefund(tx, id);
        confirmMoney(state, input.confirm);
        if (state.request.status !== "pending_execution") throw new AppError("STATE_NOT_ALLOWED");
        if (state.request.entitlementRevokedAt) throw new AppError("REFUND_ALREADY_REVOKED");
        if (
          state.txns.some(
            (t) => t.refundRequestId === id && [...OPEN, "succeeded"].includes(t.status),
          )
        )
          throw new AppError("REFUND_TXN_OPEN");
        await transition(tx, deps, ctx, state.request, {
          event: "refund.void",
          ref: "08:530",
          action: "voided",
          set: {
            close_reason: "voided",
            voided_by_staff_id: staff.staff.id,
            close_note: input.note,
            closed_at: deps.clock.now(),
          },
        });
        await restore(tx, deps, ctx, state);
        await executionTimer(tx, deps, state);
        return detail(tx, deps, staff, id);
      }, options);
    },
    execute: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: RefundExecuteBody,
      options: Options,
    ) => saga.execute(ctx, staff, id, input, options),
    retry: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: RefundRetryBody,
      options: Options,
    ) => saga.retry(ctx, staff, id, input, options),
    confirmNotAccepted: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: RefundNotAcceptedBody,
      options: Options,
    ) => saga.confirmNotAccepted(ctx, staff, id, input, options),
    async recordOffline(
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: RefundOfflineBody,
      options: Options,
    ) {
      required(options);
      return deps.tx.run(async (tx) => {
        await recordOffline(tx, deps, ctx, staff, id, input);
        return detail(tx, deps, staff, id);
      }, options);
    },
    abandon: (confirmers: RefundConfirmers, input: AbandonInput) =>
      deps.tx.run((tx) => abandon(tx, deps, confirmers, input)),
  };
}
export type Refunds = ReturnType<typeof createRefunds>;
export type { RefundDeps } from "./context.js";
export { createWechatRefundSource } from "./webhook.js";
export { recordRefundResult } from "./result.js";
export { createRefundAssembly } from "./assembly.js";

export { submitExceptionRefund } from "./exception.js";
export type { ExceptionRefundInput } from "./exception.js";
