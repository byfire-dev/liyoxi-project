import { defineRegistration } from "../kernel/index.js";
import { boundSmsHealth } from "./sms-health.js";

export const registration = defineRegistration("notify", {
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
  ],
});
