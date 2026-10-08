import { defineRegistration } from "../kernel/index.js";
import { runScheduledDedupPurge } from "./jobs.js";

// W2-18 PR1只落已有DML能力的去重任务；partitions/CLI等独立DB能力actualmain后由PR2接。
export const registration = defineRegistration("analytics", {
  recurringJobs: [
    {
      kind: "analytics.dedup_purge",
      schedule: { every: "day", at: "04:10" },
      mode: "job",
      leaseSec: 60,
      maxAttempts: 1,
      deadlineMin: 30,
      missSeverity: "P3",
      catchUp: true,
      run: runScheduledDedupPurge,
    },
  ],
});
