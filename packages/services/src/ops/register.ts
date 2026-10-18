// ops 模块的登记：W0-24原三周期任务、W2-24证书与备份，及违规上报端口。
// 依据：x01 第 4.2 节（节奏、模式、漏跑级别）；D7 第 7.6 节（完成期限）；15 分组 第 5.2、5.3 节。
//   invariant.full   每日 03:30，job，完成期限 3 小时，漏跑 P2；停机错过的那一期补跑。出错重试，至多 3 次。
//   invariant.quick  每 10 分钟，job，完成期限 30 分钟，漏跑 P2；出错不重试，下一期 10 分钟后就到。
//   ops.retention    每小时整点，tx，漏跑 P3；补最近一期（停机跨过 0 点、1 点前恢复时每日项还轮得到）。
// ops.cert_check与backup.pgdump由worker逐实例装配；探针同worker实例，发送通道继续随G2-D。
import { alertsPort, defineRegistration, implement, invariantsPort } from "../kernel/index.js";
import { unboundAlertFacts } from "./alert-facts.js";
import { reportingInvariants } from "./invariants/report.js";
import { runScheduledInvariants, runScheduledRetention } from "./jobs.js";
import { unboundCertJob } from "./cert-runtime.js";
import { unboundBackupJob } from "./backup-runtime.js";
import { profileAdminStaffFacts } from "./profile-admin-facts.js";

export const registration = defineRegistration("ops", {
  recurringJobs: [
    {
      kind: "backup.pgdump",
      schedule: { every: "day", at: "03:10" },
      mode: "job",
      leaseSec: 1800,
      maxAttempts: 3,
      deadlineMin: 180,
      missSeverity: "P1",
      catchUp: true,
      run: unboundBackupJob,
    },
    {
      kind: "ops.cert_check",
      schedule: { every: "day", at: "09:00" },
      mode: "job",
      leaseSec: 120,
      maxAttempts: 1,
      deadlineMin: 60,
      missSeverity: "P3",
      catchUp: true,
      run: unboundCertJob,
    },
    {
      kind: "invariant.full",
      schedule: { every: "day", at: "03:30" },
      mode: "job",
      leaseSec: 300,
      maxAttempts: 3,
      deadlineMin: 180,
      missSeverity: "P2",
      catchUp: true,
      run: (ctx) => runScheduledInvariants("full", ctx),
    },
    {
      kind: "invariant.quick",
      schedule: { every: "minutes", minutes: 10 },
      mode: "job",
      leaseSec: 120,
      maxAttempts: 1,
      deadlineMin: 30,
      missSeverity: "P2",
      run: (ctx) => runScheduledInvariants("quick", ctx),
    },
    {
      kind: "ops.retention",
      schedule: { every: "hour" },
      mode: "tx",
      missSeverity: "P3",
      catchUp: true,
      run: runScheduledRetention,
    },
  ],
  portImplementations: [
    profileAdminStaffFacts,
    implement(invariantsPort, reportingInvariants),
    implement(alertsPort, unboundAlertFacts),
  ],
});
