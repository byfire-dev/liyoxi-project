import { defineRegistration } from "../kernel/index.js";
import { runScheduledDedupPurge, runScheduledPartitions } from "./jobs.js";

// 受限DB能力均已实际main；两个job闭包由本次runtime装配绑定。
export const registration = defineRegistration("analytics", {
  recurringJobs: [
    {
      kind: "analytics.partitions",
      schedule: { every: "month", day: 20, at: "00:00" },
      mode: "job",
      leaseSec: 60,
      maxAttempts: 1,
      deadlineMin: 1_440,
      missSeverity: "P2",
      catchUp: true,
      run: runScheduledPartitions,
    },
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
