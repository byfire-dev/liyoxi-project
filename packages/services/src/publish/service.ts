import { ChecklistItemsSchema } from "@liyoxi/contract";
import type {
  ChannelAccountCreateBody,
  ChannelAccountSubmitBody,
  LaunchTaskSubmitBody,
  ChannelAccountApproveBody,
  ChannelAccountRejectBody,
  LaunchApproveBody,
  LaunchRejectBody,
} from "@liyoxi/contract";
import { calendarDate, diffDays } from "@liyoxi/shared/time";
import { hasPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx, IdentityContext } from "../kernel/index.js";
import { listChecklistTemplates } from "../config/index.js";
import type { PublishDeps, PublishViewer, PublishWriteOptions } from "./context.js";
import {
  accountInclude,
  launchInclude,
  accountOf,
  taskOf,
  dateOf,
  iso,
  snapshotOf,
  staffBrief,
} from "./repo.js";
import {
  accountCard,
  accountDetail,
  accountSubmissionDetail,
  signScreenshots,
  taskCard,
  taskDetail,
  launchDetail,
  todo,
} from "./views.js";
import {
  bindAccount,
  resubmitAccount,
  submitLaunch,
  createLaunchTasks,
  withDecision,
  decisionGuard,
} from "./write.js";
import type { CreateLaunchTasksInput } from "./write.js";
import { owner, reasonScene, invalid } from "./validate.js";
type PageQuery = { cursor?: string; limit: number };
type LaunchFilter = { orderId?: string; orderItemId?: string };
function page<T>(
  rows: T[],
  query: PageQuery,
  filter: unknown,
  key: (r: T) => string,
  descending = false,
) {
  const fingerprint = JSON.stringify(filter),
    sorted = rows.sort((a, b) => (descending ? -1 : 1) * key(a).localeCompare(key(b)));
  let after: string | null = null;
  if (query.cursor) {
    try {
      const c = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as {
        v: number;
        filter: string;
        key: string;
      };
      if (c.v !== 1 || c.filter !== fingerprint || typeof c.key !== "string") throw new Error();
      after = c.key;
    } catch {
      throw invalid("cursor", "游标不属于当前筛选，请从首页重试");
    }
  }
  const available =
      after === null
        ? sorted
        : sorted.filter((r) => (descending ? key(r) < after! : key(r) > after!)),
    items = available.slice(0, query.limit),
    hasMore = available.length > items.length;
  return {
    items,
    hasMore,
    nextCursor: hasMore
      ? Buffer.from(
          JSON.stringify({ v: 1, filter: fingerprint, key: key(items.at(-1)!) }),
        ).toString("base64url")
      : null,
  };
}
export function createPublish(deps: PublishDeps) {
  async function merchantTasks(tx: Tx, viewer: PublishViewer, query: LaunchFilter) {
    owner(viewer);
    return tx.launchTask.findMany({
      where: {
        storeId: viewer.membership.storeId,
        entityId: viewer.membership.entityId,
        ...(query.orderItemId ? { orderItemId: query.orderItemId } : {}),
        ...(query.orderId ? { orderItem: { dramaOrderId: query.orderId } } : {}),
      },
      include: launchInclude,
    });
  }
  async function accountRound(tx: Tx, id: string, staff: StaffContext) {
    const r = await tx.channelAccountSubmission.findUnique({ where: { id } });
    if (!r) throw new AppError("NOT_FOUND");
    await accountOf(tx, r.channelAccountId, staff, true);
    return r;
  }
  async function launchRound(tx: Tx, id: string, staff: StaffContext) {
    const r = await tx.launchSubmission.findUnique({ where: { id } });
    if (!r) throw new AppError("NOT_FOUND");
    await taskOf(tx, r.launchTaskId, staff);
    return r;
  }
  return {
    channelAccounts: (
      viewer: PublishViewer,
      query: PageQuery & { status?: string[]; platform?: string },
    ) =>
      deps.tx.run(async (tx) => {
        owner(viewer);
        const rows = await tx.channelAccount.findMany({
          where: {
            entityId: viewer.membership.entityId,
            storeId: viewer.membership.storeId,
            status: query.status ? { in: query.status } : { not: "unbound" },
            ...(query.platform ? { platform: query.platform } : {}),
          },
          include: accountInclude,
        });
        const result = page(
          rows,
          query,
          {
            storeId: viewer.membership.storeId,
            status: query.status?.slice().sort() ?? null,
            platform: query.platform ?? null,
          },
          (r) => `${iso(r.submittedAt)}:${r.id}`,
          true,
        );
        return { ...result, items: await Promise.all(result.items.map((r) => accountCard(tx, r))) };
      }),
    bind: (
      viewer: PublishViewer,
      body: ChannelAccountCreateBody,
      options: PublishWriteOptions = {},
    ) =>
      deps.tx.run(
        async (tx) =>
          accountCard(tx, await accountOf(tx, await bindAccount(tx, deps, viewer, body))),
        options,
      ),
    resubmit: (
      viewer: PublishViewer,
      id: string,
      body: ChannelAccountSubmitBody,
      options: PublishWriteOptions = {},
    ) =>
      deps.tx.run(async (tx) => {
        await resubmitAccount(tx, deps, viewer, id, body);
        return accountCard(tx, await accountOf(tx, id));
      }, options),
    launchSummary: (viewer: PublishViewer, query: LaunchFilter = {}) =>
      deps.tx.run(async (tx) => {
        const rows = await merchantTasks(tx, viewer, query);
        return {
          todo: rows.filter(todo).length,
          done: rows.filter((t) => !todo(t)).length,
          needFix: rows.filter((t) => todo(t) && t.reviewStatus === "need_fix").length,
        };
      }),
    async launchTasks(
      viewer: PublishViewer,
      query: PageQuery & LaunchFilter & { tab: "todo" | "done" | "all" },
    ) {
      const raw = await deps.tx.run(async (tx) => {
        const rows = (await merchantTasks(tx, viewer, query)).filter(
          (t) => query.tab === "all" || todo(t) === (query.tab === "todo"),
        );
        const groups = new Map<string, typeof rows>();
        for (const t of rows)
          groups.set(t.orderItem.dramaOrderId, [
            ...(groups.get(t.orderItem.dramaOrderId) ?? []),
            t,
          ]);
        const items = await Promise.all(
          [...groups.entries()].map(async ([orderId, group]) => {
            const itemIds = [...new Set(group.map((t) => t.orderItemId))],
              agreedLaunchDate =
                group
                  .map((t) => dateOf(t.orderItem.agreedLaunchDate))
                  .filter((s): s is string => s !== null)
                  .sort()[0] ?? null;
            const children = await Promise.all(
              itemIds.map(async (itemId) => {
                const tasks = group.filter((t) => t.orderItemId === itemId),
                  t = tasks[0]!,
                  item = t.orderItem,
                  release = await tx.deliveryRelease.findFirst({
                    where: { orderItemId: item.id, state: "pushed" },
                    orderBy: { releaseNo: "desc" },
                    include: { downloadGrants: true },
                  }),
                  grant = release?.downloadGrants
                    .filter((g) => g.granteeType === "entity" && g.state === "active")
                    .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())[0];
                return {
                  orderItemId: item.id,
                  dramaTitle: snapshotOf(item.dramaSnapshot).title ?? "",
                  posterUrl: null as { url: string; expiresAt: string } | null,
                  _posterFileId: snapshotOf(item.dramaSnapshot).posterFileId ?? null,
                  episodeCount: item.episodeCount,
                  phase: item.phase,
                  liveEpisodeCount: item.liveEpisodeCount,
                  agreedLaunchDate: dateOf(item.agreedLaunchDate),
                  usageEndDate: dateOf(item.usageEndDate),
                  ticketStep: t.deliveryTicket.step,
                  isPaused: t.deliveryTicket.pauseCount > 0,
                  release: release
                    ? {
                        deliveryReleaseId: release.id,
                        releaseNo: release.releaseNo,
                        episodeCount: release.episodeCount,
                        totalBytes: release.totalBytes.toString(),
                        grantExpiresAt: iso(grant?.expiresAt ?? null),
                        isGrantValid: !!grant && grant.expiresAt > deps.clock.now(),
                        savedEpisodeCount: new Set(
                          (
                            await tx.deliveryDownloadLog.findMany({
                              where: {
                                deliveryReleaseId: release.id,
                                clientAck: "saved",
                                episodeNo: { not: null },
                              },
                              select: { episodeNo: true },
                            })
                          ).map((log) => log.episodeNo),
                        ).size,
                        hasChangedEpisodes: release.changedEpisodeNos.length > 0,
                      }
                    : null,
                  tasks: await Promise.all(tasks.map((row) => taskCard(tx, row, deps.clock.now()))),
                };
              }),
            );
            return {
              orderId,
              orderNo: group[0]!.orderItem.dramaOrder.orderNo,
              agreedLaunchDate,
              daysUntilLaunch: agreedLaunchDate
                ? diffDays(calendarDate(deps.clock.now()), agreedLaunchDate)
                : null,
              items: children,
            };
          }),
        );
        return page(
          items,
          query,
          {
            storeId: viewer.membership.storeId,
            tab: query.tab,
            orderId: query.orderId ?? null,
            orderItemId: query.orderItemId ?? null,
          },
          (r) => `${r.agreedLaunchDate ?? "9999-12-31"}:${r.orderId}`,
        );
      });
      for (const group of raw.items)
        for (const item of group.items) {
          if (item._posterFileId)
            item.posterUrl = await deps.media.signRead({
              fileId: item._posterFileId,
              audience: "merchant",
            });
          const { _posterFileId: _omit, ...safe } = item;
          Object.assign(item, safe);
          delete (item as Partial<typeof item>)._posterFileId;
        }
      return raw;
    },
    launchTask: (viewer: PublishViewer, id: string) =>
      deps.tx.run(async (tx) => {
        owner(viewer);
        const task = await taskOf(tx, id);
        if (
          task.storeId !== viewer.membership.storeId ||
          task.entityId !== viewer.membership.entityId
        )
          throw new AppError("NOT_FOUND");
        return taskDetail(tx, deps, task);
      }),
    submitLaunch: (
      viewer: PublishViewer,
      id: string,
      body: LaunchTaskSubmitBody,
      options: PublishWriteOptions = {},
    ) =>
      deps.tx.run(async (tx) => {
        await submitLaunch(tx, deps, viewer, id, body);
        return taskCard(tx, await taskOf(tx, id), deps.clock.now());
      }, options),
    accountDetail: (staff: StaffContext, id: string) =>
      deps.tx.run((tx) => accountDetail(tx, deps, id, staff)),
    async accountSubmission(staff: StaffContext, id: string) {
      const view = await deps.tx.run(async (tx) => {
        await accountRound(tx, id, staff);
        return accountSubmissionDetail(tx, deps, id, staff);
      });
      return signScreenshots(deps, view);
    },
    async approveAccount(
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: ChannelAccountApproveBody,
      options: PublishWriteOptions = {},
    ) {
      const view = await deps.tx.run(async (tx) => {
        const r = await accountRound(tx, id, staff);
        await decisionGuard(tx, staff, r.approvalRequestId, body, true);
        await withDecision(tx, deps, ctx, staff, body, true, () =>
          deps.approval.approve(tx, ctx, {
            approvalId: r.approvalRequestId,
            staff,
            lockVersion: body.lockVersion,
            ...(body.confirmChecks ? { confirmChecks: body.confirmChecks } : {}),
          }),
        );
        return accountSubmissionDetail(tx, deps, id, staff);
      }, options);
      return {
        ...(await signScreenshots(deps, view, options.idem?.replayed)),
        replayed: options.idem?.replayed ?? false,
      };
    },
    async rejectAccount(
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: ChannelAccountRejectBody,
      options: PublishWriteOptions = {},
    ) {
      const view = await deps.tx.run(async (tx) => {
        const r = await accountRound(tx, id, staff);
        await decisionGuard(tx, staff, r.approvalRequestId, body, false);
        await reasonScene(tx, [body.reasonCode], "account_verify");
        await withDecision(tx, deps, ctx, staff, body, false, () =>
          deps.approval.reject(tx, ctx, {
            approvalId: r.approvalRequestId,
            staff,
            reasonCodes: [body.reasonCode],
            note: body.note,
          }),
        );
        return accountSubmissionDetail(tx, deps, id, staff);
      }, options);
      return {
        ...(await signScreenshots(deps, view, options.idem?.replayed)),
        replayed: options.idem?.replayed ?? false,
      };
    },
    launchSubmission: (staff: StaffContext, id: string) =>
      deps.tx.run(async (tx) => {
        await launchRound(tx, id, staff);
        return launchDetail(tx, deps, id, staff);
      }),
    approveLaunch: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: LaunchApproveBody,
      options: PublishWriteOptions = {},
    ) =>
      deps.tx.run(async (tx) => {
        const r = await launchRound(tx, id, staff);
        await decisionGuard(tx, staff, r.approvalRequestId, body, true, r.launchTaskId);
        await withDecision(tx, deps, ctx, staff, body, true, () =>
          deps.approval.approve(tx, ctx, {
            approvalId: r.approvalRequestId,
            staff,
            lockVersion: body.lockVersion,
            ...(body.confirmChecks ? { confirmChecks: body.confirmChecks } : {}),
          }),
        );
        return launchDetail(tx, deps, id, staff);
      }, options),
    rejectLaunch: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: LaunchRejectBody,
      options: PublishWriteOptions = {},
    ) =>
      deps.tx.run(async (tx) => {
        const r = await launchRound(tx, id, staff);
        await decisionGuard(tx, staff, r.approvalRequestId, body, false, r.launchTaskId);
        await reasonScene(tx, body.reasonCodes, "link_verify");
        await withDecision(tx, deps, ctx, staff, body, false, () =>
          deps.approval.reject(tx, ctx, {
            approvalId: r.approvalRequestId,
            staff,
            reasonCodes: body.reasonCodes,
            note: body.note,
          }),
        );
        return launchDetail(tx, deps, id, staff);
      }, options),
    createLaunchTasks: (tx: Tx, ctx: IdentityContext, input: CreateLaunchTasksInput) =>
      createLaunchTasks(tx, deps, ctx, input),
    async checklists(
      staff: StaffContext,
      query: { code?: string[]; status?: string[]; allVersions?: boolean },
    ) {
      if (
        (query.allVersions || query.status?.some((s) => s !== "active")) &&
        !hasPermission(staff, "flow.checklist.manage")
      )
        throw new AppError("PERMISSION_DENIED");
      return deps.tx.run(async (tx) => ({
        items: await Promise.all(
          (await listChecklistTemplates(tx, query)).map(async (r) => ({
            checklistTemplateId: r.id,
            code: r.code,
            versionNo: r.versionNo,
            status: r.status,
            items: ChecklistItemsSchema.parse(r.items),
            activatedAt: iso(r.activatedAt),
            retiredAt: iso(r.retiredAt),
            createdBy: await staffBrief(tx, r.createdByStaffId),
            createdAt: iso(r.createdAt),
            updatedAt: iso(r.updatedAt),
            lockVersion: r.lockVersion,
            actions:
              r.status === "draft" && hasPermission(staff, "flow.checklist.manage")
                ? ["activate", "discard"]
                : [],
          })),
        ),
      }));
    },
  };
}
export type Publish = ReturnType<typeof createPublish>;
export const countPendingChannelAccountsByStore = (tx: Tx, storeId: string) =>
  tx.channelAccount.count({ where: { storeId, status: "pending_verify" } });

