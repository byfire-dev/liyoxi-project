// 后继资金片先独立固定源码；只从主链真实身份与主体继续，不另建共享夹具。
import assert from "node:assert/strict";
import { media } from "@liyoxi/services";
import type { M4Support } from "@liyoxi/services/testing";
import type { M1Api } from "./in-process.js";
import type { M1AuthenticatedStaff } from "./m1-auth.js";
import { loginM1Staff } from "./m1-auth.js";
import { m4Image } from "./m4-merchant.js";
import type { prepareM4Merchant } from "./m4-merchant.js";
import { createM1Caller } from "./runner-api.js";

export interface M4FinanceContext {
  readonly api: M1Api;
  readonly support: M4Support;
  readonly admin: M1AuthenticatedStaff;
  readonly finance: M1AuthenticatedStaff;
  readonly lead: M1AuthenticatedStaff;
  readonly owner: Awaited<ReturnType<typeof prepareM4Merchant>>;
  readonly planId: string;
  readonly say: (message: string) => void;
}
export async function runM4Finance(context: M4FinanceContext) {
  const { api, support, admin, finance, lead, owner, planId, say } = context;
  const call = createM1Caller(api),
    key = (name: string) => `m4-${support.runId}-${name}`;
  const adminFile = async (
    category: "invoice" | "pay_receipt",
    bytes: Uint8Array,
    fileName: string,
  ) => {
    const file = await call("admin.file.create", finance.headers, {
      body: {
        category,
        entityId: owner.entityId,
        fileName,
        sizeBytes: String(bytes.byteLength),
        clientToken: key(`${category}-file`),
      },
    });
    assert.ok(file?.post);
    assert.equal(
      await support.providers.storage.upload(
        { ...file.post, key: file.key, expiresAt: new Date(file.expiresAt) },
        bytes,
      ),
      204,
    );
    const complete = () =>
      call("admin.file.complete", finance.headers, { params: { fileId: file.fileId }, body: {} });
    if (support.completeWithPromote) await support.completeWithPromote(file.fileId, complete);
    else await complete();
    await support.promote(file.fileId);
    assert.equal(
      (await call("admin.file.get", finance.headers, { params: { fileId: file.fileId } })).status,
      "stored",
    );
    return file;
  };
  const currentConfig = () =>
    call("admin.financeConfigRevision.list", finance.headers, { query: { tab: "current" } });
  const controls = (await currentConfig()).items.find((row) => row.configKey === "controls");
  const reviewControls = await call("admin.financeConfigRevision.create", finance.headers, {
    key: key("review-controls"),
    body: {
      configKey: "controls",
      payload: {
        adminCreateOrder: true,
        wechatSingleLimitFen: 1_000_000,
        wechatDailyLimitFen: 5_000_000,
        receiptSecondReviewFen: 1,
        shippingReport: false,
      },
      changeNote: "M4二人收款复核",
      confirm: { configKey: "controls", baseRevisionId: controls?.financeConfigRevisionId ?? null },
    },
  });
  await call("admin.financeConfigRevision.approve", lead.headers, {
    key: key("review-controls-approve"),
    params: { financeConfigRevisionId: reviewControls.financeConfigRevisionId },
    body: {
      lockVersion: reviewControls.approval.lockVersion,
      confirmChecks: ["change_reviewed"],
      confirm: {
        configKey: "controls",
        financeConfigRevisionId: reviewControls.financeConfigRevisionId,
      },
    },
  });
  say("后台真实线下开单、凭证入库、财务确认及另人复核后才入账");
  const before = await call("m.wallet.get", owner.headers);
  const quote = await call("m.plan.quote", owner.headers, { body: { planId, months: 1 } });
  const state = await support.readState(owner);
  assert.ok(state.entity.name);
  assert.notEqual(admin.staffId, finance.staffId);
  assert.notEqual(admin.staffId, lead.staffId);
  const order = await call("admin.paymentOrder.create", admin.headers, {
    key: key("bank-order"),
    body: {
      entityId: owner.entityId,
      storeId: owner.storeId,
      kind: "plan",
      planId,
      months: 1,
      expectAmountFen: quote.payFen,
      contractNo: `M4-${support.runId}`,
      confirm: { entityName: state.entity.name, amountFen: quote.payFen },
    },
  });
  const proof = await call("admin.paymentOrder.transferProof.create", finance.headers, {
    key: key("bank-proof"),
    params: { paymentOrderId: order.paymentOrderId },
    body: {
      fileId: (await adminFile("pay_receipt", m4Image, "m4-bank-receipt.png")).fileId,
      note: "M4虚构对公凭证",
    },
  });
  const checked = await call("admin.transferProof.confirm", finance.headers, {
    key: key("bank-confirm"),
    params: { transferProofId: proof.transferProofId },
    body: {
      lockVersion: proof.lockVersion,
      bankSerialNo: `M4BANK-${support.runId}`,
      confirmChecks: ["bank_statement_checked"],
      confirm: { orderNo: order.orderNo, receivedAmountFen: quote.payFen },
    },
  });
  assert.equal(checked.outcome, "review_pending");
  assert.equal(
    (await call("m.wallet.get", owner.headers)).points.spendablePoints,
    before.points.spendablePoints,
  );
  assert.ok(checked.review);
  const reviewBody = {
    approvalId: checked.review.approvalId,
    lockVersion: checked.review.lockVersion,
    confirm: { orderNo: order.orderNo, receivedAmountFen: quote.payFen },
    confirmChecks: ["bank_statement_checked"],
  };
  await assert.rejects(
    call("admin.transferProof.approveReview", finance.headers, {
      key: key("bank-self"),
      params: { transferProofId: proof.transferProofId },
      body: reviewBody,
    }),
    /HTTP 403, APPROVAL_SELF_FORBIDDEN/,
  );
  const paid = await call("admin.transferProof.approveReview", lead.headers, {
    key: key("bank-approve"),
    params: { transferProofId: proof.transferProofId },
    body: reviewBody,
  });
  assert.equal(paid.outcome, "paid");
  await support.drainEvents();
  const actual = await call("admin.paymentOrder.get", finance.headers, {
    params: { paymentOrderId: order.paymentOrderId },
  });
  assert.equal(actual.status, "paid");
  assert.equal(actual.fulfillmentStatus, "done");
  assert.equal(actual.paymentTxns.filter((row) => row.isApplied).length, 1);
  const afterPay = await support.financeFacts(owner.entityId);
  assert.deepEqual(
    await call("admin.transferProof.approveReview", lead.headers, {
      key: key("bank-approve"),
      params: { transferProofId: proof.transferProofId },
      body: reviewBody,
    }),
    paid,
  );
  assert.equal((await support.financeFacts(owner.entityId)).operations, afterPay.operations);

  say("实际商家申请发票、后台真实PDF上传开具并GET读回");
  // 开票项目默认未配置；只经正式参数接口为实际单据类型准备本轮演示值。
  assert.ok(["plan_new", "plan_renew"].includes(actual.type));
  const itemKey = `invoice.item_name.${actual.type}`,
    item = (
      await call("admin.paramValue.list", admin.headers, { query: { keys: itemKey } })
    ).items.find((row) => row.key === itemKey);
  assert.ok(item);
  const invoiceItemName = "M4虚构订阅服务";
  const configured = await call("admin.paramValue.replace", admin.headers, {
    key: key("invoice-item-name"),
    body: {
      items: [{ key: itemKey, value: invoiceItemName, expectedRev: item.latestRev }],
      reason: "M4隔离开票项目准备",
    },
  });
  assert.equal(configured.items.find((row) => row.key === itemKey)?.value, invoiceItemName);
  const invoice = await call("m.invoiceRequest.create", owner.headers, {
    key: key("invoice"),
    body: {
      paymentOrderId: order.paymentOrderId,
      invoiceType: "normal",
      medium: "electronic",
      recvEmail: "m4-fixture@example.invalid",
    },
  });
  const invoiceView = await call("admin.invoiceRequest.get", finance.headers, {
    params: { invoiceRequestId: invoice.invoiceRequestId },
  });
  assert.equal(invoiceView.itemName, invoiceItemName);
  const file = await adminFile(
    "invoice",
    media.placeholderPdf("M4-FICTIONAL-INVOICE"),
    "m4-fictional.pdf",
  );
  const issued = await call("admin.invoiceRequest.issue", finance.headers, {
    key: key("invoice-issue"),
    params: { invoiceRequestId: invoice.invoiceRequestId },
    body: {
      invoiceNo: "20400000000000004190",
      fileId: file.fileId,
      confirm: { requestNo: invoiceView.requestNo, amountFen: invoiceView.amountFen },
    },
  });
  assert.equal(issued.status, "issued");
  const invoiceRead = await call("admin.invoiceRequest.get", finance.headers, {
    params: { invoiceRequestId: invoice.invoiceRequestId },
  });
  assert.equal(invoiceRead.invoiceRequestId, invoice.invoiceRequestId);
  assert.equal(invoiceRead.status, "issued");
  assert.ok(invoiceRead.docs.some((row) => row.fileId === file.fileId));

  say("实际异常到账形成差异，读取候选后关联第三笔续费单，原键重放不重复入账");
  const renewalQuote = await call("m.plan.quote", owner.headers, { body: { planId, months: 1 } });
  assert.equal(renewalQuote.action, "renew");
  const renewal = await call("admin.paymentOrder.create", finance.headers, {
    key: key("linked-order"),
    body: {
      entityId: owner.entityId,
      storeId: owner.storeId,
      kind: "plan",
      planId,
      months: 1,
      expectAmountFen: renewalQuote.payFen,
      contractNo: `M4-LINK-${support.runId}`,
      confirm: { entityName: state.entity.name, amountFen: renewalQuote.payFen },
    },
  });
  const serial = `M4UNMATCHED-${support.runId}`;
  const difference = await call("admin.paymentException.create", finance.headers, {
    key: key("difference"),
    body: {
      receivedAt: support.clock.now().toISOString(),
      amountFen: renewalQuote.payFen,
      payerName: "M4虚构付款人",
      bankSerialNo: serial,
      note: "M4真实公口登记异常到账",
      confirm: { amountFen: renewalQuote.payFen, bankSerialNo: serial },
    },
  });
  assert.equal(difference.kind, "bank_unmatched");
  assert.equal(difference.status, "open");
  const open = await call("admin.paymentException.list", finance.headers, {
    query: { tab: "open", kind: "bank_unmatched" },
  });
  assert.ok(open.items.some((row) => row.paymentExceptionId === difference.paymentExceptionId));
  const detail = await call("admin.paymentException.get", finance.headers, {
    params: { paymentExceptionId: difference.paymentExceptionId },
  });
  assert.ok(detail.linkCandidates.some((row) => row.paymentOrderId === renewal.paymentOrderId));
  const resolution = {
    lockVersion: detail.lockVersion,
    resolution: "link_order" as const,
    note: "已核对虚构单号与实际金额",
    linkPaymentOrderId: renewal.paymentOrderId,
    confirm: { exceptionNo: detail.exceptionNo, amountFen: detail.amountFen },
  };
  const resolved = await call("admin.paymentException.resolve", finance.headers, {
    key: key("difference-link"),
    params: { paymentExceptionId: detail.paymentExceptionId },
    body: resolution,
  });
  assert.equal(resolved.outcome, "resolved");
  assert.equal(resolved.status, "resolved");
  const linked = await call("admin.paymentOrder.get", finance.headers, {
    params: { paymentOrderId: renewal.paymentOrderId },
  });
  assert.equal(linked.status, "paid");
  assert.equal(linked.fulfillmentStatus, "done");
  assert.equal(linked.paymentTxns.filter((row) => row.isApplied).length, 1);
  const afterLink = await support.financeFacts(owner.entityId);
  assert.deepEqual(
    await call("admin.paymentException.resolve", finance.headers, {
      key: key("difference-link"),
      params: { paymentExceptionId: detail.paymentExceptionId },
      body: resolution,
    }),
    resolved,
  );
  const linkReplay = await support.financeFacts(owner.entityId);
  assert.equal(linkReplay.operations, afterLink.operations);
  assert.equal(linkReplay.ledgerEntries, afterLink.ledgerEntries);
  assert.deepEqual(
    linkReplay.payments.map((row) => row.id),
    afterLink.payments.map((row) => row.id),
  );

  say("三种购买入口使用真实受控配置，隐藏/线下/应用内与禁用渠道各自读回");
  const modes = [];
  for (const [mode, wechat] of [
    ["hidden", "off"],
    ["offline_contract", "off"],
    ["in_app", "off"],
    ["in_app", "on"],
  ] as const) {
    const prior = (await currentConfig()).items.find((row) => row.configKey === "purchase_policy");
    const revision = await call("admin.financeConfigRevision.create", finance.headers, {
      key: key(`policy-${mode}-${wechat}`),
      body: {
        configKey: "purchase_policy",
        payload: {
          rules: [
            {
              when: {},
              then: {
                mode,
                channels: {
                  wechat_jsapi: wechat,
                  bank_transfer: mode === "hidden" ? "off" : "on",
                },
              },
            },
          ],
        },
        changeNote: `M4演示${mode}入口`,
        confirm: {
          configKey: "purchase_policy",
          baseRevisionId: prior?.financeConfigRevisionId ?? null,
        },
      },
    });
    await call("admin.financeConfigRevision.approve", lead.headers, {
      key: key(`policy-${mode}-${wechat}-approve`),
      params: { financeConfigRevisionId: revision.financeConfigRevisionId },
      body: {
        lockVersion: revision.approval.lockVersion,
        confirmChecks: ["change_reviewed"],
        confirm: {
          configKey: "purchase_policy",
          financeConfigRevisionId: revision.financeConfigRevisionId,
        },
      },
    });
    const policy = await call("m.purchasePolicy.get", owner.headers);
    assert.equal(policy.mode, mode);
    if (mode === "in_app") {
      assert.equal(policy.isPriceShown, true);
      assert.equal(policy.isPurchasePromptAllowed, true);
      assert.equal(
        policy.channels.find((row) => row.code === "wechat_jsapi")?.isEnabled,
        wechat === "on",
      );
    } else {
      assert.equal(policy.isPriceShown, false);
      assert.equal(policy.isPurchasePromptAllowed, false);
      assert.deepEqual(policy.channels, []);
    }
    modes.push(policy.mode);
  }

  say("银行配置异人批准后严格24h边界：此前旧值，到时新值，账号只脱敏读回");
  const bank = (await currentConfig()).items.find((row) => row.configKey === "bank_account");
  assert.ok(bank);
  const proposedBank = await call("admin.financeConfigRevision.create", finance.headers, {
    key: key("bank-config"),
    body: {
      configKey: "bank_account",
      payload: {
        accountName: "M4虚构账户",
        bankName: "M4虚构银行",
        accountNo: "6222020000000004190",
      },
      changeNote: "M4严格24小时隔离验收",
      confirm: { configKey: "bank_account", baseRevisionId: bank.financeConfigRevisionId },
    },
  });
  const bankDecision = {
    lockVersion: proposedBank.approval.lockVersion,
    confirmChecks: ["change_reviewed"],
    confirm: {
      configKey: "bank_account" as const,
      financeConfigRevisionId: proposedBank.financeConfigRevisionId,
      accountNoLast4: "4190",
    },
  };
  await assert.rejects(
    call("admin.financeConfigRevision.approve", finance.headers, {
      key: key("bank-config-self"),
      params: { financeConfigRevisionId: proposedBank.financeConfigRevisionId },
      body: bankDecision,
    }),
    /HTTP 403, APPROVAL_SELF_FORBIDDEN/,
  );
  const approvedBank = await call("admin.financeConfigRevision.approve", lead.headers, {
    key: key("bank-config-approve"),
    params: { financeConfigRevisionId: proposedBank.financeConfigRevisionId },
    body: bankDecision,
  });
  assert.equal(approvedBank.state, "scheduled");
  assert.ok(approvedBank.effectiveAt && approvedBank.approval.decidedAt);
  assert.equal(
    new Date(approvedBank.effectiveAt).getTime() -
      new Date(approvedBank.approval.decidedAt).getTime(),
    24 * 3_600_000,
  );
  assert.equal(
    (await currentConfig()).items.find((row) => row.configKey === "bank_account")
      ?.financeConfigRevisionId,
    bank.financeConfigRevisionId,
  );
  // 跨日之前让本轮已到期队列经原执行器完成，不让拨钟制造后台停摆。
  await support.drainBackground();
  const effectiveAt = new Date(approvedBank.effectiveAt).getTime();
  support.clock.advance(effectiveAt - support.clock.now().getTime() - 60_000);
  const actorApi: M1Api = {
    ...api,
    request: (path, init) => api.request(path, { ...init, peer: "198.19.4.7" }),
  };
  const freshFinance = await loginM1Staff(actorApi, finance);
  support.clock.advance(effectiveAt - support.clock.now().getTime() - 1);
  const beforeBoundary = await call("admin.financeConfigRevision.list", freshFinance.headers, {
    query: { tab: "current" },
  });
  assert.equal(
    beforeBoundary.items.find((row) => row.configKey === "bank_account")?.financeConfigRevisionId,
    bank.financeConfigRevisionId,
  );
  support.clock.advance(1);
  const effective = await call("admin.financeConfigRevision.list", freshFinance.headers, {
    query: { tab: "current" },
  });
  const newBank = effective.items.find((row) => row.configKey === "bank_account");
  assert.equal(newBank?.financeConfigRevisionId, approvedBank.financeConfigRevisionId);
  assert.equal(newBank?.state, "effective");
  assert.ok(!JSON.stringify(effective).includes("6222020000000004190"));
  return {
    paymentOrderId: order.paymentOrderId,
    invoiceRequestId: invoice.invoiceRequestId,
    linkedPaymentOrderId: renewal.paymentOrderId,
    modes,
    finance: freshFinance,
  };
}
