import { boundN5Violations } from "./transaction-invariant.js";
import { docsPiiFields } from "./pii-fields.js";
// docs 模块的登记（W1-03）：两条不变量。调度与落库由 ops（W0-24）。
// 协议任务随 M2；M5 授权当前事实由 ops 的实例 scope 注入，静态登记缺依赖须明确失败。
import { defineRegistration, fileRefTypePort, implementKeyed } from "../kernel/index.js";
import { findN13Violations, findN4Violations } from "./invariants.js";
import { chainKey, machinePort, rowKey } from "../flow/index.js";
import type { Guard } from "../flow/index.js";
import { isLicenseFactsChecked } from "./license-convergence.js";

const unboundJob = async (): Promise<never> => {
  throw new TypeError("文书周期任务缺少当前运行时依赖");
};
const unboundLicense = async (): Promise<never> => {
  throw new TypeError("授权事实缺少当前运行时依赖");
};
export const registration = defineRegistration("docs", {
  subscribers: [
    { name: "docs.onRevisionQueued", events: ["license_letter.revision_queued"], handle: unboundLicense },
    {
      name: "docs.onLicenseFacts",
      critical: true,
      events: [
        "order.started",
        "order.item.cancelled",
        "order.item.refunded",
        "order.item.terminated",
        "order.item.went_live",
        "order.item.live_revoked",
        "order.item.usage_end_changed",
        "ticket.held",
        "ticket.resumed",
        "ticket.terminated",
        "ticket.archived",
        "plan.confirmed",
      ],
      handle: unboundLicense,
    },
  ],
  recurringJobs: [
    {
      kind: "docs.sweep",
      schedule: { every: "minutes", minutes: 5 },
      mode: "job",
      leaseSec: 240,
      maxAttempts: 3,
      deadlineMin: 5,
      missSeverity: "P2",
      run: unboundJob,
    },
    {
      kind: "evidence.consent_digest",
      schedule: { every: "day", at: "00:40" },
      mode: "job",
      leaseSec: 600,
      maxAttempts: 3,
      deadlineMin: 60,
      missSeverity: "P2",
      run: unboundJob,
    },
  ],
  portImplementations: [
    implementKeyed(machinePort, chainKey("license_letter", "status"), {
      companions: ["period_start", "period_end", "voided_at", "void_reason"],
      guards: Object.fromEntries(
        [
          ["13:942", "license_letter.create"],
          ["13:944", "license_letter.go_live"],
          ["13:946", "license_letter.revoke_live"],
          ["13:947", "license_letter.void"],
          ["13:948", "license_letter.void"],
          ["13:949", "license_letter.void"],
        ].map(([ref, event]) => [
          rowKey(ref!, event!),
          (async (_tx, facts) => isLicenseFactsChecked(facts.args)) satisfies Guard,
        ]),
      ),
      activity: () => ({
        category: "docs",
        action: "docs.license.reconcile",
        summary: "对齐当前授权事实",
      }),
    }),
    docsPiiFields,
    implementKeyed(fileRefTypePort, "license_letter_revision", {
      inUse: async (tx, fileId) => (await tx.licenseLetterRevision.findMany({
        where: { fileId }, select: { id: true },
      })).map((row) => ({ fileId, refId: row.id, role: "pdf" })),
      roles: { pdf: { categories: ["legal_doc"], retentionDays: null, canRelease: async () => false } },
      readColumns: async (tx) => (await tx.licenseLetterRevision.findMany({
        where: { fileId: { not: null } }, select: { id: true, fileId: true },
      })).map((row) => ({ fileId: row.fileId!, refId: row.id, role: "pdf" })),
    }),
    implementKeyed(fileRefTypePort, "agreement_version", {
      // 已生效/历史协议均是法定证据；草稿也只按当前source/pdf列保护，替换掉的旧文件不占用。
      inUse: async (tx, fileId) =>
        (
          await tx.agreementVersion.findMany({
            where: { OR: [{ sourceFileId: fileId }, { pdfFileId: fileId }] },
            select: { id: true, sourceFileId: true, pdfFileId: true },
          })
        ).flatMap((row) => [
          ...(row.sourceFileId === fileId ? [{ fileId, refId: row.id, role: "source" }] : []),
          ...(row.pdfFileId === fileId ? [{ fileId, refId: row.id, role: "pdf" }] : []),
        ]),
      roles: {
        source: {
          categories: ["legal_doc"],
          retentionDays: 7,
          canRelease: async (tx, refId) =>
            (
              await tx.agreementVersion.findUnique({
                where: { id: refId },
                select: { status: true },
              })
            )?.status === "draft",
        },
        pdf: {
          categories: ["legal_doc"],
          retentionDays: 7,
          canRelease: async (tx, refId) =>
            (
              await tx.agreementVersion.findUnique({
                where: { id: refId },
                select: { status: true },
              })
            )?.status === "draft",
        },
      },
      readColumns: async (tx) =>
        (
          await tx.agreementVersion.findMany({
            select: { id: true, sourceFileId: true, pdfFileId: true },
          })
        ).flatMap((row) => [
          ...(row.sourceFileId
            ? [{ fileId: row.sourceFileId, refId: row.id, role: "source" }]
            : []),
          ...(row.pdfFileId ? [{ fileId: row.pdfFileId, refId: row.id, role: "pdf" }] : []),
        ]),
    }),
  ],
  invariants: [
    { code: "docs.N6", severity: "P2", modes: ["full"], heal: "heal_and_alert", run: unboundLicense },
    { code: "docs.N16", severity: "P2", modes: ["full"], heal: "none", run: unboundLicense },
    {
      code: "docs.N5",
      severity: "P2",
      modes: ["full"],
      heal: "none",
      run: (tx) => boundN5Violations(tx),
    },
    {
      code: "docs.N4",
      severity: "P2",
      modes: ["full"],
      heal: "none",
      run: (tx) => findN4Violations(tx),
    },
    {
      code: "docs.N13",
      severity: "P2",
      modes: ["full"],
      heal: "none",
      run: (tx) => findN13Violations(tx),
    },
  ],
});
