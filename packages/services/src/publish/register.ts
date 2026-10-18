import { implement as implementTenantCloseFacts } from "../kernel/index.js";
import { publishCloseFactsPort } from "../tenant/index.js";
import { countPendingChannelAccountsByStore } from "./service.js";
import { staffWorkPort, staffFollowUpPort } from "../kernel/index.js";
import { publishStaffWork } from "./staff-work.js";
import {
  implementKeyed as notifyFactImplementation,
  notifyReadPort as currentNotifyRead,
} from "../kernel/index.js";
import { accountNoticeFact, launchNoticeFact, launchLinkForItem } from "./notify-facts.js";
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
import { launchChangedPort, launchHandlerPort } from "./ports.js";
import { findPublishViolations, PUBLISH_INVARIANT_CODES } from "./invariants.js";
import { launchInclude, accountInclude } from "./repo.js";
import { accountCard, todo } from "./views.js";
import { channelAccountForNotify, launchTaskForNotify } from "./notify-read.js";
export const registration = defineRegistration("publish", {
  ports: [launchChangedPort, launchHandlerPort],
  portImplementations: [
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
    ...publishMachines,
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
  invariants: PUBLISH_INVARIANT_CODES.map((code) => ({
    code: `publish.${code}`,
    severity: "P2",
    modes: ["full"],
    heal: "none",
    run: (tx) => findPublishViolations(tx, code),
  })),
});
