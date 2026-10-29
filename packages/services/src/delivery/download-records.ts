import { DownloadHistorySchema } from "@liyoxi/contract";
import type { DownloadRecordQuery } from "@liyoxi/contract";
import { assertAccess } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Clock, Tx, TxRunner } from "../kernel/index.js";
import { staffBriefs } from "../staff/index.js";
import { readAssetMerchantUploader } from "../tenant/index.js";
import { releaseAdminView } from "./packages.js";
import { ticketOf } from "./repo.js";

/** Historical authorizations are evidence only; no signed address is projected. */
export async function downloadRecords(
  tx: Tx,
  now: Date,
  staff: StaffContext,
  orderItemId: string,
  query: DownloadRecordQuery,
) {
  assertAccess(staff, { module: { module: "delivery", need: "view" }, permission: null });
  const parent = await tx.deliveryTicket.findUnique({
    where: { orderItemId },
    select: { id: true },
  });
  if (!parent) throw new AppError("NOT_FOUND");
  const t = await ticketOf(tx, parent.id, staff);
  if (
    t.orderItem.entityId !== t.entityId ||
    t.orderItem.storeId !== t.storeId ||
    t.orderItem.dramaOrderId !== t.dramaOrderId
  )
    throw new AppError("NOT_FOUND");
  const own = { orderItemId, entityId: t.entityId, storeId: t.storeId };
  const where = {
    ...own,
    ...(query.kind === undefined ? {} : { kind: query.kind }),
    ...(query.episodeNo === undefined ? {} : { episodeNo: query.episodeNo }),
  };
  const [releases, grants, logs, total] = await Promise.all([
    tx.deliveryRelease.findMany({ where: own, orderBy: [{ releaseNo: "desc" }, { id: "desc" }] }),
    tx.downloadGrant.findMany({ where: own, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    tx.deliveryDownloadLog.findMany({
      where,
      orderBy: { seq: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    tx.deliveryDownloadLog.count({ where }),
  ]);
  const staffNames = await staffBriefs(
    tx,
    logs.filter((l) => l.actorType === "staff").map((l) => l.actorId),
  );
  return DownloadHistorySchema.parse({
    releases: await Promise.all(releases.map((r) => releaseAdminView(tx, r))),
    grants: grants.map((g) => ({
      downloadGrantId: g.id,
      deliveryReleaseId: g.deliveryReleaseId,
      state: g.state,
      expiresAt: g.expiresAt.toISOString(),
      isExpired: now >= g.expiresAt,
      validDays: g.validDays,
      actorType: g.actorType,
      client: g.client,
      revokeReason: g.revokeReason,
      endedAt: g.endedAt?.toISOString() ?? null,
      createdAt: g.createdAt.toISOString(),
    })),
    logs: {
      items: await Promise.all(
        logs.map(async (l) => ({
          downloadId: l.id,
          deliveryReleaseId: l.deliveryReleaseId,
          kind: l.kind,
          episodeNo: l.episodeNo,
          actorType: l.actorType,
          actorName:
            l.actorType === "staff"
              ? (staffNames.find((s) => s.staffId === l.actorId)?.name ?? null)
              : l.actorType === "merchant"
                ? await readAssetMerchantUploader(tx, {
                    entityId: t.entityId,
                    merchantUserId: l.actorId,
                  })
                : null,
          client: l.client,
          urlTtlSec: l.urlTtlSec,
          clientAck: l.clientAck,
          clientAckAt: l.clientAckAt?.toISOString() ?? null,
          createdAt: l.createdAt.toISOString(),
        })),
      ),
      total,
      page: query.page,
      pageSize: query.pageSize,
    },
  });
}

export function createDownloadRecords(deps: { tx: TxRunner; clock: Clock }) {
  return {
    list: (staff: StaffContext, id: string, query: DownloadRecordQuery) =>
      deps.tx.run((tx) => downloadRecords(tx, deps.clock.now(), staff, id, query)),
  };
}
export type DownloadRecords = ReturnType<typeof createDownloadRecords>;
