import type { ReissueCreateBody, ReissueCancelBody, ReissuePublishBody } from "@liyoxi/contract";
import type { DeliveryReissue } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import type { StaffContext } from "../authz/index.js";
import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { staffBriefs, createReissueFollowUp } from "../staff/index.js";
import { readCancelZipTargets, invalidateZipBundles } from "../media/index.js";
import type { DeliveryDeps } from "./context.js";
import { checked } from "./machines.js";
import { writeDeliveryRelease, releaseAdminView } from "./packages.js";
import { publishListFacts } from "./publish-list.js";
import { productionReady, quality, unpaused } from "./quality.js";
import { dateOf, lockTickets, ticketOf } from "./repo.js";

async function reissueView(tx: Tx, r: DeliveryReissue) {
  const reason = await tx.dictItem.findUnique({
    where: { dictTypeKey_code: { dictTypeKey: "reissue_reason", code: r.reasonCode } },
  });
  const rows = await tx.episodeOutput.findMany({
    where: { deliveryReissueId: r.id },
    orderBy: [{ revisionNo: "desc" }, { id: "desc" }],
  });
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
    actions: r.status === "open" ? ["cancel", "publish"] : [],
    replacements: r.episodeNos.flatMap((n) => {
      const e = rows.find((r) => r.episodeNo === n);
      return e ? [{ episodeNo: n, episodeOutputId: e.id, status: e.status }] : [];
    }),
  };
}
async function reissueOf(tx: Tx, id: string, staff: StaffContext) {
  const r = await tx.deliveryReissue.findUnique({ where: { id } });
  if (!r) throw new AppError("NOT_FOUND");
  const first = await ticketOf(tx, r.deliveryTicketId, staff);
  await lockRows(tx, "staff", first.deliveryManagerId ? [first.deliveryManagerId] : [], "share");
  await lockTickets(tx, [r.deliveryTicketId]);
  return {
    r: await tx.deliveryReissue.findUniqueOrThrow({ where: { id } }),
    t: await ticketOf(tx, r.deliveryTicketId, staff),
  };
}
async function history(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  t: Awaited<ReturnType<typeof ticketOf>>,
  event: "reissue.opened" | "reissue.cancelled" | "package.reissued",
  r: DeliveryReissue,
) {
  await deps.flow.transition(tx, ctx, {
    machine: "delivery_ticket",
    stateField: "step",
    id: t.id,
    event,
    to: t.step,
    args: checked(),
    entityId: t.entityId,
    storeId: t.storeId,
    payload: { deliveryReissueId: r.id },
    note: r.note,
    emit: { none: true, primary: event === "reissue.opened" ? "package.reissue_opened" : event },
  });
}
export async function createReissue(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  body: ReissueCreateBody,
) {
  await ticketOf(tx, id, staff);
  await lockTickets(tx, [id]);
  const t = await ticketOf(tx, id, staff);
  unpaused(t);
  const open = await tx.deliveryReissue.findFirst({
    where: { deliveryTicketId: id, status: "open" },
  });
  const reason = !["awaiting_launch", "launch_verify", "in_service"].includes(t.step)
    ? "step"
    : calendarDate(deps.clock.now()) > dateOf(t.orderItem.usageEndDate)!
      ? "usage_ended"
      : open
        ? "open_reissue_exists"
        : null;
  if (reason)
    throw new AppError("REISSUE_NOT_ALLOWED", {
      details: { reason, openReissueId: open?.id ?? null },
    });
  if (
    !body.episodeNos.length ||
    new Set(body.episodeNos).size !== body.episodeNos.length ||
    body.episodeNos.some((n) => n < 1 || n > t.orderItem.episodeCount)
  )
    throw new AppError("VALIDATION_FAILED");
  if (
    !(await tx.dictItem.findFirst({
      where: { dictTypeKey: "reissue_reason", code: body.reasonCode, isEnabled: true },
    }))
  )
    throw new AppError("VALIDATION_FAILED");
  const now = deps.clock.now(),
    r = await tx.deliveryReissue.create({
      data: {
        id: uuidv7(),
        entityId: t.entityId,
        storeId: t.storeId,
        deliveryTicketId: id,
        status: "open",
        episodeNos: [...body.episodeNos].sort((a, b) => a - b),
        reasonCode: body.reasonCode,
        note: body.note,
        openedByStaffId: staff.staff.id,
        openedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  await history(tx, deps, ctx, t, "reissue.opened", r);
  await deps.events.emit(tx, ctx, {
    type: "package.reissue_opened",
    aggregate: { type: "delivery_reissue", id: r.id },
    entityId: t.entityId,
    storeId: t.storeId,
    payload: {
      v: 1,
      deliveryReissueId: r.id,
      deliveryTicketId: id,
      orderItemId: t.orderItemId,
      episodeNos: r.episodeNos,
      reasonCode: r.reasonCode,
    },
  });
  return reissueView(tx, r);
}
export async function cancelReissue(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  body: ReissueCancelBody,
) {
  const { r, t } = await reissueOf(tx, id, staff);
  if (
    r.openedByStaffId !== staff.staff.id &&
    !staff.staff.isLead &&
    staff.staff.roleKey !== "super_admin"
  )
    throw new AppError("PERMISSION_DENIED");
  if (r.status !== "open") throw new AppError("STATE_NOT_ALLOWED");
  const rows = await tx.episodeOutput.findMany({ where: { deliveryReissueId: id } });
  await lockRows(
    tx,
    "episode_output",
    rows.map((e) => e.id),
  );
  await tx.episodeOutput.updateMany({
    where: {
      deliveryReissueId: id,
      status: { in: ["uploaded", "qc_passed", "qc_rejected", "check_rejected"] },
    },
    data: { status: "replaced", isCurrent: false, updatedAt: deps.clock.now() },
  });
  const result = await tx.deliveryReissue.update({
    where: { id },
    data: { status: "cancelled", closedAt: deps.clock.now(), updatedAt: deps.clock.now() },
  });
  await history(tx, deps, ctx, t, "reissue.cancelled", { ...result, note: body.note ?? r.note });
  return reissueView(tx, result);
}
export async function publishReissue(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  body: ReissuePublishBody,
  key: string,
) {
  const { r, t } = await reissueOf(tx, id, staff);
  unpaused(t);
  if (r.status !== "open" || !["awaiting_launch", "launch_verify", "in_service"].includes(t.step))
    throw new AppError("STATE_NOT_ALLOWED");
  if (calendarDate(deps.clock.now()) > dateOf(t.orderItem.usageEndDate)!)
    throw new AppError("PACKAGE_PUSH_BLOCKED", {
      details: { blockers: [{ code: "usage_ended" }] },
    });
  const old = await tx.deliveryRelease.findMany({
    where: { orderItemId: t.orderItemId, state: "pushed" },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "delivery_release",
    old.map((r) => r.id),
  );
  const rows = await tx.episodeOutput.findMany({
    where: { deliveryTicketId: t.id },
    include: { file: true },
    orderBy: [{ revisionNo: "desc" }, { id: "desc" }],
  });
  await lockRows(
    tx,
    "episode_output",
    rows.map((e) => e.id),
  );
  const replacements = r.episodeNos.map((n) =>
    rows.find((e) => e.episodeNo === n && e.deliveryReissueId === id),
  );
  const missingEpisodeNos = r.episodeNos.filter(
    (_, i) => replacements[i]?.status !== "qc_passed" || !replacements[i]?.qcRecordId,
  );
  if (missingEpisodeNos.length)
    throw new AppError("REISSUE_INCOMPLETE", { details: { missingEpisodeNos } });
  const chosen = replacements.filter((e): e is NonNullable<typeof e> => !!e);
  const zipTargets = await readCancelZipTargets(
    tx,
    old.map((r) => r.id),
  );
  await lockRows(
    tx,
    "production_record",
    chosen.map((e) => e.fileId),
    "share",
  );
  await lockRows(tx, "zip_bundle", zipTargets.zipBundleIds);
  await lockRows(tx, "file_object", [
    ...rows.filter((e) => e.isCurrent).map((e) => e.fileId),
    ...chosen.map((e) => e.fileId),
    ...zipTargets.fileObjectIds,
  ]);
  // QC status alone cannot stand in for actual production evidence and the saved pass record.
  for (const e of chosen) {
    await productionReady(tx, e.fileId, deps.media);
    const qc = await tx.qcRecord.findUnique({ where: { id: e.qcRecordId! } });
    if (
      qc?.verdict !== "pass" ||
      qc.targetType !== "episode_output" ||
      qc.targetId !== e.id ||
      qc.deliveryTicketId !== t.id
    )
      throw new AppError("REISSUE_INCOMPLETE", { details: { missingEpisodeNos: [e.episodeNo] } });
  }
  const current = rows.filter((e) => e.isCurrent),
    outputs = [...current.filter((e) => !r.episodeNos.includes(e.episodeNo)), ...chosen].sort(
      (a, b) => a.episodeNo - b.episodeNo,
    );
  if (
    current.length !== t.orderItem.episodeCount ||
    outputs.length !== t.orderItem.episodeCount ||
    new Set(outputs.map((e) => e.episodeNo)).size !== t.orderItem.episodeCount ||
    outputs.some((e) => e.status !== "qc_passed")
  )
    throw new AppError("REISSUE_INCOMPLETE", { details: { missingEpisodeNos: r.episodeNos } });
  const checklist = await quality(tx, "delivery.precheck", body.precheck, undefined, true),
    list = await publishListFacts(tx, t);
  const now = deps.clock.now();
  await tx.episodeOutput.updateMany({
    where: {
      id: { in: current.filter((e) => r.episodeNos.includes(e.episodeNo)).map((e) => e.id) },
    },
    data: { status: "replaced", isCurrent: false, updatedAt: now },
  });
  await tx.episodeOutput.updateMany({
    where: { id: { in: chosen.map((e) => e.id) } },
    data: { isCurrent: true, updatedAt: now },
  });
  const { release, expiresAt } = await writeDeliveryRelease(
    tx,
    deps,
    staff,
    t,
    outputs,
    checklist,
    list,
    key,
    old,
    {
      kind: "reissue",
      changedEpisodeNos: r.episodeNos,
      reasonCode: r.reasonCode,
      note: body.note ?? r.note,
    },
  );
  await invalidateZipBundles(tx, zipTargets, now);
  await tx.publishListEpisode.updateMany({
    where: { deliveryTicketId: t.id, episodeNo: { in: r.episodeNos } },
    data: { changedInReleaseNo: release.releaseNo, updatedAt: now },
  });
  const result = await tx.deliveryReissue.update({
    where: { id },
    data: {
      status: "published",
      publishedDeliveryReleaseId: release.id,
      closedAt: now,
      updatedAt: now,
    },
  });
  if (t.launchTasks.some((l) => l.isLive) && t.deliveryManagerId)
    await createReissueFollowUp(tx, deps.assembly, {
      reissueId: id,
      ownerStaffId: t.deliveryManagerId,
      now,
    });
  await lockRows(
    tx,
    "file_object",
    outputs.map((e) => e.fileId),
  );
  for (const e of outputs)
    await deps.media.link(tx, {
      fileId: e.fileId,
      entityId: t.entityId,
      storeId: t.storeId,
      refType: "delivery_release",
      refId: release.id,
      role: "ep",
    });
  await history(tx, deps, ctx, t, "package.reissued", result);
  await deps.events.emit(tx, ctx, {
    type: "package.reissued",
    aggregate: { type: "delivery_reissue", id },
    entityId: t.entityId,
    storeId: t.storeId,
    payload: {
      v: 1,
      deliveryReissueId: id,
      deliveryReleaseId: release.id,
      deliveryTicketId: t.id,
      orderItemId: t.orderItemId,
      episodeNos: r.episodeNos,
      grantExpiresAt: expiresAt.toISOString(),
    },
  });
  return { reissue: await reissueView(tx, result), release: await releaseAdminView(tx, release) };
}
