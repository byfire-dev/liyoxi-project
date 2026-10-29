// M4首个资金切片：所有资金写经真实Hono路由；外部只用已合假通道真实签名协议。
import assert from "node:assert/strict";
import { allRoutes } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import type { M4Support } from "@liyoxi/services/testing";
import type { M1Api } from "./in-process.js";
import { activateM1Staff, bootstrapM1Admin } from "./m1-auth.js";
import { runM4Finance } from "./m4-finance.js";
import { prepareM4Merchant } from "./m4-merchant.js";
import { runM4Reconciliation } from "./m4-reconcile.js";
import { createM1Caller } from "./runner-api.js";

export async function runM4Chain(input: {
  readonly api: M1Api;
  readonly support: M4Support;
  readonly say?: (message: string) => void;
  readonly afterCore?: (context: {
    readonly entityId: string;
    readonly replaySameIntent: () => Promise<void>;
  }) => Promise<void>;
}) {
  const { api, support, say = () => {} } = input;
  assert.equal(api.support, support);
  const call = createM1Caller(api),
    key = (name: string) => `m4-${support.runId}-${name}`;
  const admin = await bootstrapM1Admin(api),
    seeded = await support.seedDemo();
  const activate = async (name: "finance" | "finance_lead" | "delivery_manager", phone: string) => {
    const member = seeded.staff.find((row) => row.key === name);
    assert.ok(member?.activation);
    // 两名财务是固定独立客户端，沿M2同一真实认证前置，不轮换单次请求IP。
    const actorApi: M1Api = {
      ...api,
      request: (path, init) =>
        api.request(path, { ...init, peer: `198.19.4.${Number(phone.slice(-2))}` }),
    };
    return activateM1Staff(actorApi, {
      phone,
      staffId: member.staffId,
      activationCode: member.activation.code,
    });
  };
  const finance = await activate("finance", "19900000007"),
    lead = await activate("finance_lead", "19900000006"),
    managerActor = await activate("delivery_manager", "19900000002");
  assert.notEqual(finance.staffId, lead.staffId);
  // 与原M1相同：每个非空员工组通过真实管理接口保留启用主管。
  const staff = (await call("admin.staff.list", admin.headers, { query: { limit: 100 } })).items;
  for (const groupId of new Set(
    staff.flatMap((row) => (row.staffGroup ? [row.staffGroup.staffGroupId] : [])),
  )) {
    const members = staff.filter((row) => row.staffGroup?.staffGroupId === groupId);
    if (members.some((row) => row.status === "active" && row.isLead)) continue;
    const candidate = members.find((row) => row.status === "active");
    assert.ok(candidate);
    const detail = await call("admin.staff.get", admin.headers, {
      params: { staffId: candidate.staffId },
    });
    await call("admin.staff.update", admin.headers, {
      params: { staffId: candidate.staffId },
      body: { isLead: true, lockVersion: detail.lockVersion, ackNoLead: false },
    });
  }
  say("实际两名财务，受控限额提议与异人批准");
  const current = await call("admin.financeConfigRevision.list", finance.headers, {
    query: { tab: "current" },
  });
  const base = current.items.find((row) => row.configKey === "controls");
  const proposal = await call("admin.financeConfigRevision.create", finance.headers, {
    key: key("controls"),
    body: {
      configKey: "controls",
      payload: {
        adminCreateOrder: true,
        wechatSingleLimitFen: 1_000_000,
        wechatDailyLimitFen: 5_000_000,
        receiptSecondReviewFen: null,
        shippingReport: false,
      },
      changeNote: "M4隔离资金主链限额",
      confirm: { configKey: "controls", baseRevisionId: base?.financeConfigRevisionId ?? null },
    },
  });
  const approvedConfig = await call("admin.financeConfigRevision.approve", lead.headers, {
    key: key("controls-approve"),
    params: { financeConfigRevisionId: proposal.financeConfigRevisionId },
    body: {
      lockVersion: proposal.approval.lockVersion,
      confirmChecks: ["change_reviewed"],
      confirm: { configKey: "controls", financeConfigRevisionId: proposal.financeConfigRevisionId },
    },
  });
  assert.equal(approvedConfig.state, "effective");
  assert.equal(approvedConfig.approval.decidedBy?.staffId, lead.staffId);
  const manager = seeded.staff.find((row) => row.key === "delivery_manager");
  assert.ok(manager);
  const owner = await prepareM4Merchant(api, support, { admin, reviewer: manager });
  const headers = owner.headers;
  const policy = await call("m.purchasePolicy.get", headers);
  assert.ok(policy.channels.some((row) => row.code === "wechat_jsapi" && row.isEnabled));
  const packs = await call("m.pointPack.list", headers);
  assert.ok(Array.isArray(packs.items));
  const plans = await call("m.plan.list", headers),
    plan = plans.items.find((row) => row.code === "basic");
  assert.ok(plan);
  const quote = await call("m.plan.quote", headers, { body: { planId: plan.planId, months: 1 } });
  assert.equal(quote.action, "subscribe");
  assert.ok(quote.payFen > 0);
  const adminQuote = await call("admin.plan.quote", finance.headers, {
    body: { kind: "renewal", pointAccountId: owner.entityId, planId: plan.planId, months: 1 },
  });
  assert.equal(adminQuote.scope, "entity");
  assert.equal(adminQuote.quote?.payFen, quote.payFen);
  const agreements = await call("m.agreement.list", headers, { query: { scene: "plan_purchase" } });
  const orderBody = {
    planId: quote.planId,
    months: 1,
    channel: "wechat_jsapi" as const,
    expectAmountFen: quote.payFen,
    agreementVersionIds: agreements.items.flatMap((row) =>
      row.currentVersion ? [row.currentVersion.agreementVersionId] : [],
    ),
  };
  say("真实报价、同意与下单，原key重放唯一付款单");
  const order = await call("m.paymentOrder.create", headers, {
    key: key("order"),
    body: orderBody,
  });
  const replayed = await call("m.paymentOrder.create", headers, {
    key: key("order"),
    body: orderBody,
  });
  assert.equal(replayed.paymentOrderId, order.paymentOrderId);
  const params = { paymentOrderId: order.paymentOrderId };
  const prepay = await call("m.paymentOrder.wechatPrepay", headers, { key: key("prepay"), params });
  assert.ok(prepay.payParams);
  const pending = await support.financeFacts(owner.entityId),
    receipt = pending.payments.find((row) => row.billingOrderId === order.paymentOrderId);
  assert.ok(receipt);
  assert.equal(receipt.status, "prepaid");
  const hook = async (
    operationId: "hooks.wechatpay.transaction.notify" | "hooks.wechatpay.refund.notify",
    notification: ReturnType<typeof support.providers.wechatPay.pay>,
  ) => {
    const route = allRoutes.find((row) => row.operationId === operationId);
    assert.ok(route);
    const encoded = support.providers.wechatPay.encode(notification);
    const response = await api.request(route.path, {
      method: route.method.toUpperCase(),
      headers: encoded.headers,
      rawBody: encoded.rawBody,
    });
    assert.equal(response.status, 200, `${operationId}实际签名回调`);
  };
  const paidNotice = support.providers.wechatPay.pay(receipt.outTradeNo);
  say("官方格式签名支付回调、主动查单、重复通知均只履约一次");
  await hook("hooks.wechatpay.transaction.notify", paidNotice);
  await call("m.paymentOrder.sync", headers, { params });
  await support.drainEvents();
  const paid = await call("m.paymentOrder.get", headers, { params });
  assert.equal(paid.status, "paid");
  const wallet = await call("m.wallet.get", headers);
  assert.equal(wallet.subscription.status, "active");
  assert.equal(wallet.points.spendablePoints, quote.benefits.monthlyPoints);
  const once = await support.financeFacts(owner.entityId);
  await hook("hooks.wechatpay.transaction.notify", paidNotice);
  await support.drainEvents();
  const repeated = await support.financeFacts(owner.entityId);
  assert.equal(repeated.operations, once.operations);
  assert.equal(repeated.ledgerEntries, once.ledgerEntries);
  assert.equal(repeated.payments.length, 1);
  assert.equal(repeated.orders[0]?.fulfillmentStatus, "done");
  assert.ok(repeated.payments[0]?.appliedAt);
  assert.equal(repeated.payments[0]?.channelAmountFen, quote.payFen);

  say("真实账户调整试算、提交零动账、异人批准与积分读回");
  await call("admin.pointAccount.adjustmentQuote", admin.headers, {
    params: { pointAccountId: owner.entityId },
    body: { direction: "increase", lotKind: "plan", adjustPoints: 100, reasonCode: "compensation" },
  });
  const adjustment = await call("admin.pointAdjustmentRequest.create", admin.headers, {
    key: key("adjust"),
    body: {
      pointAccountId: owner.entityId,
      direction: "increase",
      lotKind: "plan",
      adjustPoints: 100,
      reasonCode: "compensation",
      note: "M4真实补偿调整",
      confirm: { spendableBeforePoints: wallet.points.spendablePoints },
    },
  });
  assert.equal(
    (await call("m.wallet.get", headers)).points.spendablePoints,
    wallet.points.spendablePoints,
  );
  assert.ok(adjustment.requestNo);
  await call("admin.pointAdjustmentRequest.approve", lead.headers, {
    key: key("adjust-approve"),
    params: { pointAdjustmentRequestId: adjustment.pointAdjustmentRequestId },
    body: {
      lockVersion: adjustment.approval.lockVersion,
      confirm: { requestNo: adjustment.requestNo, direction: "increase", adjustPoints: 100 },
      confirmChecks: ["basis_checked"],
    },
  });
  assert.equal(
    (await call("m.wallet.get", headers)).points.spendablePoints,
    wallet.points.spendablePoints + 100,
  );
  // 续费列表是必选tab的到期队列，不能拿未到期的新周期充当队列数据。
  const termRow = (await support.readState(owner)).terms.find(
    (row) => row.sourceBillingOrderId === order.paymentOrderId,
  );
  assert.ok(termRow);
  const term = await call("admin.subscriptionTerm.get", admin.headers, {
    params: { subscriptionTermId: termRow.id },
  });
  assert.equal(term.entity.entityId, owner.entityId);
  assert.equal(term.endDate, paid.fulfillment?.term?.endDate);
  const extensionQuote = await call("admin.subscriptionTerm.extensionQuote", managerActor.headers, {
    params: { subscriptionTermId: term.subscriptionTermId },
    body: { days: 7 },
  });
  const extension = await call("admin.termExtensionRequest.create", managerActor.headers, {
    key: key("extend"),
    body: {
      subscriptionTermId: term.subscriptionTermId,
      days: 7,
      reasonCode: "EX419",
      note: "M4真实七天补偿",
      confirm: { subscriptionTermId: term.subscriptionTermId, endDate: term.endDate },
    },
  });
  assert.ok(extension.requestNo);
  const extended = await call("admin.termExtensionRequest.approve", admin.headers, {
    key: key("extend-approve"),
    params: { termExtensionRequestId: extension.termExtensionRequestId },
    body: {
      lockVersion: extension.approval.lockVersion,
      confirm: { requestNo: extension.requestNo, days: 7 },
      confirmChecks: ["effect_preview_checked"],
    },
  });
  assert.notEqual(managerActor.staffId, admin.staffId);
  assert.equal(extended.approval.decidedBy?.staffId, admin.staffId);
  assert.equal(extended.applied?.newEndDate, extensionQuote.newEndDate);
  assert.equal(
    (await call("m.wallet.get", headers)).subscription.endDate,
    extensionQuote.newEndDate,
  );

  say("真实七天窗口退款：申请、异人批准、执行、签名结果与唯一资金回收");
  const refundQuote = await call("admin.paymentOrder.refundQuote", admin.headers, {
    params,
    body: { ruleCode: "window" },
  });
  assert.equal(refundQuote.supported, true);
  assert.equal(refundQuote.refundableFen, quote.payFen);
  const refundBody = {
    ruleCode: "window" as const,
    reasonCode: "RF419",
    note: "M4真实七天退款",
    confirm: { orderNo: order.orderNo, amountFen: refundQuote.refundableFen },
  };
  const refund = await call("admin.paymentOrder.refundRequest.create", admin.headers, {
    key: key("refund"),
    params,
    body: refundBody,
  });
  assert.equal(refund.status, "pending_approval");
  assert.equal((await call("m.paymentOrder.get", headers, { params })).refundedAt, null);
  const refundParams = { refundRequestId: refund.refundRequestId };
  const approved = await call("admin.refundRequest.approve", finance.headers, {
    key: key("refund-approve"),
    params: refundParams,
    body: {
      lockVersion: refund.approval.lockVersion,
      confirm: { requestNo: refund.requestNo, amountFen: refund.amountFen },
      confirmChecks: ["rule_amount_checked"],
    },
  });
  assert.equal(approved.status, "pending_execution");
  assert.ok(approved.paymentTxn?.channelTxnNo);
  const executing = await call("admin.refundRequest.execute", lead.headers, {
    key: key("refund-execute"),
    params: refundParams,
    body: {
      confirm: {
        requestNo: approved.requestNo,
        amountFen: approved.amountFen,
        channelTxnNo: approved.paymentTxn.channelTxnNo,
      },
      confirmChecks: ["original_txn_checked"],
    },
  });
  assert.equal(executing.status, "executing");
  const refundTxn = executing.refundTxns[0];
  assert.ok(refundTxn);
  const refundNotice = support.providers.wechatPay.completeRefund(refundTxn.outRefundNo);
  await hook("hooks.wechatpay.refund.notify", refundNotice);
  await support.drainEvents();
  const done = await call("admin.refundRequest.get", lead.headers, { params: refundParams });
  assert.equal(done.status, "done");
  assert.equal(done.refundTxns.length, 1);
  assert.equal(done.refundTxns[0]?.status, "succeeded");
  assert.ok(done.entitlementRevokedAt);
  const beforeRefundReplay = await support.financeFacts(owner.entityId);
  await hook("hooks.wechatpay.refund.notify", refundNotice);
  await support.drainEvents();
  const after = await support.financeFacts(owner.entityId);
  assert.equal(after.operations, beforeRefundReplay.operations);
  assert.equal(after.ledgerEntries, beforeRefundReplay.ledgerEntries);
  assert.equal(after.orders[0]?.refundedAmountFen, quote.payFen);
  assert.ok(after.history.some((row) => row.machine === "billing_order" && row.toState === "paid"));
  assert.ok(
    after.history.some((row) => row.machine === "refund_request" && row.toState === "done"),
  );
  assert.ok(after.audits > 0);
  assert.ok(after.events.length > 0);
  await input.afterCore?.({
    entityId: owner.entityId,
    async replaySameIntent() {
      const before = await support.financeFacts(owner.entityId),
        beforeWallet = await call("m.wallet.get", headers);
      assert.equal(
        (await call("m.paymentOrder.create", headers, { key: key("order"), body: orderBody }))
          .paymentOrderId,
        order.paymentOrderId,
      );
      assert.equal(
        (
          await call("admin.paymentOrder.refundRequest.create", admin.headers, {
            key: key("refund"),
            params,
            body: refundBody,
          })
        ).refundRequestId,
        refund.refundRequestId,
      );
      await hook("hooks.wechatpay.transaction.notify", paidNotice);
      await hook("hooks.wechatpay.refund.notify", refundNotice);
      await support.drainEvents();
      const replayed = await support.financeFacts(owner.entityId);
      assert.equal(replayed.operations, before.operations);
      assert.equal(replayed.ledgerEntries, before.ledgerEntries);
      assert.deepEqual(replayed.payments, before.payments);
      assert.deepEqual(replayed.orders, before.orders);
      assert.deepEqual(await call("m.wallet.get", headers), beforeWallet);
      const actualRefund = await call("admin.refundRequest.get", lead.headers, {
        params: refundParams,
      });
      assert.equal(actualRefund.status, "done");
      assert.equal(actualRefund.amountFen, done.amountFen);
      assert.deepEqual(actualRefund.refundTxns, done.refundTxns);
      assert.equal(actualRefund.entitlementRevokedAt, done.entitlementRevokedAt);
    },
  });
  const billDate = calendarDate(support.clock.now()),
    paymentFact = after.payments.find((row) => row.billingOrderId === order.paymentOrderId),
    providerRefund = support.providers.wechatPay.refunds.get(refundTxn.outRefundNo);
  assert.ok(paymentFact?.channelTxnNo);
  assert.ok(providerRefund?.refundId);
  const financeReport = await runM4Finance({
    api,
    support,
    admin,
    finance,
    lead,
    owner,
    planId: plan.planId,
    say,
  });
  say("原90日账单下载窗口、精确实际支付退款与100分差异，重跑账不重复");
  const reconciliation = await runM4Reconciliation({
    api,
    support,
    finance: financeReport.finance,
    entityId: owner.entityId,
    billDate,
    payment: {
      outTradeNo: paymentFact.outTradeNo,
      transactionId: paymentFact.channelTxnNo,
      amountFen: quote.payFen,
    },
    refund: {
      outRefundNo: refundTxn.outRefundNo,
      refundId: providerRefund.refundId,
      amountFen: done.amountFen,
    },
  });
  const invariants = await support.fullInvariants();
  assert.equal(invariants.status, "succeeded");
  assert.equal(invariants.violationsFound, 0);
  assert.equal(invariants.errors.length, 0);
  assert.ok(invariants.checksRun > 0);
  return {
    runId: support.runId,
    paymentOrderNo: order.orderNo,
    refundRequestNo: done.requestNo,
    paidFen: quote.payFen,
    refundedFen: done.amountFen,
    finance: {
      paymentOrderId: financeReport.paymentOrderId,
      invoiceRequestId: financeReport.invoiceRequestId,
      linkedPaymentOrderId: financeReport.linkedPaymentOrderId,
      modes: financeReport.modes,
    },
    reconciliation,
    invariants: {
      status: invariants.status,
      checksRun: invariants.checksRun,
      violationsFound: invariants.violationsFound,
      errors: invariants.errors.length,
    },
  };
}
