import { refundInvariants } from "./refund/invariants.js";
import { reconciliationInvariants } from "./reconciliation/invariants.js";
import { withReconciliationBinding } from "./reconciliation/binding.js";
import { billFileRefs } from "./reconciliation/file-refs.js";
import { unboundReconciliationJob } from "./reconciliation/assembly.js";
import { withPaymentExceptionBinding } from "./payment/exceptions/binding.js";
import { refundFileRefs } from "./refund/file-refs.js";
import { refundMachineBinding, refundMachineKey, withRefundBinding } from "./refund/binding.js";
import { unboundRefundApproval, unboundRefundHandler } from "./refund/assembly.js";
import { invoiceMachineBinding, invoiceMachineKey } from "./invoices/binding.js";
import { unboundInvoiceMailResult } from "./invoices/assembly.js";
import {
  applyPaymentFallback,
  expirePayment,
  scanUnapplied,
} from "./payment/channel-registration.js";
import { implement as implementTenantCloseFacts } from "../kernel/index.js";
import { billingCloseFactsPort, billingHistoryPort } from "../tenant/index.js";
import { deletionGuard } from "./read/deletion-guard.js";
import { readBillingHistoryFacts } from "./read/history-facts.js";
import { implementAdminProfileFacts, adminStoreListBillingPort } from "../profile/index.js";
import { implement as implementStoreList } from "../kernel/index.js";
import { readProfileStoreListBilling } from "./read/profile-list.js";
import { readProfileAdminBillingFacts } from "./read/profile-admin.js";
import { staffFollowUpPort } from "../kernel/index.js";
import {
  implementKeyed as notifyReaderImplementation,
  notifyReadPort as currentNotifyReadPort,
} from "../kernel/index.js";
import {
  billingOrderForNotify,
  termForNotify,
  billingAccountForNotify,
  billingConsentFacts,
  transferForNotify,
  paymentExceptionForNotify,
  renewalForNotify,
  invoiceRequestForNotify,
  invoiceDocForNotify,
  invoiceParentForNotify,
  financeConfigForNotify,
} from "./notify-facts.js";
import { remindersPort } from "../kernel/index.js";
import { listTermsDueForReminder, revalidateRenewal } from "./subscription/reminders.js";
import { getPurchasePolicy } from "@liyoxi/shared/purchase-policy";
import { readSubscribePlan } from "../notify/index.js";
import { billingPiiFields } from "./pii-fields.js";
// billing 模块的登记（W1-10 起）：账本内核的九条不变量（billing.I1–I8、I16）。机制见 kernel/assembly/README.md。
// 循环 billing_advance 不是登记项：它是任务进程里的进程内循环，用例函数在 sweep.ts，由 ops 的 worker 装配接上。
// W1-11a（账本侧）：tenant 的计费账户端口与事实端口 billing 键的实现；订阅一侧的三条不变量（I9、I10、I12）。
// W1-11a（付款侧）：billing_order/payment_exception 状态链；payment.I1、I2、I4。
// 剧目积分价端口的实现由 W1-13 在这里加一行。
import {
  subscribePlanPort,
  defineRegistration,
  implement,
  implementKeyed,
  implementMerchantFacts,
} from "../kernel/index.js";
import { machinePort } from "../flow/index.js";
import {
  purchaseMachineBindings,
  purchaseInvariants,
  handleTransferTtl,
} from "./payment/purchase-registration.js";
import { unboundTransferConfirm } from "./payment/transfer-review.js";
import { approvalKindPort } from "../approval/index.js";
import { fileRefTypePort } from "../media/index.js";
import { financeConfigApproval, financeConfigAt } from "./finance-config/index.js";
import { paymentInvariants } from "./payment/invariants.js";
import { billingAccountPort } from "../tenant/index.js";
import { billingInvariants } from "./invariants.js";
import { billingAccountOpener, billingMerchantFacts } from "./ports.js";
import { subscriptionInvariants } from "./subscription/invariants.js";
import { unboundSubscriptionDaily } from "./sweep.js";
import { unboundAdjustmentKinds } from "./adjustments/kinds.js";
import { adjustmentInvariants } from "./adjustments/invariants.js";

import { DramaPricePort } from "../content/index.js";
import { dramaPriceAdapter } from "./pricing/drama-price-port.js";

