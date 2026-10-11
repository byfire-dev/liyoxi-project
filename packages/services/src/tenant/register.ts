import {
  implementKeyed as notifyReaderImplementation,
  notifyReadPort as currentNotifyReadPort,
} from "../kernel/index.js";
import {
  merchantRecipientsForNotify,
  managerIdsForNotify,
  noticeRecipientsPageForNotify,
  memberStoresForNotify,
} from "./notify-facts.js";
// tenant 模块的登记（W1-03）：
//   端口     计费账户由 billing 实现；W2-10 PR1 的精准下载页授权吊销由 identity 实现。
//   状态机   entity、store、entity_member、invitation 六条链的随迁列、活动流默认描述与已实现守卫。
//   不变量   tenant.I1、I7、I17、I27、I28、I29；调度与落库由 ops（W0-24）。
// invitation.expire 由各运行时绑定；订阅者 tenant.onEntitlementChanged 仍待后续。
import { defineRegistration } from "../kernel/index.js";
import type { InvariantRegistration } from "../kernel/index.js";
import {
  findI1Violations,
  findI17Violations,
  findI28Violations,
  findI27Violations,
  findI29Violations,
  findI7Violations,
} from "./invariants.js";
import { machineImplementations } from "./machines.js";
import {
  billingAccountPort,
  billingHistoryPort,
  membershipAuthorizationsPort,
  entityAdCancelClosePort,
} from "./ports.js";
import { CLOSE_FACTS_PORTS } from "./close-facts.js";

const check = (
  code: string,
  run: NonNullable<InvariantRegistration["run"]>,
): InvariantRegistration => ({ code, severity: "P2", modes: ["full"], heal: "none", run });

export const registration = defineRegistration("tenant", {
  timerHandlers: [
    {
      kind: "invitation.expire",
      handle: async () => {
        throw new TypeError("邀请到期须由本实例运行时绑定");
      },
    },
  ],
  ports: [
    billingAccountPort,
    billingHistoryPort,
    membershipAuthorizationsPort,
    entityAdCancelClosePort,
    ...CLOSE_FACTS_PORTS,
  ],
  portImplementations: [
    notifyReaderImplementation(
      currentNotifyReadPort,
      "memberStoresForNotify",
      memberStoresForNotify,
    ),
    notifyReaderImplementation(
      currentNotifyReadPort,
      "merchantRecipientsForNotify",
      merchantRecipientsForNotify,
    ),
    notifyReaderImplementation(currentNotifyReadPort, "managerIdsForNotify", managerIdsForNotify),
    notifyReaderImplementation(
      currentNotifyReadPort,
      "noticeRecipientsPageForNotify",
      noticeRecipientsPageForNotify,
    ),
    ...machineImplementations(),
  ],
  invariants: [
    check("tenant.I1", (tx) => findI1Violations(tx)),
    check("tenant.I7", (tx) => findI7Violations(tx)),
    check("tenant.I27", (tx) => findI27Violations(tx)),
    check("tenant.I29", (tx) => findI29Violations(tx)),
    check("tenant.I17", (tx) => findI17Violations(tx)),
    check("tenant.I28", (tx) => findI28Violations(tx)),
  ],
});
