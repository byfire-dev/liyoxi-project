import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import type { ProductionRecord } from "@liyoxi/db";
import { AppError, createIdentityContext, lockRows } from "../kernel/index.js";
import type { Clock, DeliveredEvent, Tx } from "../kernel/index.js";
import type { Flow } from "../flow/index.js";
import type { Media } from "../media/index.js";
import { checked } from "./machines.js";
import { lockTickets, ticketOf } from "./repo.js";
import type { TicketRow } from "./repo.js";
import type { AdsUsed } from "./samples.js";

export interface ProductionCheckedDeps {
  readonly clock: Clock;
  readonly flow: Flow;
  readonly media: Pick<Media, "deliveryProductionFacts" | "release" | "link">;
}
async function belongs(tx: Tx, record: ProductionRecord, t: TicketRow, episodeNo: number) {
  if (
    record.orderItemId !== t.orderItemId ||
    record.episodeNo !== episodeNo ||
    record.variant !== "common" ||
    record.productionTier !== t.orderItem.productionModel ||
    ["archived", "terminated"].includes(t.step)
  )
    return false;
  const drama = await tx.drama.findUnique({
    where: { id: t.dramaId },
    select: { isAiGenerated: true },
  });
  const ai = record.aiUsage;
  if (
    !drama ||
    (drama.isAiGenerated &&
      (!ai || typeof ai !== "object" || Array.isArray(ai) || ai.used !== true))
  )
    return false;
  if (record.dramaEpisodeMasterId) {
    const master = await tx.dramaEpisodeMaster.findUnique({
      where: { id: record.dramaEpisodeMasterId },
    });
    if (!master || master.dramaId !== t.dramaId || master.episodeNo !== episodeNo) return false;
  }
  for (const [slot, versionId] of [
    ["opening", record.headAdVersionId],
    ["ending", record.tailAdVersionId],
  ] as const) {
    const placement = t.orderItem.orderItemPlacements.find((p) => p.slot === slot);
    if (!placement) {
      if (versionId) return false;
      continue;
    }
    const version = versionId ? await tx.adVersion.findUnique({ where: { id: versionId } }) : null;
    if (
      !version ||
      version.adId !== placement.adId ||
      version.versionNo !== (placement.boundVersionNo ?? placement.ad.confirmedVersionNo)
    )
      return false;
  }
  return true;
}
export function createProductionChecked(deps: ProductionCheckedDeps) {
  return async (tx: Tx, event: DeliveredEvent): Promise<void> => {
    if (event.type !== "media.production.checked") return;
    const parsed = EVENT_PAYLOAD_SCHEMAS["media.production.checked"].safeParse(event.payload);
    if (!parsed.success || parsed.data.kind === "ad") return;
    const { fileId } = parsed.data;
    const first = await tx.productionRecord.findUnique({ where: { fileId } });
    const sourceId = first?.source === "restamped" ? first.derivedFromFileId : null;
    const fileIds = [fileId, ...(sourceId ? [sourceId] : [])];
    const [samples, episodes] = await Promise.all([
      tx.sample.findMany({ where: { fileId: { in: fileIds }, status: "uploaded" } }),
      tx.episodeOutput.findMany({ where: { fileId: { in: fileIds }, status: "uploaded" } }),
    ]);
    const ticketIds = [...new Set([...samples, ...episodes].map((row) => row.deliveryTicketId))];
    if (!ticketIds.length) return;
    const tickets = await tx.deliveryTicket.findMany({
      where: { id: { in: ticketIds } },
      select: { dramaId: true },
    });
    await lockRows(
      tx,
      "drama",
      tickets.map((t) => t.dramaId),
      "share",
    );
    await lockTickets(tx, ticketIds);
    await lockRows(
      tx,
      "episode_output",
      episodes.map((row) => row.id),
    );
    await lockRows(
      tx,
      "sample",
      samples.map((row) => row.id),
    );
    await lockRows(tx, "production_record", fileIds, "share");
    await lockRows(tx, "file_object", fileIds);
    const facts = await deps.media.deliveryProductionFacts(tx, fileId),
      record = facts.production;
    // Payload gate/duration are notification hints; the actual current media result decides.
    if (
      !facts.valid ||
      !record ||
      record.kind !== parsed.data.kind ||
      record.orderItemId !== parsed.data.orderItemId ||
      !["pass", "reject"].includes(facts.gate ?? "")
    )
      return;
    if (record.derivedFromFileId !== first?.derivedFromFileId) throw new AppError("BUSY");
    if (facts.gate === "reject" && facts.awaitingRestamp) return;
    const relatedSource =
      facts.automaticRestamp &&
      record.source === "restamped" &&
      record.derivedFromFileId === sourceId;
    const now = deps.clock.now();
    const ctx = createIdentityContext({
      actor: { type: "system", job: "media.production.checked" },
    });
    const retain = async (refType: string, refId: string, retainedFileId = fileId) =>
      deps.media.release(tx, {
        fileId: retainedFileId,
        refType,
        refId,
        role: "main",
        entityId: facts.file.entityId,
        storeId: facts.file.storeId,
        keepUntil: new Date(now.getTime() + 30 * 86_400_000),
      });
    const replace = async (refType: string, refId: string, oldFileId: string) => {
      await deps.media.link(tx, {
        fileId,
        refType,
        refId,
        role: "main",
        entityId: facts.file.entityId,
        storeId: facts.file.storeId,
      });
      await retain(refType, refId, oldFileId);
    };
    for (const before of samples) {
      const s = await tx.sample.findUniqueOrThrow({ where: { id: before.id } });
      if (
        s.status !== "uploaded" ||
        (s.fileId !== fileId && !(relatedSource && s.fileId === sourceId)) ||
        record.kind !== "sample"
      )
        continue;
      const t = await ticketOf(tx, s.deliveryTicketId);
      const latest = await tx.sample.aggregate({
        where: { deliveryTicketId: t.id },
        _max: { versionNo: true },
      });
      if (
        s.versionNo !== latest._max.versionNo ||
        s.entityId !== facts.file.entityId ||
        s.storeId !== facts.file.storeId ||
        !(await belongs(tx, record, t, 1))
      )
        continue;
      const ads = s.adVersionsUsed as AdsUsed;
      const versions = await tx.adVersion.findMany({
        where: {
          id: {
            in: [record.headAdVersionId, record.tailAdVersionId].filter((id): id is string => !!id),
          },
        },
      });
      if (ads.some((a) => !versions.some((v) => v.adId === a.adId && v.versionNo === a.versionNo)))
        continue;
      if (facts.gate === "pass") {
        if (facts.ready) {
          if (s.fileId !== fileId) await replace("sample", s.id, s.fileId);
          await tx.sample.update({
            where: { id: s.id },
            data: { fileId, durationMs: facts.durationMs, updatedAt: now },
          });
        }
      } else {
        await deps.flow.transition(tx, ctx, {
          machine: "sample",
          stateField: "status",
          id: s.id,
          event: "sample.check_rejected",
          args: checked(),
          entityId: s.entityId,
          storeId: s.storeId,
          payload: { versionNo: s.versionNo },
          emit: {
            type: "sample.check_rejected",
            payload: {
              v: 1,
              sampleId: s.id,
              deliveryTicketId: t.id,
              dramaOrderId: t.dramaOrderId,
              versionNo: s.versionNo,
            },
          },
        });
        await retain("sample", s.id, s.fileId);
      }
    }
    for (const before of episodes) {
      const e = await tx.episodeOutput.findUniqueOrThrow({ where: { id: before.id } });
      if (
        e.status !== "uploaded" ||
        (e.fileId !== fileId && !(relatedSource && e.fileId === sourceId)) ||
        (record.kind === "sample" && e.source !== "sample_adopted")
      )
        continue;
      const t = await ticketOf(tx, e.deliveryTicketId);
      const latest = await tx.episodeOutput.aggregate({
        where: {
          deliveryTicketId: t.id,
          episodeNo: e.episodeNo,
          variant: e.variant,
          deliveryReissueId: e.deliveryReissueId,
        },
        _max: { revisionNo: true },
      });
      if (
        e.revisionNo !== latest._max.revisionNo ||
        e.entityId !== facts.file.entityId ||
        e.storeId !== facts.file.storeId ||
        !(await belongs(tx, record, t, e.episodeNo))
      )
        continue;
      if (facts.gate === "pass") {
        if (facts.ready) {
          if (e.fileId !== fileId) await replace("episode_output", e.id, e.fileId);
          await tx.episodeOutput.update({
            where: { id: e.id },
            data: {
              fileId,
              sizeBytes: facts.file.sizeBytes!,
              durationMs: facts.durationMs,
              source: e.source === "sample_adopted" ? e.source : record.source,
              updatedAt: now,
            },
          });
        }
      } else {
        const changed = await tx.episodeOutput.updateMany({
          where: { id: e.id, status: "uploaded", fileId: e.fileId },
          data: {
            status: "check_rejected",
            isCurrent: false,
            updatedAt: now,
          },
        });
        if (changed.count) await retain("episode_output", e.id, e.fileId);
      }
    }
  };
}
