import { ActivityItemSchema, z } from "@liyoxi/contract";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { TicketRow } from "./repo.js";

const cursorSchema = z.strictObject({
  ticketId: z.uuid(),
  at: z.iso.datetime(),
  seq: z
    .string()
    .regex(/^\d{1,19}$/)
    .refine((v) => BigInt(v) <= 9223372036854775807n),
});
export async function ticketActivities(
  tx: Tx,
  t: TicketRow,
  query: { cursor?: string; limit: number },
) {
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor)
    try {
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
      );
      if (cursor.ticketId !== t.id) throw new Error();
    } catch {
      throw new AppError("VALIDATION_FAILED");
    }
  const targets = [{ targetType: "delivery_ticket", targetId: t.id }];
  if (t.dramaOrder.deliveryPlan)
    targets.push({ targetType: "delivery_plan", targetId: t.dramaOrder.deliveryPlan.id });
  for (const [targetType, ids] of [
    [
      "sample",
      (await tx.sample.findMany({ where: { deliveryTicketId: t.id }, select: { id: true } })).map(
        (r) => r.id,
      ),
    ],
    [
      "episode_output",
      (
        await tx.episodeOutput.findMany({ where: { deliveryTicketId: t.id }, select: { id: true } })
      ).map((r) => r.id),
    ],
    ["qc_record", t.qcRecords.map((r) => r.id)],
    [
      "delivery_release",
      (
        await tx.deliveryRelease.findMany({
          where: { deliveryTicketId: t.id },
          select: { id: true },
        })
      ).map((r) => r.id),
    ],
    [
      "delivery_reissue",
      (
        await tx.deliveryReissue.findMany({
          where: { deliveryTicketId: t.id },
          select: { id: true },
        })
      ).map((r) => r.id),
    ],
    [
      "publish_list",
      (
        await tx.publishList.findMany({ where: { deliveryTicketId: t.id }, select: { id: true } })
      ).map((r) => r.id),
    ],
  ] as const)
    for (const targetId of ids) targets.push({ targetType, targetId });
  const where = { OR: targets, stream: { in: ["ops", "activity"] } };
  const rows = await tx.auditLog.findMany({
    where: {
      AND: [
        where,
        ...(cursor
          ? [
              {
                OR: [
                  { createdAt: { lt: new Date(cursor.at) } },
                  { createdAt: new Date(cursor.at), seq: { lt: BigInt(cursor.seq) } },
                ],
              },
            ]
          : []),
      ],
    },
    orderBy: [{ createdAt: "desc" }, { seq: "desc" }],
    take: query.limit + 1,
  });
  const visible = rows.slice(0, query.limit),
    requests = visible.flatMap((r) => (r.requestId ? [r.requestId] : []));
  const transitions = await tx.statusTransition.findMany({
    where: { machine: "delivery_ticket", subjectId: t.id, requestId: { in: requests } },
    orderBy: { seq: "desc" },
  });
  const items = visible.map((r) => {
    const h = r.requestId ? transitions.find((h) => h.requestId === r.requestId) : null;
    return ActivityItemSchema.parse({
      activityId: r.id,
      occurredAt: r.createdAt.toISOString(),
      actorType: r.actorType,
      actorName: r.actorName,
      actorRole: r.actorRole,
      client: r.client,
      action: r.action,
      summary: r.summary,
      targetType: r.targetType,
      targetId: r.targetId,
      targetLabel: r.targetLabel,
      reasonText: r.reasonText,
      transition: h
        ? {
            machine: h.machine,
            stateField: h.stateField,
            fromState: h.fromState,
            toState: h.toState,
            event: h.event,
            isForced: h.isForced,
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
            JSON.stringify({
              ticketId: t.id,
              at: last.createdAt.toISOString(),
              seq: String(last.seq),
            }),
          ).toString("base64url")
        : null,
    totalApprox: Math.min(10000, await tx.auditLog.count({ where })),
  };
}
