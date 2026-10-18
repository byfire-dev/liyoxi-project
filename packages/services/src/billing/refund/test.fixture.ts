import type { PrismaClient } from "@liyoxi/db";
import { createApproval } from "../../approval/index.js";
import { createConfig } from "../../config/index.js";
import { createDocs } from "../../docs/index.js";
import { createEvents } from "../../events/index.js";
import { createFlow } from "../../flow/index.js";
import {
  createBizNoIssuer,
  createIdentityContext,
  createIdempotencyContext,
  guardProviderCall,
  uuidv7,
} from "../../kernel/index.js";
import type { IdentityContext } from "../../kernel/index.js";
import { createMedia } from "../../media/index.js";
import { isQualificationDead } from "../../profile/index.js";
import { createSla } from "../../sla/index.js";
import { createTenant } from "../../tenant/index.js";
import { createTimers } from "../../timers/index.js";
import {
  assembleForTest,
  applyReceipt,
  createClock,
  createFakeProviders,
  createPaymentHarness,
  pendingPlanOrder,
  pendingWechatReceipt,
  sampleStaffContext,
  TEST_KEYRING,
} from "../../testing/index.js";
import { recordChannelSuccess } from "../payment/channel-success.js";
import { createRefundAssembly } from "./assembly.js";
import { createRefunds } from "./index.js";
import type { RefundDeps } from "./context.js";
import { recordRefundResult } from "./result.js";