/** 同事务只读审核事实；作废任务不参与当前待上线展示。 */
export async function getLaunchReviewSummary(tx: Tx, orderItemId: string) {
  const tasks = await tx.launchTask.findMany({
    where: { orderItemId, reviewStatus: { not: "void" } },
    select: { reviewStatus: true },
  });
  return {
    hasVerifying: tasks.some((t) => t.reviewStatus === "verifying"),
    hasNeedFix: tasks.some((t) => t.reviewStatus === "need_fix"),
  };
}

/** 同事务交给 delivery/order 的当前事实；不回写它们的表。 */
export async function getLaunchFacts(tx: Tx, orderItemId: string) {
  const tasks = await tx.launchTask.findMany({
    where: { orderItemId, reviewStatus: { not: "void" } },
  });
  return {
    hasLive: tasks.some((t) => t.isLive),
    hasVerifying: tasks.some((t) => t.reviewStatus === "verifying"),
    liveEpisodeCount: Math.max(0, ...tasks.map((t) => t.verifiedEpisodeCount)),
    firstLaunchDate:
      tasks
        .filter((t) => t.isLive && t.firstLaunchDate)
        .map((t) => dateOf(t.firstLaunchDate)!)
        .sort()[0] ?? null,
    accounts: tasks.map((t) => ({
      channelAccountId: t.channelAccountId,
      isLive: t.isLive,
      verifiedEpisodeCount: t.verifiedEpisodeCount,
      firstLaunchDate: dateOf(t.firstLaunchDate),
    })),
  };
}
