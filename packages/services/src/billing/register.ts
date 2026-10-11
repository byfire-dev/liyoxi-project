import { implement as implementTenantCloseFacts } from "../kernel/index.js";
import { billingCloseFactsPort, billingHistoryPort } from "../tenant/index.js";
import { deletionGuard } from "./read/deletion-guard.js";
import { readBillingHistoryFacts } from "./read/history-facts.js";
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
} from "./notify-facts.js";
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
import { approvalKindPort } from "../approval/index.js";
import { fileRefTypePort } from "../media/index.js";
import { financeConfigApproval, financeConfigAt } from "./finance-config/index.js";
import { paymentInvariants } from "./payment/invariants.js";
import { billingAccountPort } from "../tenant/index.js";
import { billingInvariants } from "./invariants.js";
import { billingAccountOpener, billingMerchantFacts } from "./ports.js";
import { subscriptionInvariants } from "./subscription/invariants.js";

import { DramaPricePort } from "../content/index.js";
import { dramaPriceAdapter } from "./pricing/drama-price-port.js";

export const registration = defineRegistration("billing", {
  portImplementations: [
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
    ...billingPiiFields,
    implementKeyed(approvalKindPort, "finance_config_change", financeConfigApproval),
    implementKeyed(fileRefTypePort, "transfer_proof", {
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
    ...purchaseMachineBindings.map(({ key, binding }) => implementKeyed(machinePort, key, binding)),
  ],
  subscribers: [
    {
      name: "billing.onTierChanged",
      events: ["drama.tier_changed"],
      handle: async () => {
        throw new TypeError("版权计价运行时尚未绑定");
      },
    },
  ],
  timerHandlers: [
    { kind: "po.transfer_ttl", handle: handleTransferTtl },
    {
      kind: "pricing.drama_price_effective",
      handle: async () => {
        throw new TypeError("版权计价运行时尚未绑定");
      },
    },
  ],
  invariants: [
    ...billingInvariants,
    ...subscriptionInvariants,
    ...paymentInvariants,
    ...purchaseInvariants,
  ],
});
