import { SiteNoticeQuerySchema, SiteNoticeItemSchema } from "@liyoxi/contract";
import type { z } from "@liyoxi/contract";
import { dayRange, addDays } from "@liyoxi/shared/time";
import type { Tx } from "../kernel/index.js";
import type { ConfigActor } from "./admin-context.js";
import type { SiteAdminDeps } from "./site-context.js";
export async function listSiteNotices(
  tx: Tx,
  deps: SiteAdminDeps,
  _ctx: ConfigActor,
  raw: z.input<typeof SiteNoticeQuerySchema> = {},
) {
  const query = SiteNoticeQuerySchema.parse(raw),
    now = deps.clock.now(),
    kinds = query.kind?.split(","),
    states = query.displayState?.split(",");
  const rows = await tx.siteNotice.findMany({
    where: {
      ...(kinds ? { kind: { in: kinds } } : {}),
      ...(query.refId ? { refId: query.refId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.effectiveFrom || query.effectiveTo
        ? {
            effectiveAt: {
              ...(query.effectiveFrom ? { gte: dayRange(query.effectiveFrom).start } : {}),
              ...(query.effectiveTo ? { lt: dayRange(addDays(query.effectiveTo, 1)).start } : {}),
            },
          }
        : {}),
    },
    orderBy: [
      query.sort === "-effectiveAt" ? { effectiveAt: "desc" } : { announcedAt: "desc" },
      { id: "asc" },
    ],
  });
  const display = (row: (typeof rows)[number]) =>
    row.status === "withdrawn" ? "withdrawn" : row.effectiveAt > now ? "scheduled" : "effective";
  const linked = await Promise.all(
    rows.map(async (row) => ({
      row,
      link: (await deps.noticeLink(tx, row)) ?? SiteNoticeItemSchema.shape.link.parse(row.link),
    })),
  );
  const filtered = linked.filter(({ row }) => !states || states.includes(display(row))),
    page = filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
  const people = await deps.staffBriefs(tx, [
    ...new Set(
      page.flatMap(({ row }) => [
        row.createdByStaffId,
        ...(row.withdrawnByStaffId ? [row.withdrawnByStaffId] : []),
      ]),
    ),
  ]);
  return {
    items: page.map(({ row, link }) =>
      SiteNoticeItemSchema.parse({
        siteNoticeId: row.id,
        kind: row.kind,
        refId: row.refId,
        title: row.title,
        summary: row.summary,
        summaryNoPrice: row.summaryNoPrice,
        effectiveAt: row.effectiveAt.toISOString(),
        announcedAt: row.announcedAt.toISOString(),
        leadDays: row.leadDays,
        shortNoticeReason: row.shortNoticeReason,
        link,
        isBarEnabled: row.barEnabled,
        status: row.status,
        displayState: display(row),
        createdBy: people.find((person) => person.staffId === row.createdByStaffId),
        withdrawnBy: people.find((person) => person.staffId === row.withdrawnByStaffId) ?? null,
        withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      }),
    ),
    page: query.page,
    pageSize: query.pageSize,
    total: filtered.length,
  };
}
export async function readHomeNotice(
  tx: Tx,
  now: Date,
  mode: "in_app" | "offline_contract" | "hidden",
  noticeLink: SiteAdminDeps["noticeLink"],
) {
  if (mode === "hidden") return null;
  const row = await tx.siteNotice.findFirst({
    where: {
      status: "announced",
      barEnabled: true,
      announcedAt: { lte: now },
      effectiveAt: { gt: new Date(now.getTime() - 7 * 86400000) },
    },
    orderBy: [{ announcedAt: "desc" }, { id: "asc" }],
  });
  if (!row) return null;
  const link = await noticeLink(tx, row);
  if (!link) return null;
  return {
    siteNoticeId: row.id,
    title: row.title,
    summary: mode === "offline_contract" ? (row.summaryNoPrice ?? row.summary) : row.summary,
    effectiveAt: row.effectiveAt.toISOString(),
    link,
  };
}
