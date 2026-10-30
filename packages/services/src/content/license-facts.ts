import { permitCovers, selectPermits } from "@liyoxi/shared/catalog";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

export interface LicenseScope {
  name: string;
  episodes: number;
  territory: string;
  permits: { kind: string; number: string; platform: string }[];
}

/** 授权快照读取真实许可范围；历史订单不受商城上下架、停售日期等订购守卫影响。 */
export async function readLicenseScope(
  tx: Tx,
  dramaId: string,
  platform: string,
): Promise<LicenseScope> {
  const drama = await tx.drama.findUnique({
    where: { id: dramaId },
    select: { title: true, totalEpisodes: true, dramaClass: true },
  });
  const copyright = await tx.dramaCopyright.findUnique({
    where: { dramaId },
    select: { territory: true, platforms: true },
  });
  const rows = await tx.dramaPermit.findMany({
    where: { dramaId, status: "active" },
    select: { platform: true, permitKind: true, permitNo: true, status: true },
    orderBy: { id: "asc" },
  });
  const permits = selectPermits(
    rows.map((row) => ({
      kind: row.permitKind,
      number: row.permitNo,
      platform: row.platform,
      status: row.status,
    })),
    platform,
  );
  if (
    !drama?.title.trim() ||
    !drama.totalEpisodes ||
    drama.totalEpisodes < 1 ||
    !copyright?.territory?.trim() ||
    !copyright.platforms.includes(platform) ||
    !permitCovers(permits, platform, drama.dramaClass) ||
    permits.some((permit) => !permit.number.trim())
  )
    throw new AppError("PRECONDITION_CHANGED", { message: "授权快照所需的剧目许可事实不完整" });
  return {
    name: drama.title,
    episodes: drama.totalEpisodes,
    territory: copyright.territory,
    permits: permits.map(({ kind, number, platform: permitPlatform }) => ({
      kind,
      number,
      platform: permitPlatform,
    })),
  };
}
