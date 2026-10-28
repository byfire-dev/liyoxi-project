import type { StaffContext } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { lockTickets } from "./repo.js";
import { sampleOf } from "./samples.js";
import { unpaused } from "./quality.js";

/** 技术补排只接受当前已人工质检的样片；父域锁保持到正式媒体入队完成。 */
export async function lockCurrentSampleWatermarkTarget(tx: Tx, id: string, staff: StaffContext) {
  const first = await sampleOf(tx, id, staff);
  await lockTickets(tx, [first.t.id]);
  await lockRows(tx, "sample", [id]);
  const { s, t } = await sampleOf(tx, id, staff);
  unpaused(t);
  const latest = await tx.sample.findFirst({
    where: { deliveryTicketId: t.id },
    orderBy: { versionNo: "desc" },
    select: { id: true },
  });
  const qc = s.qcRecordId ? await tx.qcRecord.findUnique({ where: { id: s.qcRecordId } }) : null;
  if (
    t.step !== "sample_making" ||
    s.status !== "qc_passed" ||
    latest?.id !== s.id ||
    !qc ||
    qc.verdict !== "pass" ||
    qc.targetType !== "sample" ||
    qc.targetId !== s.id ||
    qc.deliveryTicketId !== t.id ||
    qc.entityId !== t.entityId ||
    qc.storeId !== t.storeId
  )
    throw new AppError("STATE_NOT_ALLOWED");
  return {
    fileId: s.fileId,
    ticketId: t.id,
    versionNo: s.versionNo,
    entityId: t.entityId,
    storeId: t.storeId,
  };
}
