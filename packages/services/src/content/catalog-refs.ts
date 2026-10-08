import { calendarDate } from "@liyoxi/shared/time";
import { visible } from "@liyoxi/shared/catalog";
import type { CatalogRefs } from "../kernel/index.js";
import { boundContentPrices } from "./binding.js";
import { dateOf } from "./checks.js";

/** 当前事实；不复用商城缓存，也不把已下架或越过可订止日的剧当有效引用。 */
export const contentCatalogRefs: CatalogRefs = {
  async read(tx, at, ids) {
    const rows = await tx.drama.findMany({
      where: ids ? { id: { in: [...ids] } } : {},
      include: { dramaCopyrights: true },
    });
    const minLicenseMonths = await boundContentPrices().minLicenseMonths(tx, at);
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      genreCodes: row.genreCodes,
      isListed: row.status === "listed" && row.archivedAt === null,
      isOrderable: visible(
        {
          status: row.status,
          archivedAt: row.archivedAt,
          licenseEndDate: dateOf(row.dramaCopyrights[0]?.licenseEndDate ?? null),
          minLicenseMonths,
        },
        calendarDate(at),
      ),
    }));
  },
  async areListed(tx, ids, at) {
    const rows = await this.read(tx, at, ids);
    return new Map(ids.map((id) => [id, rows.some((row) => row.id === id && row.isOrderable)]));
  },
};
