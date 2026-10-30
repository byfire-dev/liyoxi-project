import { z, ActivityItemSchema, OrderActivityQuerySchema } from "@liyoxi/contract";
import { managedStore } from "../authz/index.js";
import type { DataScope } from "../authz/index.js";
import type { Prisma } from "@liyoxi/db";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

const cursorSchema = z.strictObject({
  orderId: z.uuid(),
  at: z.iso.datetime(),
  seq: z
    .string()
    .regex(/^\d{1,19}$/)
    .refine((v) => BigInt(v) <= 9223372036854775807n),
});
/** Authorize the parent first, then read only actual descendants through the target index. */
export async function orderActivity(tx: Tx, scope: DataScope, id: string, raw: unknown) {
  const query = OrderActivityQuerySchema.parse(raw);
  const order = await tx.dramaOrder.findFirst({ where: { id, store: managedStore(scope) } });
  if (!order) throw new AppError("NOT_FOUND");
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor) {
    try {
      if (query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
      );
      if (cursor.orderId !== id) throw new Error();
    } catch {
      throw new AppError("VALIDATION_FAILED");
    }
  }
  const items = await tx.orderItem.findMany({ where: { dramaOrderId: id }, select: { id: true } }),
    tickets = await tx.deliveryTicket.findMany({
      where: { dramaOrderId: id },
      select: { id: true },
    }),
    plans = await tx.deliveryPlan.findMany({ where: { dramaOrderId: id }, select: { id: true } }),
    samples = await tx.sample.findMany({
      where: { deliveryTicketId: { in: tickets.map((r) => r.id) } },
      select: { id: true },
    }),
    letters = await tx.licenseLetter.findMany({
      where: { orderItemId: { in: items.map((r) => r.id) } },
      select: { id: true },
    }),
    cancels = await tx.cancelRequest.findMany({
      where: {
        OR: [
          { dramaOrderId: id },
          {
            cancelRequestLines: {
              some: { targetType: "order_item", targetId: { in: items.map((r) => r.id) } },
            },
          },
        ],
      },
      select: { id: true, approvalRequestId: true },
    });
  const targets = [
    { targetType: "drama_order", targetId: { in: [id] } },
    ...Object.entries({
      order_item: items,
      delivery_ticket: tickets,
      delivery_plan: plans,
      sample: samples,
      license_letter: letters,
      cancel_request: cancels,
      approval_request: cancels.map((r) => ({ id: r.approvalRequestId })),
    }).map(([targetType, rows]) => ({ targetType, targetId: { in: rows.map((r) => r.id) } })),
  ];
  const base: Prisma.AuditLogWhereInput = { stream: { in: ["ops", "activity"] }, OR: targets };
  const rows = await tx.auditLog.findMany({
    where: {
      AND: [
        base,
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
    transitions = await tx.statusTransition.findMany({
      where: {
        OR: visible.flatMap((r) =>
          r.requestId && r.targetType && r.targetId
            ? [{ requestId: r.requestId, machine: r.targetType, subjectId: r.targetId }]
            : [],
        ),
      },
      orderBy: { seq: "desc" },
    });
  const result = visible.map((row) => {
    const t = transitions.find(
      (r) =>
        r.requestId === row.requestId &&
        r.machine === row.targetType &&
        r.subjectId === row.targetId,
    );
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
    items: result,
    hasMore,
    totalApprox: Math.min(10000, await tx.auditLog.count({ where: base })),
    nextCursor:
      hasMore && last
        ? Buffer.from(
            JSON.stringify({
              orderId: id,
              at: last.createdAt.toISOString(),
              seq: String(last.seq),
            }),
          ).toString("base64url")
        : null,
  };
}
