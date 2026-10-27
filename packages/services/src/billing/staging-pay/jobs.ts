import type { Prisma } from "@liyoxi/db";
import { isAppError } from "../../kernel/index.js";
import type { RecurringRunContext, TxRunner } from "../../kernel/index.js";
import type { RefundDeps } from "../refund/context.js";
import { system } from "../refund/state.js";
import { STAGING_REFUND_JOB } from "./guards.js";
import { createStagingRefunds } from "./writer.js";

const LIMIT = 100;
const LAGGARD_LIMIT = 1000;
const SKIP_ERRORS = new Set([
  "PRECONDITION_CHANGED",
  "PLAN_REFUND_NOT_ELIGIBLE",
  "REFUND_REQUEST_EXISTS",
  "REFUND_NOT_SUPPORTED",
  "RED_INVOICE_REQUIRED",
  "STATE_NOT_ALLOWED",
  "IDEMPOTENCY_IN_PROGRESS",
]);
/** 同一期串行；永久资金意图由writer/rf.poll恢复，内存集合只影响候选排队。 */
export async function runStagingAutorefund(
  deps: RefundDeps,
  ctx: RecurringRunContext,
  laggards: Set<string>,
) {
  if (!ctx.signal || !ctx.runTx) throw new TypeError("预发自动退款要求job运输与取消信号");
  const signal = ctx.signal;
  signal.throwIfAborted();
  if (deps.stagingPay?.APP_ENV !== "stg") throw new TypeError("自动退款只允许预发环境");
  const entityIds = deps.stagingPay.STAGING_PAY?.entityIds ?? [];
  if (entityIds.length === 0) return { disabled: true, scanned: 0, handled: 0, skipped: 0 };
  const cutoff = new Date(deps.clock.now().getTime() - 600_000);
  const where: Prisma.BillingOrderWhereInput = {
    entityId: { in: [...entityIds] },
    orderNo: { startsWith: "TFK" },
    amountFen: { gte: 1, lte: 100 },
    type: { in: ["plan_new", "plan_renew"] },
    channel: "wechat_jsapi",
    status: "paid",
    fulfillmentStatus: "done",
    appliedAt: { not: null },
    paidAt: { not: null },
    hasOpenException: false,
    paidPaymentTxn: {
      is: {
        status: "succeeded",
        channel: "wechat_jsapi",
        appliedAt: { not: null },
        channelSuccessAt: { lte: cutoff },
      },
    },
    // 已提交现金意图的单不再由扫描器处理；原rf.poll负责同号查询/受控补提交。
    refundRequests: {
      none: {
        source: "staging_probe",
        OR: [{ executedAt: { not: null } }, { closedAt: { not: null } }],
      },
    },
  };
  const candidates = await ctx.runTx(async (tx) => {
    signal.throwIfAborted();
    const behind = [...laggards];
    const fresh = await tx.billingOrder.findMany({
      where: { ...where, ...(behind.length ? { id: { notIn: behind } } : {}) },
      select: { id: true, entityId: true },
      orderBy: { id: "asc" },
      take: LIMIT,
    });
    const retried =
      behind.length && fresh.length < LIMIT
        ? await tx.billingOrder.findMany({
            where: { ...where, id: { in: behind } },
            select: { id: true, entityId: true },
            orderBy: { id: "asc" },
            take: LIMIT - fresh.length,
          })
        : [];
    signal.throwIfAborted();
    return [...fresh, ...retried];
  });
  // 复用真实runner及required幂等选项，事务进入/提交前响应取消；不改内核或抢占资金单。
  const tx: TxRunner = {
    run: (fn, options) => {
      signal.throwIfAborted();
      return deps.tx.run(async (t) => {
        signal.throwIfAborted();
        const result = await fn(t);
        signal.throwIfAborted();
        return result;
      }, options);
    },
  };
  const source = deps.wechatPay;
  const refunds = createStagingRefunds({
    ...deps,
    tx,
    ...(source
      ? {
          wechatPay: {
            ...source,
            provider: {
              ...source.provider,
              createRefund: (input) => {
                signal.throwIfAborted();
                return source.provider.createRefund(input);
              },
              queryRefund: (input) => {
                signal.throwIfAborted();
                return source.provider.queryRefund(input);
              },
            },
          },
        }
      : {}),
  });
  let handled = 0,
    skipped = 0,
    failed = 0;
  for (const row of candidates) {
    signal.throwIfAborted();
    try {
      await refunds.refundOrder(system(row, STAGING_REFUND_JOB), row.id);
      handled++;
      laggards.delete(row.id);
    } catch (error) {
      signal.throwIfAborted();
      laggards.add(row.id);
      if (laggards.size > LAGGARD_LIMIT) laggards.delete(laggards.values().next().value!);
      if (isAppError(error) && SKIP_ERRORS.has(error.error)) skipped++;
      else failed++;
    }
  }
  if (failed) throw new Error(`预发自动退款本期处理失败${failed}笔；已提交意图仍由原单号恢复`);
  return { disabled: false, scanned: candidates.length, handled, skipped };
}