export function refundIdem(ctx: IdentityContext, scope: string, body: unknown, key = uuidv7()) {
  return {
    idem: createIdempotencyContext({
      mode: "required",
      scope,
      actor: ctx.actor,
      key,
      request: { method: "POST", body },
    }),
  };
}
export function createRefundHarness(
  prisma: PrismaClient,
  options: {
    clock?: ReturnType<typeof createClock>;
    onRefundStep?: RefundDeps["onRefundStep"];
    approvalRefs?: RefundDeps["approvalRefs"];
    providers?: ReturnType<typeof createFakeProviders>;
  } = {},
) {
  const h = createPaymentHarness(prisma, { clock: options.clock ?? createClock() }),
    clock = h.clock;
  const scope = createRefundAssembly(assembleForTest({ entry: "api" })),
    assembly = scope.assembly;
  const events = createEvents({ tx: h.tx, clock, assembly }),
    flow = createFlow({ clock, assembly, events }),
    timers = createTimers({ assembly }),
    bizNo = createBizNoIssuer({ clock, appEnv: "test" }),
    sla = createSla({ clock, assembly });
  const provider =
    options.providers ?? createFakeProviders({ clock, beforeCall: guardProviderCall });
  provider.wechatPay.useWireFormat({ appid: "wx0000000000000000", mchid: "1900000109" });
  const approval = createApproval({ clock, assembly, events, flow, timers, bizNo, sla });
  // 无工单的领域夹具不提供假绑定；带工单用例必须显式注入真实support公口。
  const approvalRefs = options.approvalRefs ?? {
    prepare: async () => {
      throw new Error("本夹具未配置工单");
    },
    attach: async () => {
      throw new Error("本夹具未配置工单");
    },
    list: async () => [],
  };
  const deps: RefundDeps = {
    tx: h.tx,
    clock,
    assembly,
    events,
    flow,
    timers,
    bizNo,
    sla,
    approval,
    config: createConfig({ db: prisma, clock, redis: null }),
    media: createMedia({ tx: h.tx, clock, assembly, events, storage: provider.storage }),
    docs: createDocs({ tx: h.tx, clock }),
    tenant: createTenant({ tx: h.tx, clock, assembly, flow }),
    keyring: () => TEST_KEYRING,
    ledger: h.ledger,
    payment: h.payment,
    isQualificationDead,
    approvalRefs,
    wechatPay: {
      provider: provider.wechatPay,
      appid: "wx0000000000000000",
      mchid: "1900000109",
      currentOpenid: async () => {
        throw new Error("退款夹具不预下单");
      },
    },
    ...(options.onRefundStep ? { onRefundStep: options.onRefundStep } : {}),
  };
  scope.attach(deps);
  const service = createRefunds(deps);
  async function staff(role: "super_admin" | "finance" = "finance") {
    const row = await h.make.staff({ staffRoleKey: role });
    return {
      row,
      staff: await sampleStaffContext(prisma, row.id, { stepUpAt: clock.now() }),
      ctx: createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" } }),
    };
  }
  async function paid(existing?: Awaited<ReturnType<typeof h.make.merchant>>) {
    const own = existing ?? (await h.make.merchant({ verified: true })),
      order = await pendingPlanOrder(h, { entityId: own.entity.id, channel: "wechat_jsapi" }),
      receipt = await pendingWechatReceipt(h, order);
    const made = await provider.wechatPay.createJsapiOrder({
      outTradeNo: receipt.outTradeNo,
      description: "公开隔离退款用例",
      amountFen: receipt.amountFen,
      payerOpenid: receipt.payerOpenid!,
      attach: receipt.attach!,
      expireAt: order.expiresAt,
    });
    if (!made.ok) throw new Error("测试预下单未成功");
    const paid = provider.wechatPay.pay(receipt.outTradeNo);
    if (paid.kind !== "transaction") throw new Error("测试渠道事实类型错误");
    await h.tx.run((tx) =>
      recordChannelSuccess(
        tx,
        {
          clock,
          events,
          appid: deps.wechatPay!.appid,
          mchid: deps.wechatPay!.mchid,
          exceptions: deps,
        },
        createIdentityContext({ actor: { type: "system", job: "lyxtest.paid" } }),
        { paymentTxnId: receipt.id, transaction: paid.transaction },
      ),
    );
    await applyReceipt(h, receipt);
    return {
      ...own,
      order: await prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } }),
      receipt: await prisma.paymentTxn.findUniqueOrThrow({ where: { id: receipt.id } }),
    };
  }
  async function refundReason() {
    return prisma.dictItem.upsert({
      where: { dictTypeKey_code: { dictTypeKey: "refund_reason", code: "RFTEST" } },
      create: {
        id: uuidv7(),
        dictTypeKey: "refund_reason",
        code: "RFTEST",
        name: "隔离退款验证",
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
      update: {},
    });
  }
  async function request(input?: { rule?: "window" | "qualification_failed" | "override" }) {
    const own = await paid(),
      creator = await staff("super_admin"),
      approver = await staff(),
      executor = await staff();
    const reason = await refundReason();
    const body = {
      ruleCode: input?.rule ?? "window",
      reasonCode: reason.code,
      note: "真实退款定点用例说明",
      confirm: { orderNo: own.order.orderNo, amountFen: own.order.paidAmountFen },
    };
    const created = await service.create(
      creator.ctx,
      creator.staff,
      own.order.id,
      body,
      refundIdem(creator.ctx, "admin.paymentOrder.refundRequest.create", body),
    );
    return { ...own, creator, approver, executor, created };
  }
  async function approved() {
    const r = await request(),
      body = {
        lockVersion: 0,
        confirm: { requestNo: r.created.requestNo, amountFen: r.created.amountFen },
        confirmChecks: ["rule_amount_checked"],
      };
    const approved = await service.approve(
      r.approver.ctx,
      r.approver.staff,
      r.created.refundRequestId,
      body,
      refundIdem(r.approver.ctx, "admin.refundRequest.approve", body),
    );
    return { ...r, approved };
  }
  const executeBody = (r: Awaited<ReturnType<typeof approved>>) => ({
    confirm: {
      requestNo: r.created.requestNo,
      amountFen: r.created.amountFen,
      channelTxnNo: r.receipt.channelTxnNo!,
    },
    confirmChecks: ["original_txn_checked"],
  });
  async function execute(r: Awaited<ReturnType<typeof approved>>, key = uuidv7()) {
    const body = executeBody(r);
    return service.execute(
      r.executor.ctx,
      r.executor.staff,
      r.created.refundRequestId,
      body,
      refundIdem(r.executor.ctx, "admin.refundRequest.execute", body, key),
    );
  }
  async function result(txnId: string, status: "SUCCESS" | "CLOSED" | "ABNORMAL" = "SUCCESS") {
    const txn = await prisma.refundTxn.findUniqueOrThrow({ where: { id: txnId } });
    provider.wechatPay.completeRefund(txn.outRefundNo, { status });
    const response = await provider.wechatPay.queryRefund({ outRefundNo: txn.outRefundNo });
    if (!response.ok) throw new Error("测试退款查单失败");
    return h.tx.run((tx) =>
      recordRefundResult(
        tx,
        deps,
        createIdentityContext({ actor: { type: "system", job: "rf.poll" } }),
        { refundTxnId: txnId, fact: response.value, detectedBy: "query" },
      ),
    );
  }
  return {
    ...h,
    assembly,
    deps,
    service,
    scope,
    provider,
    staff,
    refundReason,
    paid,
    request,
    approved,
    execute,
    executeBody,
    result,
    close: () => scope.close(),
  };
}
export type RefundHarness = ReturnType<typeof createRefundHarness>;
