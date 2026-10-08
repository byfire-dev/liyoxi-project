import { defineRegistration, implementMerchantFacts, invariantNow } from "../kernel/index.js";
import { boundSmsHealth } from "./sms-health.js";
import { countUnread } from "./messages.scope.js";

import { boundNotifyDispatcher } from "./service.js";
import { EVENT_SCENES } from "./registry.js";
import {
  findNotifyN1Violations,
  findNotifyN2Violations,
  findNotifyN3Violations,
  findNotifyN15Violations,
} from "./invariants.js";
import { boundNotifyAssembly } from "./service.js";
export const registration = defineRegistration("notify", {
  subscribers: [
    {
      name: "notify.onEvent",
      events: Object.keys(EVENT_SCENES),
      handle: async (tx, event) => {
        await boundNotifyDispatcher().onEvent(tx, event);
      },
    },
    {
      name: "notify.onMerchantUserDeleted",
      events: ["merchant_user.deleted"],
      handle: async (tx, event) => {
        await boundNotifyDispatcher().onMerchantUserDeleted(tx, event);
      },
    },
  ],
  recurringJobs: [
    {
      kind: "notify.sms_keepalive",
      schedule: { every: "day", at: "10:20" },
      mode: "job",
      leaseSec: 120,
      maxAttempts: 1,
      deadlineMin: 60,
      missSeverity: "P3",
      catchUp: true,
      run: (ctx) => boundSmsHealth().keepalive(ctx),
    },
    {
      kind: "notify.sms_balance",
      schedule: { every: "day", at: "10:20" },
      mode: "job",
      leaseSec: 120,
      maxAttempts: 1,
      deadlineMin: 60,
      missSeverity: "P3",
      catchUp: true,
      run: (ctx) => boundSmsHealth().balance(ctx),
    },
    {
      kind: "notify.remind_scan",
      schedule: { every: "minutes", minutes: 5 },
      mode: "job",
      leaseSec: 120,
      maxAttempts: 3,
      deadlineMin: 5,
      missSeverity: "P2",
      catchUp: true,
      run: (ctx) => boundNotifyDispatcher().remindScan(ctx),
    },
  ],
  invariants: [
    {
      code: "notify.N1",
      severity: "P2",
      modes: ["full"],
      heal: "none",
      run: (tx) => findNotifyN1Violations(tx),
    },
    {
      code: "notify.N2",
      severity: "P2",
      modes: ["quick", "full"],
      heal: "none",
      run: (tx, _scope, ctx) => findNotifyN2Violations(tx, { now: invariantNow(ctx) }),
    },
    {
      code: "notify.N3",
      severity: "P2",
      modes: ["full"],
      heal: "none",
      run: (tx) => findNotifyN3Violations(tx),
    },
    {
      code: "notify.N15",
      severity: "P2",
      modes: ["full"],
      heal: "none",
      run: (tx) => findNotifyN15Violations(tx, boundNotifyAssembly()),
    },
  ],
  portImplementations: [
    implementMerchantFacts("notify", async (tx, query) => ({
      unreadMessageCount:
        query.merchantUserId === null
          ? 0
          : await countUnread(tx, {
              merchantUserId: query.merchantUserId,
              entityId: query.entityId,
              storeIds: query.storeIds,
              now: query.now,
            }),
    })),
  ],
});
