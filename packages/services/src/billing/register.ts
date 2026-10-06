// billing 模块的登记（W1-10 起）：账本内核的九条不变量（billing.I1–I8、I16）。机制见 kernel/assembly/README.md。
// 循环 billing_advance 不是登记项：它是任务进程里的进程内循环，用例函数在 sweep.ts，由 ops 的 worker 装配接上。
// W1-11a（账本侧）：tenant 的计费账户端口与事实端口 billing 键的实现；订阅一侧的三条不变量（I9、I10、I12）。
// W1-11a（付款侧）：billing_order/payment_exception 状态链；payment.I1、I2、I4。
// 剧目积分价端口的实现由 W1-13 在这里加一行。
import {
  defineRegistration,
  implement,
  implementKeyed,
  implementMerchantFacts,
} from "../kernel/index.js";
import { machinePort } from "../flow/index.js";
import { paymentMachineBindings } from "./payment/machines.js";
import { paymentInvariants } from "./payment/invariants.js";
import { billingAccountPort } from "../tenant/index.js";
import { billingInvariants } from "./invariants.js";
import { billingAccountOpener, billingMerchantFacts } from "./ports.js";
import { subscriptionInvariants } from "./subscription/invariants.js";

import { DramaPricePort } from "../content/index.js";
import { dramaPriceAdapter } from "./pricing/drama-price-port.js";

export const registration = defineRegistration("billing", {
  portImplementations: [
    implement(DramaPricePort, dramaPriceAdapter),
    implement(billingAccountPort, billingAccountOpener),
    implementMerchantFacts("billing", billingMerchantFacts),
    ...paymentMachineBindings.map(({ key, binding }) => implementKeyed(machinePort, key, binding)),
  ],
  invariants: [...billingInvariants, ...subscriptionInvariants, ...paymentInvariants],
});
