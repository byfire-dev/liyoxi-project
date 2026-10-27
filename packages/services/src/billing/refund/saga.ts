import { createHash, randomBytes } from "node:crypto";
import { RefundBreakdownSchema } from "@liyoxi/contract";
import type { RefundExecuteBody, RefundRetryBody, RefundNotAcceptedBody } from "@liyoxi/contract";
import type { RefundTxn } from "@liyoxi/db";
import {
  AppError,
  createThreePhaseRunner,
  IDEMPOTENCY_LEASE_MS,
  uuidv7,
} from "../../kernel/index.js";
import type {
  IdempotencyContext,
  IdentityContext,
  Tx,
  FiredTimer,
  DeliveredEvent,
} from "../../kernel/index.js";
import type { TimerRef } from "../../timers/index.js";
import type { StaffContext } from "../../authz/index.js";
import type { ProviderResult, WechatPayRefund } from "../../providers/types.js";
import { paramsAt } from "../../config/index.js";
import {
  assertStaff,
  confirmMoney,
  lockRefund,
  OPEN,
  refundable,
  termsOf,
  visible,
} from "./context.js";
import type { RefundDeps, LockedRefund } from "./context.js";
import { originalRoute } from "./quote.js";
import { recheck } from "./approval.js";
import { detail } from "./read.js";
import { executionTimer, failed, system, transition } from "./state.js";
import { recordRefundResult } from "./result.js";

