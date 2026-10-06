import { ChecklistItemsSchema } from "@liyoxi/contract";
import type { LaunchTaskSubmitBody, ChannelAccountApproveBody } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { storeGate } from "../profile/index.js";
import type { PublishViewer } from "./context.js";
import { dateOf } from "./repo.js";
import type { TaskRow } from "./repo.js";
export const normalize = (s: string) => s.replace(/\s/g, "").toLowerCase();
export const invalid = (field: string, message: string) =>
  new AppError("VALIDATION_FAILED", { details: { fieldErrors: [{ path: field, message }] } });
export function owner(viewer: PublishViewer) {
  if (viewer.membership.role !== "owner" || viewer.ctx.actor.type !== "merchant")
    throw new AppError("ROLE_FORBIDDEN");
}
export async function gate(tx: Tx, storeId: string, full = false) {
  const value = await storeGate(tx, storeId);
  if (value === "blocked" || (full && value !== "full"))
    throw new AppError("STORE_NOT_QUALIFIED", {
      details: { storeId, reason: value === "parallel" ? "pending_review" : "not_verified" },
    });
}
export async function files(
  tx: Tx,
  ids: readonly string[],
  scope: { entityId: string; storeId: string },
  category: string,
  actorId?: string,
) {
  await lockRows(tx, "file_object", ids);
  for (const id of ids) {
    const f = await tx.fileObject.findUnique({ where: { id } });
    const reason =
      !f || f.status !== "stored"
        ? "not_stored"
        : f.moderationState === "block"
          ? "blocked"
          : f.category !== category
            ? "category_mismatch"
            : f.entityId !== scope.entityId ||
                f.storeId !== scope.storeId ||
                (actorId && (f.uploadActorType !== "merchant" || f.uploadActorId !== actorId))
              ? "scope_mismatch"
              : null;
    if (reason) throw new AppError("FILE_NOT_USABLE", { details: { fileIds: [id], reason } });
  }
}
export async function reasonScene(tx: Tx, codes: readonly string[], scene: string) {
  for (const code of codes) {
    const r = await tx.dictItem.findUnique({
      where: { dictTypeKey_code: { dictTypeKey: "reject_reason", code } },
    });
    if (!r?.isEnabled)
      throw new AppError("DICT_ITEM_DISABLED", { details: { dictTypeKey: "reject_reason", code } });
    if ((r.ext as { scene?: string }).scene !== scene)
      throw invalid("reasonCodes", "原因不属于本核验场景");
  }
}
export async function checklist(
  tx: Tx,
  code: string,
  versionNo: number | undefined,
  results: ChannelAccountApproveBody["results"],
  required = true,
) {
  const active = await tx.checklistTemplate.findFirst({ where: { code, status: "active" } });
  if (!active && !required) return null;
  if (!active || active.versionNo !== versionNo)
    throw new AppError("CHECKLIST_VERSION_STALE", {
      details: { code, currentVersionNo: active?.versionNo ?? null },
    });
  const items = ChecklistItemsSchema.parse(active.items),
    rows = results ?? [],
    keys = new Set(rows.map((r) => r.key));
  const missingKeys = items
    .filter((item) => item.required && !keys.has(item.key))
    .map((item) => item.key);
  const failedKeys: string[] = [],
    invalidNaKeys: string[] = [];
  for (const row of rows) {
    const item = items.find((i) => i.key === row.key);
    if (!item || row.result === "fail") failedKeys.push(row.key);
    else if (row.result === "na" && !item.allowNa) invalidNaKeys.push(row.key);
  }
  if (keys.size !== rows.length)
    failedKeys.push(
      ...rows
        .filter((row, i) => rows.findIndex((r) => r.key === row.key) !== i)
        .map((row) => row.key),
    );
  if (missingKeys.length || failedKeys.length || invalidNaKeys.length)
    throw new AppError("CHECKLIST_NOT_PASSED", {
      details: { missingKeys, failedKeys: [...new Set(failedKeys)], invalidNaKeys },
    });
  return { code, versionNo: active.versionNo, result: rows };
}
export function liveWindow(task: TaskRow, now: Date, pause = true) {
  if (pause && task.deliveryTicket.pauseCount > 0)
    throw new AppError("TICKET_ON_HOLD", {
      details: {
        reasons: task.deliveryTicket.deliveryTicketPauses
          .filter((p) => !p.releasedAt)
          .map((p) => p.reason),
      },
    });
  if (!["awaiting_launch", "launch_verify", "in_service"].includes(task.deliveryTicket.step))
    throw new AppError("STATE_NOT_ALLOWED");
  if (pause && calendarDate(now) > dateOf(task.orderItem.usageEndDate)!)
    throw new AppError("LAUNCH_WINDOW_CLOSED", {
      details: { usageEndDate: dateOf(task.orderItem.usageEndDate) },
    });
}
export function submittedLinks(task: TaskRow, body: LaunchTaskSubmitBody, now: Date) {
  liveWindow(task, now);
  if (
    !["pending", "need_fix", "passed"].includes(task.reviewStatus) ||
    (task.reviewStatus === "passed" && task.verifiedEpisodeCount >= task.orderItem.episodeCount)
  )
    throw new AppError("STATE_NOT_ALLOWED");
  const bad = (field: string, reason: string) =>
    new AppError("LINK_INVALID", { details: { field, reason } });
  const url = (value: string, field: string) => {
    if (value.length > 2000) throw bad(field, "too_long");
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw bad(field, "unparsable");
    }
    if (parsed.protocol !== "https:") throw bad(field, "not_https");
    if (parsed.username || parsed.password) throw bad(field, "has_credentials");
  };
  if (body.linkKind === "collection") {
    if (!body.collectionUrl || body.episodeUrls?.length)
      throw invalid("collectionUrl", "合集回填只填写合集链接");
    url(body.collectionUrl, "collectionUrl");
  } else {
    if (!body.episodeUrls?.length || body.collectionUrl)
      throw invalid("episodeUrls", "逐集回填只填写逐集链接");
    const keys = new Set<number>();
    for (const [i, ep] of body.episodeUrls.entries()) {
      if (keys.has(ep.episodeNo)) throw bad(`episodeUrls.${i}.episodeNo`, "duplicate_episode");
      keys.add(ep.episodeNo);
      if (ep.episodeNo < 1 || ep.episodeNo > task.orderItem.episodeCount)
        throw bad(`episodeUrls.${i}.episodeNo`, "episode_out_of_range");
      url(ep.url, `episodeUrls.${i}.url`);
    }
  }
  const min = Math.max(1, task.verifiedEpisodeCount),
    max = task.orderItem.episodeCount;
  if (body.reportedEpisodeCount < min || body.reportedEpisodeCount > max)
    throw new AppError("LAUNCH_SUBMISSION_OUT_OF_RANGE", {
      details: { field: "reportedEpisodeCount", min, max },
    });
  const earliest = task.deliveryTicket.deliveredAt
      ? calendarDate(task.deliveryTicket.deliveredAt)
      : null,
    latest = [calendarDate(now), dateOf(task.orderItem.usageEndDate)!].sort()[0]!;
  if (!earliest) throw new AppError("STATE_NOT_ALLOWED");
  if (body.actualLaunchDate < earliest || body.actualLaunchDate > latest)
    throw new AppError("LAUNCH_SUBMISSION_OUT_OF_RANGE", {
      details: { field: "actualLaunchDate", min: earliest, max: latest },
    });
}
