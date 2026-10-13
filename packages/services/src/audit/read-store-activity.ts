import { StoreActivityQuerySchema, StoreActivityItemSchema, z } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { auditLogItem } from "./read.js";

const cursorSchema = z.strictObject({
  storeId: z.uuid(),
  entityId: z.uuid(),
  actors: z.string(),
  at: z.iso.datetime(),
  seq: z
    .string()
    .regex(/^\d{1,19}$/)
    .refine((v) => BigInt(v) <= 9223372036854775807n),
});
/** 调用方先验商家模块和本店scope；仅读本店/同主体无店行，JSON值与access流永不出投影。 */
export async function readStoreActivity(
  tx: Tx,
  store: { id: string; entityId: string },
  raw: unknown,
) {
  const parsed = StoreActivityQuerySchema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION_FAILED");
  const query = parsed.data;
  const actors = [...new Set(query.actorType?.split(",") ?? [])].sort().join(",");
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor) {
    try {
      if (query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
      );
      if (
        cursor.storeId !== store.id ||
        cursor.entityId !== store.entityId ||
        cursor.actors !== actors
      )
        throw new Error();
    } catch {
      throw new AppError("VALIDATION_FAILED");
    }
  }
  const shared: Prisma.AuditLogWhereInput = {
    stream: { in: ["ops", "activity"] },
    ...(actors ? { actorType: { in: actors.split(",") } } : {}),
  };
  const filters: Prisma.AuditLogWhereInput[] = [
    { ...shared, storeId: store.id },
    { ...shared, entityId: store.entityId, storeId: null },
  ];
  const boundary: Prisma.AuditLogWhereInput = cursor
    ? {
        OR: [
          { createdAt: { lt: new Date(cursor.at) } },
          { createdAt: new Date(cursor.at), seq: { lt: BigInt(cursor.seq) } },
        ],
      }
    : {};
  // 两条互斥索引路径各取一页后归并，避免主体OR全表扫描或重复主体行。
  const rows = [];
  let total = 0;
  for (const where of filters) {
    rows.push(
      ...(await tx.auditLog.findMany({
        where: { AND: [where, boundary] },
        orderBy: [{ createdAt: "desc" }, { seq: "desc" }],
        take: query.limit + 1,
      })),
    );
    total += await tx.auditLog.count({ where });
  }
  rows.sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() ||
      (a.seq === b.seq ? 0 : a.seq > b.seq ? -1 : 1),
  );
  const visible = rows.slice(0, query.limit),
    last = visible.at(-1),
    hasMore = rows.length > query.limit;
  return {
    items: visible.map((row) =>
      StoreActivityItemSchema.parse({
        ...auditLogItem(row),
        reason:
          row.reasonCode === null && row.reasonText === null
            ? null
            : { code: row.reasonCode, text: row.reasonText },
        changedKeys:
          row.after !== null && typeof row.after === "object" && !Array.isArray(row.after)
            ? Object.keys(row.after).sort()
            : [],
        isEntityLevel: row.storeId === null,
      }),
    ),
    hasMore,
    nextCursor:
      hasMore && last
        ? Buffer.from(
            JSON.stringify({
              storeId: store.id,
              entityId: store.entityId,
              actors,
              at: last.createdAt.toISOString(),
              seq: String(last.seq),
            }),
          ).toString("base64url")
        : null,
    totalApprox: Math.min(10_000, total),
  };
}