export const registration = defineRegistration("billing", {
  portImplementations: [
    implementKeyed(fileRefTypePort, "wx_bill_file", billFileRefs),
    implementKeyed(approvalKindPort, "points_adjust", unboundAdjustmentKinds.points),
    implementKeyed(approvalKindPort, "subscription_extend", unboundAdjustmentKinds.extension),
    implementKeyed(remindersPort, "R1", {
      targets: listTermsDueForReminder,
      revalidate: revalidateRenewal,
    }),
    notifyReaderImplementation(currentNotifyReadPort, "renewalForNotify", renewalForNotify),
    implementAdminProfileFacts("billing", readProfileAdminBillingFacts),
    implementStoreList(adminStoreListBillingPort, readProfileStoreListBilling),
    implementTenantCloseFacts(billingCloseFactsPort, { deletionGuard }),
    implement(billingHistoryPort, { read: readBillingHistoryFacts }),
    implementKeyed(staffFollowUpPort, "subscription_term", async (tx, id) => {
      const row = await tx.subscriptionTerm.findUnique({
        where: { id },
        select: { entityId: true },
      });
      return row === null ? null : { entityId: row.entityId, storeId: null };
    }),
    notifyReaderImplementation(
      currentNotifyReadPort,
      "manualSubjectExists.subscription_term",
      async (tx, id: string) =>
        (await tx.subscriptionTerm.findUnique({ where: { id }, select: { id: true } })) !== null,
    ),
    notifyReaderImplementation(currentNotifyReadPort, "billingConsentFacts", billingConsentFacts),
    notifyReaderImplementation(
      currentNotifyReadPort,
      "billingOrderForNotify",
      billingOrderForNotify,
    ),
    notifyReaderImplementation(currentNotifyReadPort, "termForNotify", termForNotify),
    notifyReaderImplementation(
      currentNotifyReadPort,
      "billingAccountForNotify",
      billingAccountForNotify,
    ),
    notifyReaderImplementation(currentNotifyReadPort, "transferForNotify", transferForNotify),
    notifyReaderImplementation(
      currentNotifyReadPort,
      "paymentExceptionForNotify",
      paymentExceptionForNotify,
    ),

    implement(subscribePlanPort, async (tx, query) => {
      const current = await financeConfigAt(tx, query.now);
      const policy = getPurchasePolicy(
        {
          platform: query.platform,
          ...(query.clientVersion === undefined ? {} : { appVersion: query.clientVersion }),
          entityId: query.entityId ?? "",
          providers: { wechatPayConfigured: false },
          bankAccountConfigured: false,
          bankMinFen: 0,
        },
        current.rules,
        current.controls,
      );
      return readSubscribePlan(tx, { purchaseMode: policy.mode });
    }),
    notifyReaderImplementation(
      currentNotifyReadPort,
      "invoiceRequestForNotify",
      invoiceRequestForNotify,
    ),
    notifyReaderImplementation(currentNotifyReadPort, "invoiceDocForNotify", invoiceDocForNotify),
    notifyReaderImplementation(
      currentNotifyReadPort,
      "invoiceParentForNotify",
      invoiceParentForNotify,
    ),
    notifyReaderImplementation(
      currentNotifyReadPort,
      "financeConfigForNotify",
      financeConfigForNotify,
    ),
    implementKeyed(machinePort, refundMachineKey, refundMachineBinding),
    implementKeyed(approvalKindPort, "plan_refund", unboundRefundApproval),
    implementKeyed(fileRefTypePort, "refund_txn", refundFileRefs),
    implementKeyed(machinePort, invoiceMachineKey, invoiceMachineBinding),
    implementKeyed(fileRefTypePort, "invoice_doc", {
      inUse: async (tx, fileId) =>
        (await tx.invoiceDoc.findMany({ where: { fileId }, select: { id: true } })).map((d) => ({
          fileId,
          refId: d.id,
          role: "main",
        })),
      roles: { main: { categories: ["invoice"], retentionDays: null } },
      readColumns: async (tx) =>
        (
          await tx.invoiceDoc.findMany({
            where: { fileId: { not: null } },
            select: { id: true, fileId: true },
          })
        ).map((d) => ({ fileId: d.fileId!, refId: d.id, role: "main" })),
    }),
    ...billingPiiFields,
    implementKeyed(approvalKindPort, "finance_config_change", financeConfigApproval),
    implementKeyed(approvalKindPort, "transfer_confirm", unboundTransferConfirm),
    implementKeyed(fileRefTypePort, "transfer_proof", {
      // 法定付款证明沿既有永久保留规则，不以交易终结为释放依据。
      inUse: async (tx, fileId) =>
        (
          await tx.transferProof.findMany({
            where: { fileId },
            select: { id: true },
          })
        ).map((row) => ({ fileId, refId: row.id, role: "main" })),
      roles: { main: { categories: ["pay_receipt"], retentionDays: null } },
      readColumns: async (tx) =>
        (await tx.transferProof.findMany({ select: { id: true, fileId: true } })).map((p) => ({
          fileId: p.fileId,
          refId: p.id,
          role: "main",
        })),
    }),
    implement(DramaPricePort, dramaPriceAdapter),
    implement(billingAccountPort, billingAccountOpener),
    implementMerchantFacts("billing", billingMerchantFacts),
    ...purchaseMachineBindings.map(({ key, binding }) =>
      implementKeyed(
        machinePort,
        key,
        withReconciliationBinding(
          key,
          withPaymentExceptionBinding(key, withRefundBinding(key, binding)),
        ),
      ),
    ),
  ],
  subscribers: [
    {
      name: "billing.submitRefundTxn",
      events: ["refund_txn.created"],
      handle: unboundRefundHandler,
    },
    {
      name: "billing.onMailResult",
      events: ["notify.mail_delivered", "notify.mail_failed"],
      handle: unboundInvoiceMailResult,
    },
    {
      name: "billing.onOcrCompleted",
      events: ["media.ocr.completed"],
      handle: async () => {
        throw new TypeError("回单OCR消费运行时尚未绑定");
      },
    },
    {
      name: "billing.onCalendarImported",
      events: ["calendar.imported"],
      handle: async () => {
        throw new TypeError("对公凭证日历运行时尚未绑定");
      },
    },
    {
      name: "billing.applyPaymentFallback",
      events: ["payment_txn.succeeded"],
      handle: applyPaymentFallback,
    },
    {
      name: "billing.onTierChanged",
      events: ["drama.tier_changed"],
      handle: async () => {
        throw new TypeError("版权计价运行时尚未绑定");
      },
    },
  ],
  recurringJobs: [
    {
      kind: "bill.download",
      schedule: { every: "minutes", minutes: 30 },
      mode: "job",
      leaseSec: 300,
      maxAttempts: 3,
      deadlineMin: 30,
      missSeverity: "P1",
      catchUp: true,
      run: unboundReconciliationJob,
    },
    {
      kind: "receipt.daily_digest",
      schedule: { every: "day", at: "18:00" },
      mode: "job",
      leaseSec: 300,
      maxAttempts: 3,
      deadlineMin: 60,
      missSeverity: "P3",
      catchUp: true,
      run: unboundReconciliationJob,
    },
    {
      kind: "billing.sweep.daily",
      schedule: { every: "day", at: "00:00" },
      mode: "job",
      leaseSec: 300,
      maxAttempts: 3,
      deadlineMin: 60,
      missSeverity: "P1",
      catchUp: true,
      run: unboundSubscriptionDaily,
    },
    {
      kind: "tx.unapplied_scan",
      run: scanUnapplied,
      schedule: { every: "minutes", minutes: 5 },
      mode: "job",
      leaseSec: 120,
      maxAttempts: 5,
      deadlineMin: 10,
      missSeverity: "P2",
      catchUp: true,
    },
  ],
  timerHandlers: [
    { kind: "rf.poll", handle: unboundRefundHandler },
    { kind: "po.expire", critical: true, handle: expirePayment },
    { kind: "po.transfer_ttl", handle: handleTransferTtl },
    {
      kind: "pricing.drama_price_effective",
      handle: async () => {
        throw new TypeError("版权计价运行时尚未绑定");
      },
    },
  ],
  invariants: [
    ...reconciliationInvariants,
    ...refundInvariants,
    ...billingInvariants,
    ...adjustmentInvariants,
    ...subscriptionInvariants,
    ...paymentInvariants,
    ...purchaseInvariants,
  ],
});
