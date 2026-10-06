import { ChecklistItemsSchema } from "@liyoxi/contract";
import type { PushPackageBody } from "@liyoxi/contract";
import type { DeliveryRelease } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import { paramsAt } from "../config/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { staffBriefs } from "../staff/index.js";
import type { DeliveryDeps } from "./context.js";
import { lockTickets, ticketOf, dateOf, iso } from "./repo.js";
import { quality, unpaused } from "./quality.js";
import { publishListFacts } from "./publish-list.js";
import { licenseReady, step } from "./reevaluate.js";
import { orderSidePort } from "./ports.js";
export async function releaseAdminView(tx: Tx, r: DeliveryRelease) {
  const tpl = await tx.checklistTemplate.findUnique({
      where: { code_versionNo: { code: r.checklistCode, versionNo: r.checklistVersionNo } },
    }),
    defs = tpl ? ChecklistItemsSchema.parse(tpl.items) : [],
    results = r.precheckResults as Array<{ key: string; result: string; note?: string | null }>,
    saved = await tx.deliveryDownloadLog.findMany({
      where: { deliveryReleaseId: r.id, clientAck: "saved" },
      select: { episodeNo: true },
    }),
    reason = r.reasonCode
      ? await tx.dictItem.findUnique({
          where: { dictTypeKey_code: { dictTypeKey: "reissue_reason", code: r.reasonCode } },
        })
      : null;
  return {
    deliveryReleaseId: r.id,
    releaseNo: r.releaseNo,
    kind: r.kind,
    state: r.state,
    variant: r.variant,
    episodeCount: r.episodeCount,
    totalBytes: r.totalBytes.toString(),
    changedEpisodeNos: r.changedEpisodeNos,
    precheck: results.map((row) => ({
      ...row,
      note: row.note ?? null,
      label: defs.find((i) => i.key === row.key)?.label ?? row.key,
      merchantVisible: defs.find((i) => i.key === row.key)?.merchantVisible ?? false,
    })),
    reason: r.reasonCode ? { code: r.reasonCode, name: reason?.name ?? r.reasonCode } : null,
    note: r.note,
    pushedBy: (await staffBriefs(tx, [r.pushedByStaffId]))[0]!,
    pushedAt: iso(r.pushedAt)!,
    supersededAt: iso(r.supersededAt),
    closedAt: iso(r.closedAt),
    closeReason: r.closeReason,
    savedEpisodeCount: new Set(saved.flatMap((r) => (r.episodeNo === null ? [] : [r.episodeNo])))
      .size,
  };
}
export async function pushPackage(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  b: PushPackageBody,
  key: string,
) {
  await ticketOf(tx, id, staff);
  await lockTickets(tx, [id]);
  const t = await ticketOf(tx, id, staff);
  unpaused(t);
  if (t.step !== "delivering") throw new AppError("STATE_NOT_ALLOWED");
  // 190 在 210/220/230 之前，publish 只重入这组真实账号与父锁。
  await lockRows(
    tx,
    "channel_account",
    t.orderItem.orderItemAccounts.map((a) => a.channelAccountId),
  );
  const old = await tx.deliveryRelease.findMany({
    where: { orderItemId: t.orderItemId, state: "pushed" },
  });
  await lockRows(
    tx,
    "delivery_release",
    old.map((r) => r.id),
  );
  const outputs = await tx.episodeOutput.findMany({
    where: { deliveryTicketId: id, isCurrent: true },
    include: { file: true },
    orderBy: { episodeNo: "asc" },
  });
  await lockRows(
    tx,
    "episode_output",
    outputs.map((e) => e.id),
  );
  const accounts = await tx.channelAccount.findMany({
    where: { id: { in: t.orderItem.orderItemAccounts.map((a) => a.channelAccountId) } },
  });
  const checklist = await quality(tx, "delivery.precheck", { ...b.precheck }, undefined, true),
    list = await publishListFacts(tx, t),
    blockers: Array<{
      code: string;
      episodeNos?: number[];
      channelAccountId?: string;
      checklistKeys?: string[];
    }> = [];
  const missing = Array.from({ length: t.orderItem.episodeCount }, (_, i) => i + 1).filter(
    (n) => !outputs.some((e) => e.episodeNo === n && e.variant === "common"),
  );
  if (missing.length || outputs.length !== t.orderItem.episodeCount)
    blockers.push({ code: "episodes_incomplete", episodeNos: missing });
  if (outputs.some((e) => e.status !== "qc_passed"))
    blockers.push({
      code: "episode_qc_pending",
      episodeNos: outputs.filter((e) => e.status !== "qc_passed").map((e) => e.episodeNo),
    });
  if (t.qcRecords.find((q) => q.targetType === "delivery_ticket")?.verdict !== "pass")
    blockers.push({ code: "package_qc_pending" });
  if (!list.complete) blockers.push({ code: "publish_list_incomplete" });
  if (!licenseReady(t)) blockers.push({ code: "license_letter_missing" });
  if (!accounts.length) blockers.push({ code: "account_unbound" });
  for (const a of accounts) {
    if (
      a.entityId !== t.entityId ||
      a.storeId !== t.storeId ||
      !["available", "abnormal"].includes(a.status)
    )
      blockers.push({ code: "account_unbound", channelAccountId: a.id });
    if (a.status === "abnormal" && !b.ackAbnormalAccount)
      blockers.push({ code: "abnormal_account_ack_required", channelAccountId: a.id });
  }
  if (!t.orderItem.agreedLaunchDate) blockers.push({ code: "launch_date_missing" });
  if (calendarDate(deps.clock.now()) > dateOf(t.orderItem.usageEndDate)!)
    blockers.push({ code: "usage_ended" });
  if (blockers.length) throw new AppError("PACKAGE_PUSH_BLOCKED", { details: { blockers } });
  if (!deps.publish) throw new AppError("INTERNAL", { message: "真实上线任务服务尚未装配" });
  const now = deps.clock.now(),
    max = await tx.deliveryRelease.aggregate({
      where: { orderItemId: t.orderItemId },
      _max: { releaseNo: true },
    }),
    title = (t.orderItem.dramaSnapshot as { title: string }).title;
  const manifest = outputs.map((e) => ({
    episodeNo: e.episodeNo,
    outputId: e.id,
    fileId: e.fileId,
    name: `${title}_第${String(e.episodeNo).padStart(2, "0")}集.mp4`,
    size: e.sizeBytes.toString(),
    crc64: e.file.crc64,
  }));
  await tx.deliveryRelease.updateMany({
    where: { id: { in: old.map((r) => r.id) } },
    data: { state: "superseded", supersededAt: now, updatedAt: now },
  });
  const release = await tx.deliveryRelease.create({
    data: {
      id: uuidv7(),
      entityId: t.entityId,
      storeId: t.storeId,
      orderItemId: t.orderItemId,
      deliveryTicketId: id,
      releaseNo: (max._max.releaseNo ?? 0) + 1,
      kind: "initial",
      state: "pushed",
      episodeCount: t.orderItem.episodeCount,
      totalBytes: outputs.reduce((s, e) => s + e.sizeBytes, 0n),
      manifestSnapshot: manifest,
      publishListText: list.text,
      checklistCode: "delivery.precheck",
      checklistVersionNo: checklist.versionNo,
      precheckResults: checklist.results,
      note: b.note ?? null,
      pushedByStaffId: staff.staff.id,
      pushedAt: now,
      idempotencyKey: key,
      createdAt: now,
      updatedAt: now,
    },
  });
  const validDays = (await paramsAt(tx, ["package.link_ttl_days"], now))["package.link_ttl_days"],
    expiresAt = new Date(now.getTime() + validDays * 86400000);
  await tx.downloadGrant.updateMany({
    where: { orderItemId: t.orderItemId, state: "active" },
    data: { state: "superseded", endedAt: now, updatedAt: now },
  });
  await tx.downloadGrant.create({
    data: {
      id: uuidv7(),
      entityId: t.entityId,
      storeId: t.storeId,
      orderItemId: t.orderItemId,
      deliveryReleaseId: release.id,
      granteeType: "entity",
      granteeId: t.entityId,
      state: "active",
      validDays,
      expiresAt,
      actorType: "system",
      createdAt: now,
      updatedAt: now,
    },
  });
  await step(tx, deps, ctx, t, "package.pushed", "awaiting_launch", "10:182", {
    delivered_at: t.deliveredAt ?? now,
  });
  const launched = await deps.publish.createLaunchTasks(tx, ctx, {
    orderItemId: t.orderItemId,
    deliveryTicketId: id,
    channelAccountIds: accounts.map((a) => a.id),
  });
  // 全部文件先排序锁，media.link 只重入；历史 manifest 与旧包引用保持。
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
  await deps.events.emit(tx, ctx, {
    type: "package.delivered",
    aggregate: { type: "delivery_release", id: release.id },
    entityId: t.entityId,
    storeId: t.storeId,
    dedupeKey: `package.delivered:${release.id}`,
    payload: {
      v: 1,
      deliveryReleaseId: release.id,
      deliveryTicketId: id,
      orderItemId: t.orderItemId,
      episodeCount: t.orderItem.episodeCount,
      grantExpiresAt: expiresAt.toISOString(),
    },
  });
  await deps.assembly.port(orderSidePort).rederive(tx, { orderItemIds: [t.orderItemId] });
  return {
    release: await releaseAdminView(tx, release),
    grantExpiresAt: expiresAt.toISOString(),
    launchTaskCount: launched.length,
  };
}
