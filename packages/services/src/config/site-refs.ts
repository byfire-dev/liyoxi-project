import { MallConfigSchema, HomeRecommendConfigSchema } from "@liyoxi/contract";
import type { SiteConfigRefs } from "@liyoxi/contract";
import { catalogRefsOf } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { SiteAdminDeps } from "./site-context.js";
import { invalid } from "./admin-context.js";
export type SiteKey = "mall" | "home_recommend";
export function parseSite(key: SiteKey, content: unknown) {
  const parsed = (key === "mall" ? MallConfigSchema : HomeRecommendConfigSchema).safeParse(content);
  if (!parsed.success)
    return invalid(
      `content.${parsed.error.issues[0]?.path.join(".") ?? ""}`,
      parsed.error.issues[0]?.message ?? "配置结构不符",
    );
  return parsed.data;
}
export async function siteRefs(
  tx: Tx,
  deps: SiteAdminDeps,
  key: SiteKey,
  raw: unknown,
  at: Date,
): Promise<SiteConfigRefs> {
  const content = parseSite(key, raw);
  const dicts = await tx.dictItem.findMany({
    where: { dictTypeKey: { in: ["genre", "industry"] } },
  });
  const genre = new Map(
    dicts.filter((row) => row.dictTypeKey === "genre").map((row) => [row.code, row]),
  );
  const industry = new Map(
    dicts.filter((row) => row.dictTypeKey === "industry").map((row) => [row.code, row]),
  );
  const catalog = await catalogRefsOf(deps.assembly).read(tx, at);
  const result: SiteConfigRefs = {
    categoryStats: [],
    pins: [],
    invalidRefs: [],
    affectedBanners: [],
  };
  if (key === "mall") {
    const mall = MallConfigSchema.parse(content);
    for (const [index, category] of mall.categories.entries()) {
      const path = `categories.${index}.genreCodes`;
      for (const [codeIndex, code] of category.genreCodes.entries()) {
        const row = genre.get(code);
        if (!row || !row.isEnabled)
          result.invalidRefs.push({
            path: `${path}.${codeIndex}`,
            code,
            reason: row ? "genre_disabled" : "genre_unknown",
          });
      }
      result.categoryStats.push({
        key: category.key,
        dramaCount: catalog.filter(
          (row) =>
            row.isListed &&
            (category.fixed || category.genreCodes.some((code) => row.genreCodes.includes(code))),
        ).length,
        genreNames: category.genreCodes.flatMap((code) => {
          const row = genre.get(code);
          return row ? [row.name] : [];
        }),
      });
    }
    const keys = new Set(mall.categories.map((row) => row.key));
    const banners = await tx.homeBanner.findMany({
      where: { isEnabled: true, OR: [{ endAt: null }, { endAt: { gt: at } }], jumpKind: "mall" },
    });
    for (const row of banners) {
      const target = row.jumpTarget as { categoryKey?: string } | null;
      if (target?.categoryKey && !keys.has(target.categoryKey))
        result.affectedBanners.push({
          homeBannerId: row.id,
          title: row.title,
          categoryKey: target.categoryKey,
        });
    }
  } else {
    const home = HomeRecommendConfigSchema.parse(content);
    for (const [index, pin] of home.pins.entries()) {
      const ind = industry.get(pin.industryCode),
        drama = catalog.find((row) => row.id === pin.dramaId);
      if (!ind || !ind.isEnabled || ind.parentCode !== null)
        result.invalidRefs.push({
          path: `pins.${index}.industryCode`,
          code: pin.industryCode,
          reason: "industry_unknown",
        });
      if (!drama || !drama.isListed || !drama.isOrderable)
        result.invalidRefs.push({
          path: `pins.${index}.dramaId`,
          code: pin.dramaId,
          reason: !drama
            ? "drama_not_found"
            : !drama.isListed
              ? "drama_not_listed"
              : "drama_not_orderable",
        });
      result.pins.push({
        industryCode: pin.industryCode,
        industryName: ind?.name ?? pin.industryCode,
        dramaId: pin.dramaId,
        dramaTitle: drama?.title ?? pin.dramaId,
        isOrderable: drama?.isOrderable ?? false,
      });
    }
  }
  return result;
}