type Attempt = { txn: RefundTxn; outTradeNo: string; totalFen: number; submit: boolean };
export async function executionGuards(
  tx: Tx,
  deps: RefundDeps,
  staff: StaffContext,
  state: LockedRefund,
) {
  if (state.request.status !== "pending_execution") throw new AppError("STATE_NOT_ALLOWED");
  if (state.txns.some((t) => t.refundRequestId === state.request.id && OPEN.includes(t.status)))
    throw new AppError("REFUND_TXN_OPEN");
  const values = await paramsAt(tx, ["refund.require_distinct_executor"], deps.clock.now());
  if (
    values["refund.require_distinct_executor"] === true &&
    state.approval.decidedByStaffId === staff.staff.id
  )
    throw new AppError("REFUND_EXECUTOR_CONFLICT");
  if (state.receipt.appliedAt && state.order?.paidPaymentTxnId === state.receipt.id) {
    const latest = [...state.invoices].sort(
      (a, b) => b.appliedAt.getTime() - a.appliedAt.getTime() || b.id.localeCompare(a.id),
    )[0];
    if (latest && ["issued", "red_pending"].includes(latest.status))
      throw new AppError("RED_INVOICE_REQUIRED", { details: { invoiceRequestId: latest.id } });
  }
  if (state.request.amountFen > refundable(state))
    throw new AppError("REFUND_EXCEEDS_REFUNDABLE", {
      details: { refundableFen: refundable(state) },
    });
}
export async function revoke(tx: Tx, deps: RefundDeps, ctx: IdentityContext, state: LockedRefund) {
  const breakdown = RefundBreakdownSchema.parse(state.request.breakdownSnapshot);
  const result = await recheck(tx, deps, state);
  if (!result.eligible)
    throw new AppError("PLAN_REFUND_NOT_ELIGIBLE", { details: { reasons: result.reasons } });
  if ("termId" in breakdown && !state.request.entitlementRevokedAt) {
    const term = await tx.subscriptionTerm.findUniqueOrThrow({ where: { id: breakdown.termId } });
    const cashOnly =
      state.order?.type === "plan_upgrade" &&
      state.request.ruleCode === "override" &&
      ["refunded", "cancelled"].includes(term.status);
    if (!cashOnly) {
      await termsOf(deps).revokeTerm(tx, ctx, {
        termId: term.id,
        refundRequestId: state.request.id,
      });
      await tx.refundRequest.update({
        where: { id: state.request.id },
        data: { entitlementRevokedAt: deps.clock.now(), updatedAt: deps.clock.now() },
      });
    }
  }
  const old =
    state.request.recheckLog &&
    typeof state.request.recheckLog === "object" &&
    !Array.isArray(state.request.recheckLog)
      ? state.request.recheckLog
      : {};
  await tx.refundRequest.update({
    where: { id: state.request.id },
    data: { recheckLog: { ...old, execute: result }, updatedAt: deps.clock.now() },
  });
}
export async function refundNumber(tx: Tx, state: LockedRefund) {
  const count = await tx.refundTxn.count({ where: { refundRequestId: state.request.id } });
  if (count >= 99 || !state.approval.requestNo) throw new AppError("STATE_NOT_ALLOWED");
  return `${state.approval.requestNo}-${String(count + 1).padStart(2, "0")}-${randomBytes(3).toString("hex").toUpperCase()}`;
}
export function createRefundSaga(deps: RefundDeps) {
  const phases = createThreePhaseRunner(deps);
  function provider() {
    if (!deps.wechatPay?.provider.configured) throw new AppError("PROVIDER_UNAVAILABLE");
    return deps.wechatPay.provider;
  }
  async function arm(tx: Tx, txn: RefundTxn, n: number, immediate = false, submit = false) {
    if (!OPEN.includes(txn.status)) return;
    const delay = immediate
      ? 0
      : txn.status === "abnormal"
        ? 86_400_000
        : Math.min(3_600_000, 300_000 * 2 ** Math.min(n, 4));
    await deps.timers.arm(tx, {
      kind: "rf.poll",
      subject: { type: "refund_txn", id: txn.id },
      key: `rf.poll:refund_txn:${txn.id}:n${n}`,
      fireAt: new Date(deps.clock.now().getTime() + delay),
      payload: { n, submit },
      ...(txn.entityId ? { entityId: txn.entityId } : {}),
    });
  }
  function attempt(state: LockedRefund, txn: RefundTxn, submit: boolean): Attempt {
    return {
      txn,
      outTradeNo: state.receipt.outTradeNo,
      totalFen: state.receipt.channelAmountFen!,
      submit,
    };
  }
  async function reserve(tx: Tx, txn: RefundTxn, automatic: boolean) {
    if (txn.status !== "created" || (automatic && (txn.isRetryHalted || txn.submitCount >= 2)))
      return null;
    if (
      txn.lastSubmitAt &&
      deps.clock.now().getTime() - txn.lastSubmitAt.getTime() < IDEMPOTENCY_LEASE_MS
    )
      return null;
    return tx.refundTxn.update({
      where: { id: txn.id },
      data: {
        submitCount: { increment: 1 },
        lastSubmitAt: deps.clock.now(),
        isRetryHalted: automatic ? txn.submitCount + 1 >= 2 : true,
        updatedAt: deps.clock.now(),
      },
    });
  }
  async function send(intent: Attempt): Promise<ProviderResult<WechatPayRefund> | null> {
    if (!intent.submit) return null;
    const result = await provider().createRefund({
      outTradeNo: intent.outTradeNo,
      outRefundNo: intent.txn.outRefundNo,
      refundFen: intent.txn.amountFen,
      totalFen: intent.totalFen,
    });
    await deps.onRefundStep?.("external");
    return result;
  }
  async function settle(tx: Tx, intent: Attempt, result: ProviderResult<WechatPayRefund> | null) {
    const state = await lockRefund(tx, intent.txn.refundRequestId!),
      current = state.txns.find((t) => t.id === intent.txn.id)!;
    // 提前到达的callback成功、关闭或异常事实不被旧提交应答覆盖。
    if (current.status !== "created" || !result) {
      if (OPEN.includes(current.status)) await arm(tx, current, 0);
      return current;
    }
    const accepted =
      result.ok &&
      result.value.outRefundNo === current.outRefundNo &&
      result.value.outTradeNo === state.receipt.outTradeNo &&
      result.value.refundFen === current.amountFen &&
      result.value.refundId.length > 0;
    const saved = await tx.refundTxn.update({
      where: { id: current.id },
      data: {
        status: accepted ? "processing" : "created",
        channelRefundNo: accepted && result.ok ? result.value.refundId : current.channelRefundNo,
        failCode: accepted ? null : result.ok ? "reply_mismatch" : result.reason,
        failMessage: accepted ? null : "渠道未确认受理，保留原退款单号继续查询",
        updatedAt: deps.clock.now(),
      },
    });
    await arm(tx, saved, 0, accepted);
    await deps.onRefundStep?.("result");
    return saved;
  }
  async function authorize(tx: Tx, ctx: IdentityContext, staff: StaffContext, id: string) {
    await assertStaff(tx, deps, ctx, staff, "finance.refund.execute");
    await visible(tx, staff, id);
  }
  const required = (options: { idem?: IdempotencyContext }) => {
    if (options.idem?.mode !== "required") throw new AppError("INTERNAL");
  };
  return {
    async execute(
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: RefundExecuteBody,
      options: { idem?: IdempotencyContext },
    ) {
      required(options);
      provider();
      await deps.tx.run((tx) => authorize(tx, ctx, staff, id));
      return phases.run(
        {
          claim: async (tx, { resumed }) => {
            await authorize(tx, ctx, staff, id);
            const state = await lockRefund(tx, id);
            confirmMoney(state, input.confirm);
            if (
              input.confirm.channelTxnNo !== state.receipt.channelTxnNo ||
              !input.confirmChecks.includes("original_txn_checked")
            )
              throw new AppError("CONFIRM_MISMATCH");
            const intentKey = createHash("sha256")
              .update(
                JSON.stringify([options.idem!.scope, options.idem!.actorKey, options.idem!.key]),
              )
              .digest("hex");
            const log =
              state.request.recheckLog &&
              typeof state.request.recheckLog === "object" &&
              !Array.isArray(state.request.recheckLog)
                ? state.request.recheckLog
                : {};
            const intents =
              log.executeIntents &&
              typeof log.executeIntents === "object" &&
              !Array.isArray(log.executeIntents)
                ? log.executeIntents
                : {};
            const savedId = intents[intentKey];
            if (typeof savedId === "string") {
              const previous = state.txns.find((t) => t.id === savedId && t.refundRequestId === id);
              if (!previous) throw new AppError("INTERNAL");
              const reserved = await reserve(tx, previous, true);
              return attempt(state, reserved ?? previous, !!reserved);
            }
            if (resumed) throw new AppError("INTERNAL");
            await executionGuards(tx, deps, staff, state);
            if (!(await originalRoute(tx, deps, state.receipt)))
              throw new AppError("REFUND_ROUTE_NOT_ALLOWED", {
                details: { allowedRoutes: ["offline"] },
              });
            const outRefundNo = await refundNumber(tx, state);
            await revoke(tx, deps, ctx, state);
            const now = deps.clock.now(),
              txn = await tx.refundTxn.create({
                data: {
                  id: uuidv7(),
                  entityId: state.request.entityId,
                  refundRequestId: id,
                  billingOrderId: state.request.billingOrderId,
                  paymentTxnId: state.receipt.id,
                  channel: "wechat_jsapi",
                  origin: "system",
                  outRefundNo,
                  amountFen: state.request.amountFen,
                  status: "created",
                  submitCount: 1,
                  lastSubmitAt: now,
                  createdAt: now,
                  updatedAt: now,
                },
              });
            const fresh = await tx.refundRequest.findUniqueOrThrow({ where: { id } });
            const freshLog =
              fresh.recheckLog &&
              typeof fresh.recheckLog === "object" &&
              !Array.isArray(fresh.recheckLog)
                ? fresh.recheckLog
                : {};
            await tx.refundRequest.update({
              where: { id },
              data: {
                recheckLog: { ...freshLog, executeIntents: { ...intents, [intentKey]: txn.id } },
              },
            });
            await transition(tx, deps, ctx, state.request, {
              event: "refund.execute",
              ref: "08:527",
              action: "execution_started",
              payload: { refundTxnId: txn.id },
              set: {
                exec_route: "wechat_original",
                executed_by_staff_id: staff.staff.id,
                executed_at: now,
              },
            });
            await executionTimer(tx, deps, state);
            await deps.events.emit(tx, ctx, {
              type: "refund_txn.created",
              aggregate: { type: "refund_txn", id: txn.id },
              payload: { v: 1, refundTxnId: txn.id, refundRequestId: id, amountFen: txn.amountFen },
              entityId: txn.entityId,
              storeId: null,
              dedupeKey: `refund_txn.created:${txn.id}`,
            });
            await deps.onRefundStep?.("intent");
            return attempt(state, txn, true);
          },
          external: send,
          settle: async (tx, result, intent) => {
            await settle(tx, intent, result);
            return detail(tx, deps, staff, id);
          },
        },
        options,
      );
    },
    async retry(
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: RefundRetryBody,
      options: { idem?: IdempotencyContext },
    ) {
      required(options);
      provider();
      await deps.tx.run((tx) => authorize(tx, ctx, staff, id));
      return phases.run(
        {
          claim: async (tx) => {
            await authorize(tx, ctx, staff, id);
            const state = await lockRefund(tx, id);
            const txn = state.txns.find(
              (t) => t.refundRequestId === id && t.outRefundNo === input.confirm.outRefundNo,
            );
            if (input.confirm.requestNo !== state.approval.requestNo)
              throw new AppError("CONFIRM_MISMATCH");
            if (state.request.status !== "executing" || txn?.status !== "created")
              throw new AppError("STATE_NOT_ALLOWED");
            const reserved = await reserve(tx, txn, false);
            if (!reserved) throw new AppError("IDEMPOTENCY_IN_PROGRESS");
            return attempt(state, reserved, true);
          },
          external: send,
          settle: async (tx, result, intent) => {
            await settle(tx, intent, result);
            return detail(tx, deps, staff, id);
          },
        },
        options,
      );
    },
    async confirmNotAccepted(
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: RefundNotAcceptedBody,
      options: { idem?: IdempotencyContext },
    ) {
      required(options);
      provider();
      await deps.tx.run((tx) => authorize(tx, ctx, staff, id));
      return phases.run(
        {
          claim: async (tx) => {
            await authorize(tx, ctx, staff, id);
            const state = await lockRefund(tx, id),
              txn = state.txns.find(
                (t) => t.refundRequestId === id && t.outRefundNo === input.confirm.outRefundNo,
              );
            if (input.confirm.requestNo !== state.approval.requestNo)
              throw new AppError("CONFIRM_MISMATCH");
            if (state.request.status !== "executing" || txn?.status !== "created")
              throw new AppError("STATE_NOT_ALLOWED");
            if (
              !txn.isRetryHalted ||
              !txn.lastSubmitAt ||
              deps.clock.now().getTime() - txn.lastSubmitAt.getTime() < 600_000
            )
              throw new AppError("REFUND_NOT_ACCEPTED_UNCONFIRMED", {
                details: {
                  reasons: [
                    ...(!txn.isRetryHalted ? ["retry_not_halted"] : []),
                    ...(!txn.lastSubmitAt ||
                    deps.clock.now().getTime() - txn.lastSubmitAt.getTime() < 600_000
                      ? ["too_soon"]
                      : []),
                  ],
                },
              });
            return attempt(state, txn, false);
          },
          external: async (intent) => {
            const result = await provider().queryRefund({ outRefundNo: intent.txn.outRefundNo });
            if (result.ok)
              await deps.tx.run((tx) =>
                recordRefundResult(tx, deps, system({ entityId: intent.txn.entityId }), {
                  refundTxnId: intent.txn.id,
                  fact: result.value,
                  detectedBy: "query",
                }),
              );
            return result;
          },
          settle: async (tx, result, intent) => {
            await authorize(tx, ctx, staff, id);
            const state = await lockRefund(tx, id),
              txn = state.txns.find((t) => t.id === intent.txn.id)!;
            if (result.ok)
              throw new AppError("REFUND_NOT_ACCEPTED_UNCONFIRMED", {
                details: { reasons: ["exists_on_channel"] },
              });
            if (!result.refundNotFound) throw new AppError("PROVIDER_UNAVAILABLE");
            if (
              state.request.status !== "executing" ||
              txn.status !== "created" ||
              !txn.isRetryHalted ||
              !txn.lastSubmitAt ||
              deps.clock.now().getTime() - txn.lastSubmitAt.getTime() < 600_000 ||
              txn.lastSubmitAt.getTime() !== intent.txn.lastSubmitAt?.getTime()
            )
              throw new AppError("REFUND_NOT_ACCEPTED_UNCONFIRMED");
            await tx.refundTxn.update({
              where: { id: txn.id },
              data: {
                status: "not_accepted",
                lastQueriedAt: deps.clock.now(),
                updatedAt: deps.clock.now(),
              },
            });
            await failed(tx, deps, state, txn.id, "not_accepted");
            await deps.timers.cancel(tx, {
              subject: { type: "refund_txn", id: txn.id },
              kinds: ["rf.poll"],
            });
            return detail(tx, deps, staff, id);
          },
        },
        options,
      );
    },
    async onSubmit(tx: Tx, event: DeliveredEvent) {
      const id = event.payload.refundTxnId;
      if (typeof id !== "string") throw new TypeError("退款事件缺交易身份");
      const txn = await tx.refundTxn.findUnique({ where: { id } });
      if (!txn || !OPEN.includes(txn.status)) return;
      if (txn.status !== "created" || txn.isRetryHalted || txn.submitCount >= 2) {
        await arm(tx, txn, 0);
        return;
      }
      await deps.timers.arm(tx, {
        kind: "rf.poll",
        subject: { type: "refund_txn", id },
        key: `rf.poll:refund_txn:${id}:n0`,
        fireAt: new Date(
          Math.max(
            deps.clock.now().getTime(),
            (txn.lastSubmitAt?.getTime() ?? 0) + IDEMPOTENCY_LEASE_MS,
          ),
        ),
        payload: { n: 0, submit: true },
        ...(txn.entityId ? { entityId: txn.entityId } : {}),
      });
    },
    async preparePoll(ref: TimerRef) {
      if (ref.kind !== "rf.poll") return;
      const intent = await deps.tx.run(async (tx) => {
        const timer = await tx.timer.findUnique({ where: { id: ref.timerId } });
        if (
          !timer ||
          timer.status !== "dispatched" ||
          timer.dispatchNo !== ref.dispatchNo ||
          timer.fireAt > deps.clock.now() ||
          timer.subjectType !== "refund_txn" ||
          !timer.subjectId
        )
          return null;
        const before = await tx.refundTxn.findUnique({ where: { id: timer.subjectId } });
        if (!before?.refundRequestId) return null;
        const state = await lockRefund(tx, before.refundRequestId),
          txn = state.txns.find((t) => t.id === before.id)!;
        if (!OPEN.includes(txn.status)) return null;
        const payload =
          timer.payload && typeof timer.payload === "object" && !Array.isArray(timer.payload)
            ? timer.payload
            : {};
        const reserved = payload.submit === true ? await reserve(tx, txn, true) : null;
        return attempt(state, reserved ?? txn, !!reserved);
      });
      if (!intent) return;
      if (intent.submit) {
        const result = await send(intent);
        await deps.tx.run((tx) => settle(tx, intent, result));
      }
      const result = await provider().queryRefund({ outRefundNo: intent.txn.outRefundNo });
      if (result.ok)
        await deps.tx.run((tx) =>
          recordRefundResult(tx, deps, system({ entityId: intent.txn.entityId }), {
            refundTxnId: intent.txn.id,
            fact: result.value,
            detectedBy: "query",
          }),
        );
      else
        await deps.tx.run(async (tx) => {
          const state = await lockRefund(tx, intent.txn.refundRequestId!);
          const txn = state.txns.find((t) => t.id === intent.txn.id)!;
          if (OPEN.includes(txn.status))
            await tx.refundTxn.update({
              where: { id: txn.id },
              data: { lastQueriedAt: deps.clock.now(), updatedAt: deps.clock.now() },
            });
        });
    },
    async poll(tx: Tx, timer: FiredTimer) {
      if (timer.subjectType !== "refund_txn" || !timer.subjectId) return "skipped" as const;
      const before = await tx.refundTxn.findUnique({ where: { id: timer.subjectId } });
      if (!before?.refundRequestId) return "skipped" as const;
      const state = await lockRefund(tx, before.refundRequestId),
        txn = state.txns.find((t) => t.id === before.id)!;
      if (!OPEN.includes(txn.status)) return "skipped" as const;
      const n =
        typeof timer.payload?.n === "number" &&
        Number.isSafeInteger(timer.payload.n) &&
        timer.payload.n >= 0
          ? timer.payload.n
          : 0;
      await arm(tx, txn, n + 1);
      return "fired" as const;
    },
  };
}
