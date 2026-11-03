import {
  PublishListAdminViewSchema,
  PublishListReplaceBodySchema,
  PublishListImportBodySchema,
  PublishListViewSchema,
} from "@liyoxi/contract";
import type {
  PublishListAdminView,
  PublishListReplaceBody,
  PublishListImportBody,
} from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { assertAccess, assertPermission, taskScope } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { record } from "../audit/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { readCancelZipTargets, invalidateZipBundles } from "../media/index.js";
import { staffBriefs } from "../staff/index.js";
import type { DeliveryDeps, DeliveryViewer, DeliveryWriteOptions } from "./context.js";
import { assertOwner, dateOf, iso, lockTickets, ticketInclude } from "./repo.js";
import type { TicketRow } from "./repo.js";
import { invalid, unpaused } from "./quality.js";
import { publishListFacts } from "./publish-list.js";
import { parsePublishListImport } from "./publish-list-import.js";

export type PublishListsDeps = Pick<DeliveryDeps, "tx" | "clock" | "media" | "events">;
const topics = (values: readonly string[]) => values.map((v) => v.replace(/^#/, "").trim());
const nullableText = (value: string | null) => value?.trim() || null;

async function scopedTicket(tx: Tx, id: string, staff: StaffContext) {
  const scope = taskScope<Prisma.DeliveryTicketWhereInput>(staff.scope, {
    store: (store) => ({ store }),
    assignees: [{ col: "publisherId", pool: "ticket_publisher" }, { col: "deliveryManagerId" }],
  });
  const ticket = await tx.deliveryTicket.findFirst({
    where: { id, ...scope },
    include: ticketInclude,
  });
  if (!ticket) throw new AppError("NOT_FOUND");
  return ticket;
}

async function storeTicket(
  tx: Tx,
  scope: { entityId: string; storeId: string },
  orderItemId: string,
) {
  const ticket = await tx.deliveryTicket.findFirst({
    where: { orderItemId, entityId: scope.entityId, storeId: scope.storeId },
    include: ticketInclude,
  });
  if (
    !ticket ||
    ticket.orderItem.entityId !== scope.entityId ||
    ticket.orderItem.storeId !== scope.storeId
  )
    throw new AppError("NOT_FOUND");
  return ticket;
}

export const publishListLockReason = (t: TicketRow) =>
  t.linksSubmittedAt
    ? ("links_submitted" as const)
    : t.pauseCount
      ? ("ticket_paused" as const)
      : !["delivering", "awaiting_launch"].includes(t.step)
        ? ("ticket_step" as const)
        : null;

async function adminView(tx: Tx, t: TicketRow) {
  const facts = await publishListFacts(tx, t),
    p = facts.p;
  if (!p) throw new AppError("NOT_FOUND");
  const staff = await staffBriefs(
    tx,
    [t.deliveryManagerId, t.publisherId, p.savedByStaffId].filter((v): v is string => v !== null),
  );
  const brief = (id: string | null) => staff.find((s) => s.staffId === id) ?? null;
  const release = await tx.deliveryRelease.findFirst({
    where: { orderItemId: t.orderItemId, state: "pushed" },
    orderBy: { releaseNo: "desc" },
  });
  return PublishListAdminViewSchema.parse({
    publishListId: p.id,
    ticket: {
      deliveryTicketId: t.id,
      ticketNo: t.ticketNo,
      step: t.step,
      isPaused: t.pauseCount > 0,
      pauseReasons: t.deliveryTicketPauses.filter((r) => !r.releasedAt).map((r) => r.reason),
      deliveryManager: brief(t.deliveryManagerId),
      publisher: brief(t.publisherId),
      deliveryTargetAt: iso(t.deliveryTargetAt),
      deliveredAt: iso(t.deliveredAt),
    },
    orderItem: {
      orderItemId: t.orderItemId,
      orderId: t.dramaOrderId,
      orderNo: t.dramaOrder.orderNo,
      orderedAt: iso(t.dramaOrder.createdAt),
      dramaTitle: (t.orderItem.dramaSnapshot as { title: string }).title,
      episodeCount: t.orderItem.episodeCount,
      productionModel: t.orderItem.productionModel,
      phase: t.orderItem.phase,
      agreedLaunchDate: dateOf(t.orderItem.agreedLaunchDate),
      usageStartDate: dateOf(t.orderItem.usageStartDate),
      usageEndDate: dateOf(t.orderItem.usageEndDate),
      usageEndSource: t.orderItem.usageEndSource,
      liveEpisodeCount: t.orderItem.liveEpisodeCount,
    },
    collectionName: p.collectionName,
    cover: p.coverFileId ? { fileId: p.coverFileId, url: null, expiresAt: null } : null,
    titleTemplate: p.titleTemplate,
    topics: p.topics,
    intro: p.intro,
    isAiDeclarationRequired: p.isAiDeclarationRequired,
    episodes: facts.episodes.map((e) => {
      const row = facts.rows.find((r) => r.episodeNo === e.episodeNo);
      return {
        episodeNo: e.episodeNo,
        highlight: row?.highlight ?? null,
        title: row?.title ?? null,
        renderedTitle: e.title,
        topics: row?.topics ?? null,
        intro: row?.intro ?? null,
        changedInReleaseNo: row?.changedInReleaseNo ?? null,
      };
    }),
    completeness: facts.completeness,
    isEditable: publishListLockReason(t) === null,
    lockReason: publishListLockReason(t),
    savedBy: brief(p.savedByStaffId),
    savedAt: iso(p.savedAt),
    lockVersion: p.lockVersion,
    activeRelease: release
      ? {
          deliveryReleaseId: release.id,
          releaseNo: release.releaseNo,
          pushedAt: iso(release.pushedAt),
        }
      : null,
  });
}

async function editable(tx: Tx, staff: StaffContext, id: string, lockVersion: number) {
  await scopedTicket(tx, id, staff);
  await lockTickets(tx, [id]);
  const t = await scopedTicket(tx, id, staff);
  const p = await tx.publishList.findUnique({ where: { deliveryTicketId: id } });
  if (!p) throw new AppError("NOT_FOUND");
  if (t.linksSubmittedAt)
    throw new AppError("PUBLISH_LIST_LOCKED", {
      details: { lockedAt: t.linksSubmittedAt.toISOString() },
    });
  unpaused(t);
  if (!["delivering", "awaiting_launch"].includes(t.step)) throw new AppError("STATE_NOT_ALLOWED");
  if (p.lockVersion !== lockVersion)
    throw new AppError("VERSION_CONFLICT", { details: { lockVersion: p.lockVersion } });
  return { t, p };
}

async function finish(
  tx: Tx,
  deps: PublishListsDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  t: TicketRow,
  previous: NonNullable<Awaited<ReturnType<typeof publishListFacts>>["p"]>,
  newCover: string | null,
  action: "replace" | "import",
) {
  const now = deps.clock.now();
  const releases = await tx.deliveryRelease.findMany({
    where: { orderItemId: t.orderItemId, state: "pushed" },
  });
  await lockRows(
    tx,
    "delivery_release",
    releases.map((r) => r.id),
  );
  const zip = await readCancelZipTargets(
    tx,
    releases.map((r) => r.id),
  );
  await lockRows(tx, "zip_bundle", zip.zipBundleIds);
  await lockRows(tx, "file_object", [
    ...zip.fileObjectIds,
    ...[previous.coverFileId, newCover].filter((v): v is string => v !== null),
  ]);
  if (newCover)
    await deps.media.link(tx, {
      fileId: newCover,
      entityId: t.entityId,
      storeId: t.storeId,
      refType: "publish_list",
      refId: previous.id,
      role: "cover",
    });
  if (previous.coverFileId && previous.coverFileId !== newCover)
    await deps.media.release(tx, {
      fileId: previous.coverFileId,
      entityId: t.entityId,
      storeId: t.storeId,
      refType: "publish_list",
      refId: previous.id,
      role: "cover",
      keepUntil: new Date(now.getTime() + 30 * 86_400_000),
    });
  const changed = await tx.publishList.updateMany({
    where: { id: previous.id, lockVersion: previous.lockVersion },
    data: {
      savedByStaffId: staff.staff.id,
      savedAt: now,
      lockVersion: { increment: 1 },
      updatedAt: now,
    },
  });
  if (changed.count !== 1) throw new AppError("VERSION_CONFLICT");
  const facts = await publishListFacts(tx, t);
  await tx.deliveryRelease.updateMany({
    where: { id: { in: releases.map((r) => r.id) } },
    data: { publishListText: facts.text, updatedAt: now },
  });
  await invalidateZipBundles(tx, zip, now, { preserveReleaseFiles: true });
  await record(
    tx,
    ctx.actor,
    {
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      authMethod: null,
      sessionId: null,
    },
    {
      stream: "activity",
      category: "delivery",
      action: `delivery.publish_list.${action}`,
      summary: "保存发布清单",
      target: { type: "publish_list", id: previous.id },
      entityId: t.entityId,
      storeId: t.storeId,
    },
  );
  await deps.events.emit(tx, ctx, {
    type: "publish_list.updated",
    aggregate: { type: "publish_list", id: previous.id },
    entityId: t.entityId,
    storeId: t.storeId,
    dedupeKey: `publish_list.updated:${previous.id}:${previous.lockVersion + 1}`,
    payload: {
      v: 1,
      publishListId: previous.id,
      deliveryTicketId: t.id,
      isAfterPush: releases.length > 0,
    },
  });
  return adminView(tx, t);
}

export function createPublishLists(deps: PublishListsDeps) {
  async function sign(view: PublishListAdminView) {
    if (view.cover)
      Object.assign(
        view.cover,
        await deps.media.signRead({ fileId: view.cover.fileId, audience: "staff" }),
      );
    return view;
  }
  async function readForStore(scope: { entityId: string; storeId: string }, orderItemId: string) {
    const { entityId, storeId } = scope;
    const result = await deps.tx.run(async (tx) => {
      const candidate = await storeTicket(tx, scope, orderItemId);
      await lockRows(tx, "delivery_ticket", [candidate.id], "share");
      const t = await storeTicket(tx, scope, orderItemId);
      const release = await tx.deliveryRelease.findFirst({
        where: { orderItemId, entityId, storeId, state: "pushed" },
        orderBy: { releaseNo: "desc" },
      });
      const facts = await publishListFacts(tx, t),
        p = facts.p;
      if (!release || !p) throw new AppError("NOT_FOUND");
      return {
        orderItemId,
        releaseNo: release.releaseNo,
        collectionName: p.collectionName ?? "",
        coverFileId: p.coverFileId,
        topics: p.topics,
        intro: p.intro ?? "",
        isAiDeclarationRequired: p.isAiDeclarationRequired,
        episodes: facts.episodes.map((e) => ({
          ...e,
          isUpdated: facts.rows.some(
            (r) => r.episodeNo === e.episodeNo && r.changedInReleaseNo === release.releaseNo,
          ),
        })),
        text: release.publishListText,
      };
    });
    const { coverFileId, ...view } = result;
    return PublishListViewSchema.parse({
      ...view,
      cover: coverFileId
        ? {
            fileId: coverFileId,
            ...(await deps.media.signRead({ fileId: coverFileId, audience: "merchant" })),
          }
        : null,
    });
  }
  return {
    get: async (staff: StaffContext, id: string) => {
      assertAccess(staff, { module: { module: "publish", need: "view" }, permission: null });
      return sign(
        await deps.tx.run(async (tx) => {
          await scopedTicket(tx, id, staff);
          await lockRows(tx, "delivery_ticket", [id], "share");
          return adminView(tx, await scopedTicket(tx, id, staff));
        }),
      );
    },
    replace: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: PublishListReplaceBody,
      options: DeliveryWriteOptions = {},
    ) => {
      assertPermission(staff, "publish.list.edit", deps.clock.now());
      const body = PublishListReplaceBodySchema.parse(input);
      const view = await deps.tx.run(async (tx) => {
        const { t, p } = await editable(tx, staff, id, body.lockVersion),
          now = deps.clock.now();
        if (body.episodes.some((r) => r.episodeNo > t.orderItem.episodeCount))
          throw invalid("episodes", "集号超出整部集数");
        await tx.publishList.update({
          where: { id: p.id },
          data: {
            collectionName: nullableText(body.collectionName),
            coverFileId: body.coverFileId,
            titleTemplate: nullableText(body.titleTemplate),
            topics: topics(body.topics),
            intro: nullableText(body.intro),
          },
        });
        for (let episodeNo = 1; episodeNo <= t.orderItem.episodeCount; episodeNo++) {
          const row = body.episodes.find((r) => r.episodeNo === episodeNo);
          const data = {
            highlight: nullableText(row?.highlight ?? null),
            title: nullableText(row?.title ?? null),
            topics: topics(row?.topics ?? []),
            intro: nullableText(row?.intro ?? null),
            updatedAt: now,
          };
          await tx.publishListEpisode.upsert({
            where: { deliveryTicketId_episodeNo: { deliveryTicketId: id, episodeNo } },
            create: { deliveryTicketId: id, episodeNo, ...data, createdAt: now },
            update: data,
          });
        }
        return finish(tx, deps, ctx, staff, t, p, body.coverFileId, "replace");
      }, options);
      return {
        ...(options.idem?.replayed ? view : await sign(view)),
        replayed: options.idem?.replayed ?? false,
      };
    },
    import: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: PublishListImportBody,
      options: DeliveryWriteOptions = {},
    ) => {
      assertPermission(staff, "publish.list.edit", deps.clock.now());
      const body = PublishListImportBodySchema.parse(input);
      const result = await deps.tx.run(async (tx) => {
        const { t, p } = await editable(tx, staff, id, body.lockVersion),
          now = deps.clock.now();
        const { rows } = parsePublishListImport(
          body.content,
          body.format,
          t.orderItem.episodeCount,
        );
        const updatedEpisodeNos: number[] = [];
        for (const row of rows) {
          const { episodeNo } = row;
          const patch = {
            ...(row.highlight !== undefined ? { highlight: row.highlight } : {}),
            ...(row.title !== undefined ? { title: row.title } : {}),
            ...(row.topics !== undefined ? { topics: row.topics } : {}),
            ...(row.intro !== undefined ? { intro: row.intro } : {}),
          };
          const previous = await tx.publishListEpisode.findUnique({
            where: { deliveryTicketId_episodeNo: { deliveryTicketId: id, episodeNo } },
          });
          if (
            Object.entries(patch).some(
              ([key, value]) =>
                JSON.stringify(
                  previous?.[key as keyof typeof patch] ?? (key === "topics" ? [] : null),
                ) !== JSON.stringify(value),
            )
          )
            updatedEpisodeNos.push(episodeNo);
          await tx.publishListEpisode.upsert({
            where: { deliveryTicketId_episodeNo: { deliveryTicketId: id, episodeNo } },
            create: {
              deliveryTicketId: id,
              episodeNo,
              topics: [],
              ...patch,
              createdAt: now,
              updatedAt: now,
            },
            update: { ...patch, updatedAt: now },
          });
        }
        return {
          publishList: await finish(tx, deps, ctx, staff, t, p, p.coverFileId, "import"),
          importedRowCount: rows.length,
          updatedEpisodeNos: updatedEpisodeNos.sort((a, b) => a - b),
        };
      }, options);
      return {
        ...result,
        publishList: options.idem?.replayed ? result.publishList : await sign(result.publishList),
        replayed: options.idem?.replayed ?? false,
      };
    },
    merchantGet: (viewer: DeliveryViewer, id: string) => {
      assertOwner(viewer);
      return readForStore(viewer.membership, id);
    },
    portalGet: readForStore,
  };
}
export type PublishLists = ReturnType<typeof createPublishLists>;
