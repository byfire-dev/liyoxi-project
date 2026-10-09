import type { Tx } from "../kernel/index.js";
/** 仅导出聚合事实；不把事件载荷交给低层配置。 */
export async function countBannerClicks(
  tx: Tx,
  ids: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (!ids.length) return new Map();
  const rows = await tx.$queryRaw<{ id: string; count: bigint }[]>`
    SELECT props->>'homeBannerId' AS id, count(*) AS count
    FROM analytics_event WHERE name='banner_click' AND props->>'homeBannerId'=ANY(${[...ids]}::text[])
    GROUP BY props->>'homeBannerId'`;
  return new Map(rows.map((row) => [row.id, Number(row.count)]));
}
