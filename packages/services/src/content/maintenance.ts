import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { addDays, calendarDate, dayRange, parseLocalDate } from "@liyoxi/shared/time";
import { boundary } from "@liyoxi/shared/period";
import { record } from "../audit/index.js";
import { lockRows, createIdentityContext } from "../kernel/index.js";
import type { Clock, DeliveredEvent, RecurringRunContext, Tx } from "../kernel/index.js";
import {
  dramaMediaReadiness,
  readCommittedDramaMasters,
  readDramaPosterFileIds,
  readDramaEvidenceRefs,
} from "../media/index.js";
import type { Media } from "../media/index.js";
import type { DramaUsage } from "./ports.js";

export function createContentMaintenance(deps: {
  clock: Clock;
  usage: DramaUsage;
  media: Pick<Media, "retireDramaMedia" | "release">;
}) {
  const active = (ctx: RecurringRunContext) => {
    ctx.signal?.throwIfAborted();
    if (!ctx.runTx) throw new TypeError("content maintenance requires leased runTx");
    return ctx.runTx;
  };
  async function onMastersChanged(tx: Tx, event: DeliveredEvent) {
    const input = EVENT_PAYLOAD_SCHEMAS["drama.masters_changed"].parse(event.payload);
    await lockRows(tx, "drama", [input.dramaId]);
    const drama = await tx.drama.findUnique({ where: { id: input.dramaId } });
    if (!drama || drama.archivedAt) return;
    const changed = await readCommittedDramaMasters(tx, input);
    if (!changed?.masters.length) return;
    const now = deps.clock.now();
    for (const master of changed.masters)
      await tx.dramaEpisode.updateMany({
        where: { dramaId: drama.id, episodeNo: master.episodeNo },
        data: { durationMs: master.durationMs, updatedAt: now },
      });
    await tx.drama.update({
      where: { id: drama.id },
      data: {
        lockVersion: { increment: 1 },
        updatedAt: now,
        ...(changed.isContentChanged ? { isPermitRecheckRequired: true } : {}),
      },
    });
  }
  async function onTrailerReady(tx: Tx, event: DeliveredEvent) {
    const input = EVENT_PAYLOAD_SCHEMAS["drama.trailer_ready"].parse(event.payload);
    await lockRows(tx, "drama", [input.dramaId]);
    const drama = await tx.drama.findUnique({ where: { id: input.dramaId } });
    if (!drama || drama.archivedAt) return;
    const facts = await dramaMediaReadiness(
      tx,
      {
        dramaId: drama.id,
        totalEpisodes: drama.totalEpisodes,
        posterFileId: drama.posterFileId,
        episodeNos: [],
      },
      deps.clock.now(),
    );
    const trailer = facts.trailer;
    if (
      !trailer ||
      trailer.pointer.targetPlayableAssetId !== input.playableAssetId ||
      trailer.pointer.currentPlayableAssetId !== input.playableAssetId ||
      trailer.target.state !== "ready"
    )
      return;
    await tx.drama.update({
      where: { id: drama.id },
      data: { lockVersion: { increment: 1 }, updatedAt: deps.clock.now() },
    });
  }
  async function refreshStats(ctx: RecurringRunContext) {
    const runTx = active(ctx),
      at = deps.clock.now();
    let after: string | undefined,
      refreshed = 0;
    for (;;) {
      active(ctx);
      const ids = await runTx(async (tx) =>
        (
          await tx.drama.findMany({
            where: after ? { id: { gt: after } } : {},
            select: { id: true },
            orderBy: { id: "asc" },
            take: 100,
          })
        ).map((v) => v.id),
      );
      if (!ids.length) break;
      await runTx(async (tx) => {
        active(ctx);
        const counts = await deps.usage.stats(tx, ids, at);
        for (const id of ids) {
          active(ctx);
          const values = counts.get(id);
          if (!values) throw new TypeError("DramaUsagePort omitted a requested drama");
          await tx.dramaStat.upsert({
            where: { dramaId: id },
            create: { dramaId: id, ...values, refreshedAt: at, createdAt: at, updatedAt: at },
            update: { ...values, refreshedAt: at, updatedAt: at },
          });
        }
      });
      refreshed += ids.length;
      after = ids.at(-1);
    }
    return { refreshed };
  }
  async function archiveSweep(ctx: RecurringRunContext) {
    const runTx = active(ctx),
      at = deps.clock.now(),
      today = calendarDate(at);
    let after: string | undefined,
      archived = 0,
      failed = 0;
    for (;;) {
      active(ctx);
      const ids = await runTx(async (tx) =>
        (
          await tx.drama.findMany({
            where: {
              status: "delisted",
              archivedAt: null,
              ...(after ? { id: { gt: after } } : {}),
              dramaCopyrights: { some: { licenseEndDate: { lt: new Date(today + "T00:00:00Z") } } },
            },
            select: { id: true },
            orderBy: { id: "asc" },
            take: 100,
          })
        ).map((v) => v.id),
      );
      if (!ids.length) break;
      for (const id of ids) {
        active(ctx);
        try {
          const changed = await runTx(async (tx) => {
            await lockRows(tx, "drama", [id]);
            active(ctx);
            const row = await tx.drama.findUnique({
              where: { id },
              include: { dramaCopyrights: true },
            });
            const end = row?.dramaCopyrights[0]?.licenseEndDate;
            if (
              !row ||
              row.status !== "delisted" ||
              row.archivedAt ||
              !end ||
              end.toISOString().slice(0, 10) >= today ||
              (await deps.usage.hasOpenItems(tx, id))
            )
              return false;
            active(ctx);
            await tx.drama.update({
              where: { id },
              data: { archivedAt: at, lockVersion: { increment: 1 }, updatedAt: at },
            });
            const posters = await readDramaPosterFileIds(tx, id);
            const [permits, revisions] = await Promise.all([
              tx.dramaPermit.findMany({ where: { dramaId: id }, select: { id: true } }),
              tx.dramaCopyrightRevision.findMany({ where: { dramaId: id }, select: { id: true } }),
            ]);
            const evidence = await readDramaEvidenceRefs(tx, {
              dramaId: id,
              permitIds: permits.map((v) => v.id),
              copyrightRevisionIds: revisions.map((v) => v.id),
            });
            await lockRows(tx, "file_object", [
              ...posters,
              ...evidence.map((v) => v.fileId),
              ...(
                await dramaMediaReadiness(
                  tx,
                  {
                    dramaId: id,
                    totalEpisodes: row.totalEpisodes,
                    posterFileId: row.posterFileId,
                    episodeNos: [],
                  },
                  at,
                )
              ).allMasterFileIds,
            ]);
            await deps.media.retireDramaMedia(tx, id, { scope: "masters" });
            for (const fileId of posters)
              await deps.media.release(tx, {
                fileId,
                refType: "drama",
                refId: id,
                role: "poster",
                entityId: null,
                storeId: null,
                keepUntil: new Date(at.getTime() + 90 * 86400000),
              });
            const proofStart = addDays(end.toISOString().slice(0, 10), 1);
            const proofKeepUntil = dayRange(
              boundary(proofStart, parseLocalDate(proofStart).day, 36),
            ).start;
            for (const ref of evidence)
              await deps.media.release(tx, {
                ...ref,
                entityId: null,
                storeId: null,
                keepUntil: proofKeepUntil,
              });
            const identity = createIdentityContext({
              actor: { type: "system", job: "content.archive_sweep" },
            });
            await record(
              tx,
              identity.actor,
              {
                requestId: identity.requestId,
                ip: null,
                userAgent: null,
                authMethod: null,
                sessionId: null,
                jobName: "content.archive_sweep",
              },
              {
                stream: "activity",
                category: "flow",
                action: "content.drama.archive",
                summary: "授权及使用期结束，归档短剧",
                target: { type: "drama", id },
                before: { archivedAt: null },
                after: { archivedAt: at.toISOString() },
                fields: ["archivedAt"],
              },
            );
            return true;
          });
          if (changed) archived++;
        } catch (error) {
          active(ctx);
          failed++;
          if (!(error instanceof Error)) throw error;
        }
      }
      after = ids.at(-1);
    }
    if (failed) throw new Error(`content.archive_sweep failed ${failed} subjects`);
    return { archived };
  }
  return { onMastersChanged, onTrailerReady, refreshStats, archiveSweep };
}
export type ContentMaintenance = ReturnType<typeof createContentMaintenance>;
