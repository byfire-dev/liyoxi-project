// approval 模块的登记（W1-06）：声明按键端口 approval.kind；登记审批单状态机的守卫、处理器的挂点与随迁列；
// 三项每日校验 approval.I1、I2、I4（调度与落库在 ops 的 invariant.full）。
// 真实的审批类型由各域在自己的 register.ts 里实现 approvalKindPort：qualification 归 profile，
// channel_account、launch_link 归 publish，其余随各自的里程碑。决定时限（sla.breach、approval.I3、I5）在 M2。
import { machinePort } from "../flow/index.js";
import { defineRegistration, implementKeyed } from "../kernel/index.js";

import { findI1Violations, findI2Violations, findI4Violations } from "./invariants.js";
import { approvalKindPort } from "./kinds.js";
import { APPROVAL_CHAIN, approvalBinding } from "./machine.js";

export const registration = defineRegistration("approval", {
  ports: [approvalKindPort],
  portImplementations: [implementKeyed(machinePort, APPROVAL_CHAIN, approvalBinding)],
  invariants: [
    {
      code: "approval.I1",
      severity: "P2",
      modes: ["full"],
      heal: "none",
      run: (tx) => findI1Violations(tx),
    },
    {
      code: "approval.I2",
      severity: "P2",
      modes: ["full"],
      heal: "none",
      run: (tx) => findI2Violations(tx),
    },
    {
      code: "approval.I4",
      severity: "P2",
      modes: ["full"],
      heal: "none",
      run: (tx) => findI4Violations(tx),
    },
  ],
});
