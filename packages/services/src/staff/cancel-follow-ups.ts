import { record } from "../audit/index.js";
import { Prisma } from "@liyoxi/db";
import type { IdentityContext, Tx } from "../kernel/index.js";

type Subject = {
  readonly subjectType: "delivery_reissue" | "patrol_task";
  readonly subjectId: string;
};
export async function readSystemFollowUpCloseTargets(
  tx: Tx,
  input: { readonly subjects: readonly Subject[] },
) {
  const rows =
    input.subjects.length === 0
      ? []
      : await tx.followUp.findMany({
          where: {
            OR: input.subjects.map((s) => ({ ...s })),
            channel: "system",
            nextFollowAt: { not: null },
            doneAt: null,
          },
          orderBy: { id: "asc" },
          select: {
            id: true,
            ownerStaffId: true,
            lockVersion: true,
            subjectType: true,
            subjectId: true,
          },
        });
  return {
    followUpIds: rows.map((r) => r.id),
    staffIds: [...new Set(rows.flatMap((r) => (r.ownerStaffId ? [r.ownerStaffId] : [])))].sort(),
    signature: JSON.stringify(rows),
  };
}

/** 由取消整图预锁阶段调用，必须在账本锁之前。 */
export async function lockSystemFollowUpCloseTargets(tx: Tx, ids: readonly string[]) {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length)
    await tx.$queryRaw(Prisma.sql`
    SELECT id FROM follow_up WHERE id IN (${Prisma.join(sorted.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY id FOR NO KEY UPDATE
  `);
}

/** 取消所属对象时关闭系统待办。调用方在账户锁前预锁目标行；人工跟进保留。 */
export async function closeSystemFollowUps(
  tx: Tx,
  ctx: IdentityContext,
  input: {
    readonly subjects: readonly Subject[];
    readonly now: Date;
  },
) {
  if (input.subjects.length === 0) return 0;
  const rows = await tx.followUp.findMany({
    where: {
      OR: input.subjects.map((s) => ({ ...s })),
      channel: "system",
      nextFollowAt: { not: null },
      doneAt: null,
    },
    orderBy: { id: "asc" },
  });
  let count = 0;
  for (const row of rows) {
    const changed = await tx.followUp.updateMany({
      where: { id: row.id, channel: "system", doneAt: null, lockVersion: row.lockVersion },
      data: {
        doneAt: input.now,
        doneNote: "关联业务已取消，关闭系统跟进",
        updatedAt: input.now,
        lockVersion: { increment: 1 },
      },
    });
    if (changed.count === 0) continue;
    count += changed.count;
    await record(
      tx,
      ctx.actor,
      {
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        sessionId: null,
        authMethod: null,
      },
      {
        stream: "activity",
        category: "follow_up",
        action: "staff.follow_up.complete",
        summary: "业务取消后关闭系统跟进",
        target: { type: "follow_up", id: row.id },
        entityId: row.entityId,
        storeId: row.storeId,
        before: { doneAt: null },
        after: { doneAt: input.now.toISOString() },
        fields: ["doneAt"],
      },
    );
  }
  return count;
}
