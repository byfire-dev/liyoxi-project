import { implement as implementTenantCloseFacts } from "../kernel/index.js";
import { remindersPort } from "../kernel/index.js";
import { launchReminderRule, overdueLaunchReminderRule } from "./launch-reminders.js";
import { publishCloseFactsPort } from "../tenant/index.js";
import { countPendingChannelAccountsByStore } from "./service.js";
import { staffWorkPort, staffFollowUpPort } from "../kernel/index.js";
import { publishStaffWork } from "./staff-work.js";
import {
  implementKeyed as notifyFactImplementation,
  notifyReadPort as currentNotifyRead,
} from "../kernel/index.js";
import {
  accountNoticeFact,
  launchNoticeFact,
  launchLinkForItem,
  launchRevokedForNotify,
  launchRevokeEventCurrentForNotify,
} from "./notify-facts.js";
import { approvalKindPort } from "../approval/index.js";
import { hasPermission } from "../authz/index.js";
import { fileCategoryGuardPort } from "../media/index.js";
import {
  AppError,
  defineRegistration,
  fileRefTypePort,
  implementKeyed,
  implementMerchantFacts,
  notifyReadPort,
} from "../kernel/index.js";
import { accountKind, launchKind } from "./write.js";
import { publishMachines } from "./machines.js";
import { cancelReviewPublishMachines } from "./cancel-review-close.js";
import { launchChangedPort, launchHandlerPort } from "./ports.js";
import { findPublishViolations, PUBLISH_INVARIANT_CODES } from "./invariants.js";
import { launchInclude, accountInclude } from "./repo.js";
import { accountCard, todo } from "./views.js";
import { channelAccountForNotify, launchTaskForNotify } from "./notify-read.js";
import { patrolNoticeFact } from "./patrol-notify.js";
import { patrolOwnershipViolations, patrolObsoleteViolations } from "./patrol-invariants.js";
import { invariantNow } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { TAKEDOWN_INVARIANT_CODES, findTakedownViolations } from "./takedown-invariants.js";
import { takedownReminderRule } from "./takedown-notify.js";
import {
  takedownNoticeFact,
  takedownReminderFact,
  takedownEventCurrentForNotify,
} from "./takedown-notify.js";
export const registration = defineRegistration("publish", {
  timerHandlers: [
    ...["takedown.create", "takedown.overdue"].map((kind) => ({
      kind,
      critical: kind === "takedown.create",
      handle: async (): Promise<"fired" | "skipped"> => {
        throw new TypeError("下架运行时尚未绑定");
      },
    })),
    {
      kind: "patrol.followup",
      handle: async () => {
        throw new TypeError("巡检运行时尚未绑定");
      },
    },
  ],
  recurringJobs: [
    {
      kind: "patrol.weekly_generate",
      schedule: { every: "week", weekday: 1, at: "09:00" },
      mode: "tx",
      missSeverity: "P2",
      catchUp: true,
      run: async () => {
        throw new TypeError("巡检运行时尚未绑定");
      },
    },
  ],
  subscribers: [
    {
      name: "publish.onCalendarImported",
      critical: false,
      events: ["calendar.imported"],
      handle: async () => {
        throw new TypeError("下架运行时尚未绑定");
      },
    },
    {
      name: "publish.onLicenseExtended",
      critical: true,
      events: ["drama.license_extended"],
      handle: async () => {
        throw new TypeError("使用期运行时尚未绑定");
      },
    },
  ],
  ports: [launchChangedPort, launchHandlerPort],
  portImplementations: [
    implementKeyed(remindersPort, "R3", takedownReminderRule),
    notifyFactImplementation(currentNotifyRead, "takedownNoticeFact", takedownNoticeFact),
    notifyFactImplementation(currentNotifyRead, "takedownReminderFact", takedownReminderFact),
    notifyFactImplementation(
      currentNotifyRead,
      "takedownEventCurrentForNotify",
      takedownEventCurrentForNotify,
    ),
    implementKeyed(fileRefTypePort, "takedown_task", {
      inUse: async (tx, fileId) =>
        (
          await tx.takedownTask.findMany({
            where: { evidenceFileIds: { has: fileId } },
            select: { id: true },
          })
        ).map((r) => ({ fileId, refId: r.id, role: "evidence" })),
      roles: {
        evidence: { categories: ["evidence"], retentionDays: 1095, canRelease: async () => false },
      },
      readColumns: async (tx) =>
        (await tx.takedownTask.findMany({ select: { id: true, evidenceFileIds: true } })).flatMap(
          (r) => r.evidenceFileIds.map((fileId) => ({ fileId, refId: r.id, role: "evidence" })),
        ),
    }),
    implementKeyed(remindersPort, "R2", launchReminderRule),
    implementKeyed(remindersPort, "R6", overdueLaunchReminderRule),
    notifyFactImplementation(currentNotifyRead, "patrolNoticeFact", patrolNoticeFact),
    implementKeyed(fileRefTypePort, "patrol_task", {
      inUse: async (tx, fileId) =>
        (
          await tx.patrolTask.findMany({
            where: { evidenceFileIds: { has: fileId } },
            select: { id: true },
          })
        ).map((r) => ({ fileId, refId: r.id, role: "evidence" })),
      roles: {
        evidence: { categories: ["evidence"], retentionDays: 1095, canRelease: async () => false },
      },
      readColumns: async (tx) =>
        (await tx.patrolTask.findMany({ select: { id: true, evidenceFileIds: true } })).flatMap(
          (r) => r.evidenceFileIds.map((fileId) => ({ fileId, refId: r.id, role: "evidence" })),
        ),
    }),
    implementTenantCloseFacts(publishCloseFactsPort, { countPendingChannelAccountsByStore }),
    implementKeyed(staffFollowUpPort, "takedown_task", async (tx, id) => {
      const row = await tx.takedownTask.findUnique({
        where: { id },
        select: { entityId: true, storeId: true },
      });
      return row === null ? null : { entityId: row.entityId, storeId: row.storeId };
    }),
    implementKeyed(staffFollowUpPort, "patrol_task", async (tx, id) => {
      const row = await tx.patrolTask.findUnique({
        where: { id },
        select: { entityId: true, storeId: true },
      });
      return row === null ? null : { entityId: row.entityId, storeId: row.storeId };
    }),
    implementKeyed(staffWorkPort, "publish", publishStaffWork),
    notifyFactImplementation(
      currentNotifyRead,
      "manualSubjectExists.takedown_task",
      async (tx, id: string) =>
        (await tx.takedownTask.findUnique({ where: { id }, select: { id: true } })) !== null,
    ),
    notifyFactImplementation(
      currentNotifyRead,
      "manualSubjectExists.patrol_task",
      async (tx, id: string) =>
        (await tx.patrolTask.findUnique({ where: { id }, select: { id: true } })) !== null,
    ),
    notifyFactImplementation(currentNotifyRead, "launchLinkForItem", launchLinkForItem),
    notifyFactImplementation(currentNotifyRead, "accountNoticeFact", accountNoticeFact),
    notifyFactImplementation(currentNotifyRead, "launchNoticeFact", launchNoticeFact),
    notifyFactImplementation(currentNotifyRead, "launchRevokedForNotify", launchRevokedForNotify),
    notifyFactImplementation(
      currentNotifyRead,
      "launchRevokeEventCurrentForNotify",
      launchRevokeEventCurrentForNotify,
    ),
    ...publishMachines,
    ...cancelReviewPublishMachines,
    implementKeyed(approvalKindPort, "channel_account", accountKind),
    implementKeyed(approvalKindPort, "launch_link", launchKind),
    implementKeyed(notifyReadPort, "channelAccountForNotify", channelAccountForNotify),
    implementKeyed(notifyReadPort, "launchTaskForNotify", launchTaskForNotify),
    implementKeyed(fileCategoryGuardPort, "evidence", {
      async assert(_tx, actor) {
        if (
          !actor.staff ||
          !["publish.takedown.check", "publish.patrol.do", "publish.link.verify"].some((p) =>
            hasPermission(actor.staff!, p as "publish.link.verify"),
          )
        )
          throw new AppError("PERMISSION_DENIED");
      },
    }),
    implementKeyed(fileRefTypePort, "channel_account_submission", {
      inUse: async (tx, fileId) =>
        (
          await tx.channelAccountSubmission.findMany({
            where: {
              screenshotFileIds: { has: fileId },
              channelAccount: { status: { not: "unbound" } },
            },
            select: { id: true },
          })
        ).map((row) => ({ fileId, refId: row.id, role: "screenshot" })),
      roles: {
        screenshot: {
          categories: ["channel_screenshot"],
          retentionDays: 365,
          canRelease: async (tx, id) =>
            (
              await tx.channelAccountSubmission.findUnique({
                where: { id },
                include: { channelAccount: true },
              })
            )?.channelAccount.status === "unbound",
        },
      },
      readColumns: async (tx) =>
        (
          await tx.channelAccountSubmission.findMany({
            select: { id: true, screenshotFileIds: true },
          })
        ).flatMap((r) =>
          r.screenshotFileIds.map((fileId) => ({ fileId, refId: r.id, role: "screenshot" })),
        ),
    }),
    implementKeyed(fileRefTypePort, "launch_submission", {
      // 已提交上线证据遵守既有canRelease=false，未通过新策略擅自放宽法定留存。
      inUse: async (tx, fileId) =>
        (
          await tx.launchSubmission.findMany({
            where: { evidenceFileIds: { has: fileId } },
            select: { id: true },
          })
        ).map((row) => ({ fileId, refId: row.id, role: "evidence" })),
      roles: {
        evidence: { categories: ["evidence"], retentionDays: 1095, canRelease: async () => false },
      },
      readColumns: async (tx) =>
        (
          await tx.launchSubmission.findMany({ select: { id: true, evidenceFileIds: true } })
        ).flatMap((r) =>
          r.evidenceFileIds.map((fileId) => ({ fileId, refId: r.id, role: "evidence" })),
        ),
    }),
    implementMerchantFacts("publish", async (tx, query) => {
      const stores: Record<
        string,
        {
          launchTaskTodoCount: number;
          hasLaunchTasks: boolean;
          channelAccountCount: number;
          channelAccountAttention: Record<string, unknown> | null;
        }
      > = {};
      for (const storeId of query.storeIds) {
        const tasks = await tx.launchTask.findMany({
            where: { entityId: query.entityId, storeId },
            include: launchInclude,
          }),
          accounts = await tx.channelAccount.findMany({
            where: { entityId: query.entityId, storeId, status: { not: "unbound" } },
            include: accountInclude,
          }),
          attention = accounts.find((a) => ["pending_verify", "abnormal"].includes(a.status));
        stores[storeId] = {
          launchTaskTodoCount: tasks.filter(todo).length,
          hasLaunchTasks: tasks.length > 0,
          channelAccountCount: accounts.length,
          channelAccountAttention: attention ? await accountCard(tx, attention) : null,
        };
      }
      return { stores };
    }),
  ],
  invariants: [
    ...TAKEDOWN_INVARIANT_CODES.map((code) => ({
      code: `publish.${code}`,
      severity: "P2" as const,
      modes: ["full" as const],
      heal: code === "I16" ? ("heal_and_alert" as const) : ("none" as const),
      run: (tx: Tx, _scope: unknown, ctx: Parameters<typeof invariantNow>[0]) =>
        findTakedownViolations(tx, code, invariantNow(ctx)),
    })),
    ...PUBLISH_INVARIANT_CODES.map((code) => ({
      code: `publish.${code}`,
      severity: "P2" as const,
      modes: ["full" as const],
      heal: "none" as const,
      run: (tx: Tx) => findPublishViolations(tx, code),
    })),
    {
      code: "publish.I14",
      severity: "P2",
      modes: ["full"],
      heal: "none",
      run: patrolOwnershipViolations,
    },
    {
      code: "publish.I15",
      severity: "P2",
      modes: ["full"],
      heal: "heal_and_alert",
      run: (tx, _scope, ctx) => patrolObsoleteViolations(tx, invariantNow(ctx)),
    },
  ],
});
