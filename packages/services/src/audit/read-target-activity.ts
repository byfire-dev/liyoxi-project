import { z, DramaActivityQuerySchema, ActivityItemSchema } from "@liyoxi/contract";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
const cursorSchema = z.strictObject({
  targetId: z.uuid(),
  at: z.iso.datetime(),
  seq: z
    .string()
    .regex(/^\d{1,19}$/)
    .refine((v) => BigInt(v) <= 9223372036854775807n),
});
/** Caller authorizes the target; JSON before/after, IP, credentials and access stream never leave this projection. */
export async function readTargetActivity(tx: Tx, targetId: string, raw: unknown) {
  const parsed = DramaActivityQuerySchema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION_FAILED");
  const query = parsed.data;
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor) {
    try {
      if (query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
      );
      if (cursor.targetId !== targetId) throw new Error();
    } catch {
      throw new AppError("VALIDATION_FAILED");
    }
  }
  const where = { targetType: "drama", targetId, stream: { in: ["ops", "activity"] } };
  const rows = await tx.auditLog.findMany({
    where: cursor
      ? {
          AND: [
            where,
            {
              OR: [
                { createdAt: { lt: new Date(cursor.at) } },
                { createdAt: new Date(cursor.at), seq: { lt: BigInt(cursor.seq) } },
              ],
            },
          ],
        }
      : where,
    orderBy: [{ createdAt: "desc" }, { seq: "desc" }],
    take: query.limit + 1,
  });
  const visible = rows.slice(0, query.limit),
    requests = visible.flatMap((v) => (v.requestId ? [v.requestId] : []));
  const transitions = requests.length
    ? await tx.statusTransition.findMany({
        where: { machine: "drama", subjectId: targetId, requestId: { in: requests } },
        orderBy: { seq: "desc" },
      })
    : [];
  const items = visible.map((row) => {
    const t = row.requestId ? transitions.find((v) => v.requestId === row.requestId) : undefined;
    return ActivityItemSchema.parse({
      activityId: row.id,
      occurredAt: row.createdAt.toISOString(),
      actorType: row.actorType,
      actorName: row.actorName,
      actorRole: row.actorRole,
      client: row.client,
      action: row.action,
      summary: row.summary,
      targetType: row.targetType,
      targetId: row.targetId,
      targetLabel: row.targetLabel,
      reasonText: row.reasonText,
      transition: t
        ? {
            machine: t.machine,
            stateField: t.stateField,
            fromState: t.fromState,
            toState: t.toState,
            event: t.event,
            isForced: t.isForced,
          }
        : null,
    });
  });
  const last = visible.at(-1),
    hasMore = rows.length > query.limit;
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ targetId, at: last.createdAt.toISOString(), seq: String(last.seq) }),
          ).toString("base64url")
        : null,
    totalApprox: Math.min(10000, await tx.auditLog.count({ where })),
  };
}
