import type { DeliveryReissue } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import { hasPermission, satisfiesLevel } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import type { Tx } from "../kernel/index.js";
import { staffBriefs } from "../staff/index.js";
import type { DeliveryDeps } from "./context.js";
import type { TicketRow } from "./repo.js";

/** Shared by the existing write responses and ticket GET; no locks, writes or signed URLs. */
export async function reissueView(
  tx: Tx,
  deps: Pick<DeliveryDeps, "media">,
  t: TicketRow,
  r: DeliveryReissue,
  staff: StaffContext,
  now: Date,
) {
  const reason = await tx.dictItem.findUnique({
    where: { dictTypeKey_code: { dictTypeKey: "reissue_reason", code: r.reasonCode } },
  });
  const rows = await tx.episodeOutput.findMany({
    where: { deliveryReissueId: r.id },
    include: { qcRecord: true },
    orderBy: [{ revisionNo: "desc" }, { id: "desc" }],
  });
  const replacements = r.episodeNos.flatMap((n) => {
    const e = rows.find((row) => row.episodeNo === n);
    return e ? [e] : [];
  });
  const actions: string[] = [];
  if (r.status === "open" && satisfiesLevel(staff.moduleLevels.delivery, "view")) {
    if (
      satisfiesLevel(staff.moduleLevels.delivery, "edit") &&
      hasPermission(staff, "delivery.package.reissue") &&
      (r.openedByStaffId === staff.staff.id ||
        staff.staff.isLead ||
        staff.staff.roleKey === "super_admin")
    )
      actions.push("cancel");
    const outputs = [
      ...t.episodeOutputs.filter((e) => !r.episodeNos.includes(e.episodeNo)),
      ...replacements,
    ];
    if (
      satisfiesLevel(staff.moduleLevels.publish, "edit") &&
      hasPermission(staff, "publish.package.push") &&
      !t.pauseCount &&
      ["awaiting_launch", "launch_verify", "in_service"].includes(t.step) &&
      calendarDate(now) <= t.orderItem.usageEndDate.toISOString().slice(0, 10) &&
      r.episodeNos.length > 0 &&
      replacements.length === r.episodeNos.length &&
      replacements.every(
        (e) =>
          e.deliveryTicketId === t.id &&
          e.status === "qc_passed" &&
          e.qcRecord?.verdict === "pass" &&
          e.qcRecord.targetType === "episode_output" &&
          e.qcRecord.targetId === e.id &&
          e.qcRecord.deliveryTicketId === t.id,
      ) &&
      t.episodeOutputs.length === t.orderItem.episodeCount &&
      outputs.length === t.orderItem.episodeCount &&
      new Set(outputs.map((e) => e.episodeNo)).size === t.orderItem.episodeCount &&
      outputs.every((e) => e.status === "qc_passed")
    ) {
      const production = await Promise.all(
        replacements.map((e) => deps.media.deliveryProductionFacts(tx, e.fileId)),
      );
      if (production.every((facts) => facts.ready && facts.production)) actions.push("publish");
    }
  }
  return {
    reissueId: r.id,
    deliveryTicketId: r.deliveryTicketId,
    status: r.status,
    episodeNos: r.episodeNos,
    reason: { code: r.reasonCode, name: reason?.name ?? r.reasonCode },
    note: r.note,
    openedBy: (await staffBriefs(tx, [r.openedByStaffId]))[0]!,
    openedAt: r.openedAt.toISOString(),
    closedAt: r.closedAt?.toISOString() ?? null,
    publishedDeliveryReleaseId: r.publishedDeliveryReleaseId,
    actions,
    replacements: replacements.map((e) => ({
      episodeNo: e.episodeNo,
      episodeOutputId: e.id,
      status: e.status,
    })),
  };
}
