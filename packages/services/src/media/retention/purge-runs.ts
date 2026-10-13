import { calendarDate, dayRange, minuteOfDay } from "@liyoxi/shared/time";
import { uuidv7 } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { SweepContext } from "./sweep-context.js";
import { purgeCandidates } from "./candidates.js";

export async function lockRun(tx: Tx, id: string) {
  await tx.$queryRawUnsafe("SELECT id FROM file_purge_run WHERE id=$1::uuid FOR UPDATE", id);
  return tx.filePurgeRun.findUniqueOrThrow({ where: { id } });
}
export async function preparePurgeRun(ctx: SweepContext) {
  // 配置读不占业务TX连接，业务池max1也可运行。
  const params = await ctx.deps.retention!.sweep!.parameters();
  if (
    !["list_only", "auto"].includes(params.mode) ||
    !Number.isSafeInteger(params.maxObjects) ||
    params.maxObjects < 0 ||
    params.maxBytes < 0n
  )
    throw new TypeError("清除参数无效");
  let held: { runId: string; reasons: string[] } | undefined;
  const id = await ctx.transaction("run", async (tx) => {
    const active = await tx.filePurgeRun.findFirst({
      where: { state: "running" },
      orderBy: { id: "asc" },
    });
    if (active) return active.id;
    const approved = await tx.filePurgeRun.findFirst({
      where: { state: "approved" },
      orderBy: { id: "asc" },
    });
    const now = ctx.deps.clock.now();
    if (approved) {
      await lockRun(tx, approved.id);
      const changed = await tx.filePurgeRun.updateMany({
        where: { id: approved.id, state: "approved" },
        data: { state: "running", startedAt: now, deletedCount: 0, guardTrips: 0, updatedAt: now },
      });
      return changed.count ? approved.id : null;
    }
    if (minuteOfDay(now) < 180) return null;
    const range = dayRange(calendarDate(now));
    if (
      await tx.filePurgeRun.findFirst({
        where: { createdAt: { gte: range.start, lt: range.end } },
        select: { id: true },
      })
    )
      return null;
    const files = await purgeCandidates(tx, now, { take: 5000 });
    let bytes = 0n,
      secure = 0;
    const byCategory: Record<string, { count: number; bytes: string }> = {};
    for (const file of files) {
      if (file.sizeBytes === null) throw new TypeError("stored文件缺少字节事实");
      bytes += file.sizeBytes;
      if (file.bucket === "secure") secure++;
      const total = byCategory[file.category] ?? { count: 0, bytes: "0" };
      byCategory[file.category] = {
        count: total.count + 1,
        bytes: String(BigInt(total.bytes) + file.sizeBytes),
      };
    }
    const reasons = [
      ...(files.length > params.maxObjects ? ["max_objects"] : []),
      ...(bytes > params.maxBytes ? ["max_bytes"] : []),
      ...((byCategory.drama_master?.count ?? 0) > 100 ? ["drama_master"] : []),
      ...(secure > 50 ? ["secure"] : []),
    ];
    const state = params.mode === "list_only" ? "proposed" : reasons.length ? "held" : "running";
    const run = await tx.filePurgeRun.create({
      data: {
        id: uuidv7(),
        mode: params.mode,
        state,
        candidateIds: files.map((file) => file.id),
        candidateCount: files.length,
        candidateBytes: bytes,
        byCategory,
        heldReason: state === "held" ? reasons.join(",") : null,
        deletedCount: state === "running" ? 0 : null,
        guardTrips: state === "running" ? 0 : null,
        startedAt: state === "running" ? now : null,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (state === "held") held = { runId: run.id, reasons };
    return state === "running" ? run.id : null;
  });
  if (held)
    await ctx.deps.retention!.alerts.raise({
      rule: "purge.held",
      dimension: held.runId,
      severity: "P2",
      detail: held,
    });
  return id;
}
