// Read-only facts for this owned local M5 scope. No successful business state is prepared here.
import assert from "node:assert/strict";
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { isUuid } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { M1Scope } from "./m1-types.js";

export type M5Scope = M1Scope & {
  readonly adIds?: readonly string[];
  readonly cancelRequestId?: string;
};
export type M5FactScope = Pick<M1Scope, "entityId" | "storeId"> &
  Partial<Omit<M5Scope, "entityId" | "storeId">>;

export async function readM5Facts(tx: Tx, scope: M5FactScope) {
  const { entityId, storeId } = scope,
    owned = { entityId, storeId };
  assert.ok(isUuid(entityId) && isUuid(storeId));
  const store = await tx.store.findFirstOrThrow({
    where: { id: storeId, entityId },
    select: { id: true },
  });
  assert.equal(store.id, storeId);
  const adIds = [...(scope.adIds ?? [])];
  assert.ok(adIds.length <= 20 && adIds.every(isUuid) && new Set(adIds).size === adIds.length);
  if (scope.merchantUserId)
    assert.equal(
      await tx.entityMember.count({
        where: { entityId, merchantUserId: scope.merchantUserId, role: "owner", status: "active" },
      }),
      1,
    );
  const orders = scope.orderId
    ? await tx.dramaOrder.findMany({ where: { id: scope.orderId, ...owned } })
    : [];
  if (scope.orderId) assert.equal(orders.length, 1);
  const items = scope.orderId
    ? await tx.orderItem.findMany({
        where: { dramaOrderId: scope.orderId, ...owned },
        orderBy: { id: "asc" },
      })
    : [];
  if (scope.orderItemId) assert.ok(items.some((row) => row.id === scope.orderItemId));
  const itemIds = items.map((row) => row.id);
  const tickets = await tx.deliveryTicket.findMany({
    where: { orderItemId: { in: itemIds }, ...owned },
    orderBy: { id: "asc" },
  });
  if (scope.deliveryTicketId) assert.ok(tickets.some((row) => row.id === scope.deliveryTicketId));
  const ticketIds = tickets.map((row) => row.id);
  const ads = await tx.ad.findMany({
    where: { id: { in: adIds }, ...owned },
    orderBy: { id: "asc" },
  });
  assert.equal(ads.length, adIds.length);
  const letters = await tx.licenseLetter.findMany({
    where: { orderItemId: { in: itemIds }, ...owned },
    orderBy: { id: "asc" },
  });
  const letterIds = letters.map((row) => row.id);
  const revisions = await tx.licenseLetterRevision.findMany({
    where: { licenseLetterId: { in: letterIds } },
    orderBy: [{ licenseLetterId: "asc" }, { revNo: "asc" }],
  });
  const revisionById = new Map(revisions.map((row) => [row.id, row]));
  const queuedEvents = await tx.outboxEvent.findMany({
    where: {
      eventType: "license_letter.revision_queued",
      aggregateType: "license_letter",
      aggregateId: { in: letterIds },
      ...owned,
    },
    select: {
      id: true,
      eventType: true,
      aggregateId: true,
      payload: true,
      outboxDeliveries: {
        where: { subscriber: "docs.onRevisionQueued" },
        select: { subscriber: true, status: true, dispatchNo: true, consumedAt: true },
      },
    },
    orderBy: { id: "asc" },
  });
  // A consumed wake-up alone is insufficient. Preserve the exact queued event -> owned immutable
  // revision -> actual ready/PDF facts, so the chain can assert successful consumption and bytes.
  const docsDeliveries = queuedEvents.flatMap((event) => {
    const payload = EVENT_PAYLOAD_SCHEMAS["license_letter.revision_queued"].parse(event.payload);
    const revision = revisionById.get(payload.revisionId);
    assert.ok(revision, "M5授权排队事件必须属于本范围真实版次");
    assert.equal(payload.licenseLetterId, event.aggregateId);
    assert.equal(revision.licenseLetterId, payload.licenseLetterId);
    return event.outboxDeliveries.map((delivery) => ({
      eventId: event.id,
      eventType: event.eventType,
      licenseLetterId: revision.licenseLetterId,
      revisionId: revision.id,
      revisionRenderStatus: revision.renderStatus,
      revisionFileId: revision.fileId,
      revisionPdfSha256: revision.pdfSha256,
      revisionReadyAt: revision.readyAt,
      ...delivery,
    }));
  });
  const samples = await tx.sample.findMany({
    where: { deliveryTicketId: { in: ticketIds }, ...owned },
    orderBy: [{ deliveryTicketId: "asc" }, { versionNo: "asc" }],
  });
  const adVersions = await tx.adVersion.findMany({
    where: { adId: { in: adIds }, ...owned },
    orderBy: [{ adId: "asc" }, { versionNo: "asc" }],
  });
  const outputs = await tx.episodeOutput.findMany({
    where: { deliveryTicketId: { in: ticketIds }, ...owned },
    orderBy: [{ episodeNo: "asc" }, { revisionNo: "asc" }],
  });
  const cancelRequests = await tx.cancelRequest.findMany({
    where: {
      ...owned,
      ...(scope.cancelRequestId
        ? { id: scope.cancelRequestId }
        : {
            OR: [
              { dramaOrderId: scope.orderId ?? "00000000-0000-0000-0000-000000000000" },
              { adId: { in: adIds } },
            ],
          }),
    },
    orderBy: { id: "asc" },
  });
  if (scope.cancelRequestId) assert.equal(cancelRequests.length, 1);
  const cancelIds = cancelRequests.map((row) => row.id);
  const fileIds = [
    ...new Set([
      ...revisions.flatMap((row) => (row.fileId ? [row.fileId] : [])),
      ...samples.map((row) => row.fileId),
      ...adVersions.map((row) => row.fileId),
      ...outputs.map((row) => row.fileId),
    ]),
  ];
  const legalFileIds = revisions.flatMap((row) => (row.fileId ? [row.fileId] : []));
  const ids = [
    ...new Set([
      ...orders.map((row) => row.id),
      ...itemIds,
      ...ticketIds,
      ...adIds,
      ...cancelIds,
      ...letterIds,
      ...samples.map((row) => row.id),
      ...adVersions.map((row) => row.id),
    ]),
  ];
  return {
    wallet: await tx.billingAccount.findUniqueOrThrow({ where: { entityId } }),
    orders,
    items,
    tickets,
    ads,
    adVersions,
    samples,
    letters,
    revisions,
    docsDeliveries,
    outputs,
    holds: await tx.pointHold.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
    ledger: await tx.pointLedgerEntry.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
    operations: await tx.ledgerOperation.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
    adRevisions: await tx.adRevision.findMany({
      where: { adId: { in: adIds }, ...owned },
      orderBy: [{ adId: "asc" }, { revisionNo: "asc" }],
    }),
    placements: await tx.orderItemPlacement.findMany({
      where: { orderItemId: { in: itemIds } },
      orderBy: { id: "asc" },
    }),
    reissues: await tx.deliveryReissue.findMany({
      where: { deliveryTicketId: { in: ticketIds }, ...owned },
      orderBy: { id: "asc" },
    }),
    releases: await tx.deliveryRelease.findMany({
      where: { orderItemId: { in: itemIds }, ...owned },
      orderBy: { id: "asc" },
    }),
    downloadGrants: await tx.downloadGrant.findMany({
      where: { orderItemId: { in: itemIds }, ...owned },
      orderBy: { id: "asc" },
    }),
    downloads: await tx.deliveryDownloadLog.findMany({
      where: { orderItemId: { in: itemIds }, ...owned },
      orderBy: { id: "asc" },
    }),
    cancelRequests,
    cancelLines: await tx.cancelRequestLine.findMany({
      where: { cancelRequestId: { in: cancelIds }, ...owned },
      orderBy: { id: "asc" },
    }),
    approvals: await tx.approvalRequest.findMany({
      where: { id: { in: cancelRequests.map((row) => row.approvalRequestId) }, entityId },
      orderBy: { id: "asc" },
    }),
    files: await tx.fileObject.findMany({
      where: {
        id: { in: fileIds },
        entityId,
        OR: [
          { storeId },
          { id: { in: legalFileIds }, storeId: null, scopeType: "entity", category: "legal_doc" },
        ],
      },
      select: {
        id: true,
        category: true,
        bucket: true,
        objectKey: true,
        status: true,
        sha256: true,
        sizeBytes: true,
      },
      orderBy: { id: "asc" },
    }),
    fileRefs: await tx.fileRef.findMany({
      where: { fileId: { in: fileIds } },
      orderBy: { id: "asc" },
    }),
    history: await tx.statusTransition.findMany({
      where: { entityId, subjectId: { in: ids } },
      orderBy: { id: "asc" },
    }),
    audits: await tx.auditLog.count({ where: { entityId } }),
    events: await tx.outboxEvent.count({ where: { entityId } }),
  };
}
export type M5Facts = Awaited<ReturnType<typeof readM5Facts>>;
