import { createBillingApprovalRefs } from "../support/index.js";
import type { PrismaClient } from "@liyoxi/db";
import type { PlanQuoteBody } from "@liyoxi/contract";
import {
  quotePlan,
  createInvoices,
  recordChannelSuccess,
  createRefundAssembly,
  createRefunds,
  recordRefundResult,
} from "../billing/index.js";
import type { RefundDeps } from "../billing/index.js";
import { createApproval } from "../approval/index.js";
import { createConfig } from "../config/index.js";
import { createDocs } from "../docs/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import {
  createBizNoIssuer,
  createIdentityContext,
  createIdempotencyContext,
  guardProviderCall,
  uuidv7,
} from "../kernel/index.js";
import type { IdentityContext } from "../kernel/index.js";
import { createMedia } from "../media/index.js";
import { isQualificationDead } from "../profile/index.js";
import { createSla } from "../sla/index.js";
import { createTenant } from "../tenant/index.js";
import { createTimers } from "../timers/index.js";
import { assembleForTest } from "./assembly.js";
import {
  applyReceipt,
  createPaymentHarness,
  pendingPlanOrder,
  pendingWechatReceipt,
} from "./billing-payment.js";
import { createClock } from "./clock.js";
import { createFakeProviders } from "./providers/index.js";
import { sampleStaffContext } from "./approval.js";
import { TEST_KEYRING } from "./data/seal.js";

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
  const approvalRefs = options.approvalRefs ?? createBillingApprovalRefs({ clock });
  const media = createMedia({ tx: h.tx, clock, assembly, events, storage: provider.storage });
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
    media,
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
  async function paid(
    existing?: Awaited<ReturnType<typeof h.make.merchant>>,
    purchase?: { planCode: string; intent?: PlanQuoteBody["intent"] },
  ) {
    const own = existing ?? (await h.make.merchant({ verified: true }));
    let order = await pendingPlanOrder(h, { entityId: own.entity.id, channel: "wechat_jsapi" });
    if (purchase) {
      const plan = await prisma.plan.findUniqueOrThrow({ where: { code: purchase.planCode } });
      const quoted = await h.tx.run((tx) =>
        quotePlan(
          tx,
          own.entity.id,
          clock.now(),
          { planId: plan.id, intent: purchase.intent },
          async () => ({
            mode: "in_app",
            isPriceShown: true,
            isPurchasePromptAllowed: true,
            channels: [
              { code: "wechat_jsapi", isEnabled: true, isRecommended: true, hintKey: null },
            ],
            copy: {
              planNounKey: "plan",
              pointsNounKey: "points",
              agreementKeys: ["member", "points"],
              payButtonKey: "pay",
            },
          }),
        ),
      );
      order = await prisma.billingOrder.update({
        where: { id: order.id },
        data: {
          type: quoted.quote.orderType,
          contentSnapshot: quoted.content,
          amountFen: quoted.content.payFen,
        },
      });
    }
    const receipt = await pendingWechatReceipt(h, order);
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
  const invoices = createInvoices({
    ...deps,
    invoiceMedia: media,
    invoiceMailEnabled: async () => false,
    resendMail: async () => {
      throw new Error("退款夹具不重发发票邮件");
    },
  });
  async function issueBlue(
    own: Awaited<ReturnType<typeof paid>>,
    issuer: Awaited<ReturnType<typeof staff>>,
  ) {
    const itemKey = `invoice.item_name.${own.order.type}`;
    if (!(await prisma.paramValue.findFirst({ where: { key: itemKey } })))
      await prisma.paramValue.create({
        data: {
          id: uuidv7(),
          key: itemKey,
          value: "隔离退款技术服务",
          effectiveAt: clock.now(),
          createdByStaffId: issuer.row.id,
          createdAt: clock.now(),
        },
      });
    const membership = await h.tx.run((tx) =>
      deps.tenant.resolveMembership(tx, {
        merchantUserId: own.user.id,
        storeId: own.store.id,
      }),
    );
    if (!membership) throw new Error("测试老板关系缺失");
    const request = await invoices.create(
      {
        membership,
        ctx: createIdentityContext({
          actor: { type: "merchant", id: own.user.id, client: "weapp", role: "owner" },
          entityId: own.entity.id,
          storeId: own.store.id,
        }),
      },
      {
        paymentOrderId: own.order.id,
        invoiceType: "normal",
        medium: "electronic",
        recvEmail: "refund-invoice@example.invalid",
      },
    );
    const file = await invoiceFile(own.entity.id, issuer.row.id);
    const issued = await invoices.issue(issuer.ctx, issuer.staff, request.invoiceRequestId, {
      invoiceNo: "20260000000000000001",
      fileId: file.id,
      confirm: { requestNo: request.requestNo, amountFen: request.amountFen },
    });
    return { request, issued };
  }
  function invoiceFile(entityId: string, staffId: string) {
    return h.make.fileObject({
      category: "invoice",
      bucket: "secure",
      scopeType: "entity",
      entityId,
      uploadActorType: "staff",
      uploadActorId: staffId,
      uploadClient: "admin",
      ext: "pdf",
      mime: "application/pdf",
      declaredMime: "application/pdf",
    });
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
    invoices,
    issueBlue,
    invoiceFile,
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
