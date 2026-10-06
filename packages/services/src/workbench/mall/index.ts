import { createHash } from "node:crypto";
import { BannerJumpSchema, MallConfigViewSchema } from "@liyoxi/contract";
import type { MallDramaListQuery, MallConfig, HomeRecommendConfig } from "@liyoxi/contract";
import { calendarDate, diffDays } from "@liyoxi/shared/time";
import { quoteDramaItem, quoteAd } from "@liyoxi/shared/pricing";
import { AppError } from "../../kernel/index.js";
import type { Clock, TxRunner } from "../../kernel/index.js";
import type { Content } from "../../content/index.js";
import type { Config } from "../../config/index.js";
import type { Media } from "../../media/index.js";
import { getWalletView, getEntitlements, paramsAt } from "../../billing/index.js";
import type { Entitlements, WalletView } from "../../billing/index.js";
import { paramsAt as configParamsAt } from "../../config/index.js";
import { countCartBadge } from "../../order/index.js";
export interface MallViewer {
  readonly role: "owner" | "clerk" | "guest";
  readonly storeId: string | null;
  readonly entityId: string | null;
}
export interface MallDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly content: Content;
  readonly config: Config;
  readonly media: Pick<Media, "signRead">;
}
type CardRow = Awaited<ReturnType<Content["getDramaCards"]>>[number];
const heat = (tier: string | null) => ({ S: 100, A: 75, B: 50, C: 25 })[tier ?? ""] ?? 0;
const tie = (a: CardRow, b: CardRow) =>
  (b.firstListedAt?.getTime() ?? 0) - (a.firstListedAt?.getTime() ?? 0) || a.id.localeCompare(b.id);
const fail = (field: string) => {
  throw new AppError("VALIDATION_FAILED", {
    details: { fieldErrors: [{ path: field, message: "不在已发布商城配置或可选字典内" }] },
  });
};
function csv(value: string | undefined, allowed: readonly string[], field: string) {
  if (value === undefined) return [];
  const list = value.split(",");
  if (list.some((item) => !allowed.includes(item)) || new Set(list).size !== list.length)
    fail(field);
  return list;
}
export function sortCatalog(
  rows: readonly CardRow[],
  sort: string,
  weights: MallConfig["weights"],
  sales: ReadonlyMap<string, number>,
  maxSales: number,
  at: Date,
): CardRow[] {
  const score = (row: CardRow) =>
    heat(row.heatTier) * weights.heat +
    (maxSales === 0 ? 0 : ((sales.get(row.id) ?? 0) / maxSales) * 100) * weights.sales30d +
    Math.max(
      0,
      1 -
        (row.firstListedAt
          ? Math.max(0, (at.getTime() - row.firstListedAt.getTime()) / 86400000)
          : 90) /
          90,
    ) *
      100 *
      weights.freshness +
    row.manualBoost * weights.manual;
  return [...rows].sort((a, b) => {
    let result = 0;
    if (sort === "composite") result = score(b) - score(a);
    if (sort === "heat")
      result =
        heat(b.heatTier) - heat(a.heatTier) || (sales.get(b.id) ?? 0) - (sales.get(a.id) ?? 0);
    if (sort === "price_asc")
      result =
        (a.listPricePoints ?? Number.MAX_SAFE_INTEGER) -
        (b.listPricePoints ?? Number.MAX_SAFE_INTEGER);
    if (sort === "price_desc") result = (b.listPricePoints ?? -1) - (a.listPricePoints ?? -1);
    return result || tie(a, b);
  });
}
export function createMall(deps: MallDeps) {
  async function configs() {
    const [mall, home] = await Promise.all([
      deps.config.siteConfig.published("mall"),
      deps.config.siteConfig.published("home_recommend"),
    ]);
    if (!mall || !home) throw new Error("商城/首页配置尚未播种或无有效已发布版");
    return { mall, home };
  }
  async function dictionaries() {
    const types = await Promise.all(
      ["genre", "industry", "selling_tag", "region"].map((type) => deps.config.dicts.list(type)),
    );
    const byType = new Map(types.map((type) => [type.typeKey, type.items]));
    const refs = (type: string, codes: readonly string[]) =>
      codes.flatMap((code) => {
        const row = byType.get(type)?.find((item) => item.code === code);
        return row ? [{ code: row.code, name: row.name }] : [];
      });
    return { byType, refs };
  }
  async function finance(viewer: MallViewer, at: Date) {
    return deps.tx.run(async (tx) => {
      const params = await paramsAt(tx, at);
      let wallet: WalletView | null = null,
        entitlements: Entitlements | null = null;
      if (viewer.role === "owner" && viewer.entityId) {
        [wallet, entitlements] = await Promise.all([
          getWalletView(tx, viewer.entityId, at),
          getEntitlements(tx, viewer.entityId, at),
        ]);
      }
      return { params, wallet, term: entitlements?.term ?? null };
    });
  }
  async function cards(
    rows: readonly CardRow[],
    viewer: MallViewer,
    fin: Awaited<ReturnType<typeof finance>>,
    home: HomeRecommendConfig,
    dict: Awaited<ReturnType<typeof dictionaries>>,
    at: Date,
  ) {
    return Promise.all(
      rows.map(async (row) => ({
        dramaId: row.id,
        title: row.title,
        posterUrl: row.posterFileId
          ? await deps.media.signRead({ fileId: row.posterFileId })
          : null,
        genres: dict.refs("genre", row.genreCodes),
        totalEpisodes: row.totalEpisodes ?? 0,
        heatTier: row.heatTier,
        badge:
          row.firstListedAt &&
          diffDays(calendarDate(at), calendarDate(row.firstListedAt)) < home.newDays
            ? "new"
            : row.heatTier === "S"
              ? "hot"
              : null,
        listPricePoints: row.listPricePoints,
        usableUntilDate: row.licenseEndDate,
        ...(viewer.role === "owner"
          ? {
              discountedPoints:
                fin.term && row.listPricePoints !== null
                  ? quoteDramaItem({
                      listPricePoints: row.listPricePoints,
                      discountBp: fin.term.discountBp,
                      topModelSurchargeBp: fin.params.topModelSurchargeBp,
                      isTopModelIncluded: fin.term.productionModel === "top",
                      isTopModelSelected: false,
                    }).chargePoints
                  : null,
            }
          : {}),
      })),
    );
  }
  function ownerFields(fin: Awaited<ReturnType<typeof finance>>) {
    return {
      planName: fin.term ? (fin.wallet?.subscription.plan?.name ?? null) : null,
      productionModel: fin.term?.productionModel ?? null,
      discountBp: fin.term?.discountBp ?? null,
      adDiscountedPoints: fin.term ? quoteAd(fin.params.adUnitPoints, fin.term.discountBp) : null,
      spendablePoints: fin.wallet?.points.spendablePoints ?? 0,
      expiringPlanPoints: fin.wallet?.points.planAvailablePoints ?? 0,
      planPointsExpireAt: fin.term
        ? (fin.wallet?.points.planPointsExpireAt?.toISOString() ?? null)
        : null,
      termEndDate: fin.term?.endDate ?? null,
      cartItemId: null,
    };
  }
  async function mallConfig() {
    const { mall } = await configs(),
      dict = await dictionaries(),
      genres = (dict.byType.get("genre") ?? []).filter((row) => row.isEnabled),
      industries = (dict.byType.get("industry") ?? []).filter(
        (row) => row.parentCode === null && row.isSelectable,
      );
    return MallConfigViewSchema.parse({
      revNo: mall.revNo,
      categories: mall.content.categories
        .filter((row) => row.visible)
        .map((row) => ({
          key: row.key,
          name: row.name,
          genres: dict.refs(
            "genre",
            row.genreCodes.filter((code) => genres.some((item) => item.code === code)),
          ),
        })),
      hotWords: mall.content.hotWords,
      filters: mall.content.filters,
      sorts: mall.content.sorts,
      defaultSort: mall.content.defaultSort,
      genres: genres.map(({ code, name }) => ({ code, name })),
      industries: industries.map(({ code, name }) => ({ code, name })),
    });
  }
  return {
    config: mallConfig,
    async list(viewer: MallViewer, query: MallDramaListQuery) {
      const at = deps.clock.now(),
        [{ mall, home }, dict, view, fin] = await Promise.all([
          configs(),
          dictionaries(),
          mallConfig(),
          finance(viewer, at),
        ]);
      const { rows, sales } = await deps.tx.run(async (tx) => ({
        rows: await deps.content.visibleCatalog(tx, at),
        sales: new Map(
          (await tx.dramaStat.findMany({ select: { dramaId: true, orders30d: true } })).map(
            (row) => [row.dramaId, row.orders30d],
          ),
        ),
      }));
      const category = query.category
        ? view.categories.find((row) => row.key === query.category)
        : null;
      if (query.category && !category) fail("category");
      const genres = csv(
          query.genreCodes,
          view.genres.map((row) => row.code),
          "genreCodes",
        ),
        industries = csv(
          query.industryCodes,
          view.industries.map((row) => row.code),
          "industryCodes",
        );
      const episode = query.episodeBand
          ? view.filters.episodeBands.find((row) => row.key === query.episodeBand)
          : null,
        price = query.priceBand
          ? view.filters.priceBands.find((row) => row.key === query.priceBand)
          : null;
      if (query.episodeBand && !episode) fail("episodeBand");
      if (query.priceBand && !price) fail("priceBand");
      const sort = query.sort ?? view.defaultSort;
      if (!view.sorts.includes(sort)) fail("sort");
      const inBand = (
        value: number | null,
        band: { min: number | null; max: number | null } | null | undefined,
      ) =>
        !band ||
        (value !== null &&
          (band.min === null || value >= band.min) &&
          (band.max === null || value <= band.max));
      const filtered = rows.filter(
        (row) =>
          (!query.q || row.title.includes(query.q)) &&
          (!category ||
            category.key === "all" ||
            category.genres.some((item) => row.genreCodes.includes(item.code))) &&
          (!genres.length || genres.some((code) => row.genreCodes.includes(code))) &&
          (!industries.length || industries.some((code) => row.industryCodes.includes(code))) &&
          inBand(row.totalEpisodes, episode) &&
          inBand(row.listPricePoints, price),
      );
      const sorted = sortCatalog(
        filtered,
        sort,
        mall.content.weights,
        sales,
        Math.max(0, ...rows.map((row) => sales.get(row.id) ?? 0)),
        at,
      );
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            rev: mall.revNo,
            query: { ...query, cursor: undefined },
            rows: sorted.map((row) => [row.id, row.updatedAt.toISOString(), row.listPricePoints]),
          }),
        )
        .digest("hex");
      let offset = 0;
      try {
        if (query.cursor) {
          const decoded = JSON.parse(Buffer.from(query.cursor, "base64url").toString()) as {
            snapshot: unknown;
            offset: unknown;
          };
          if (
            decoded.snapshot === fingerprint &&
            Number.isSafeInteger(decoded.offset) &&
            Number(decoded.offset) >= 0 &&
            Number(decoded.offset) < sorted.length
          )
            offset = Number(decoded.offset);
        }
      } catch {
        /* 游标失效或格式坏：C42 重置第一页。 */
      }
      const end = offset + query.limit,
        hasMore = end < sorted.length,
        items = await cards(sorted.slice(offset, end), viewer, fin, home.content, dict, at);
      return {
        viewerRole: viewer.role,
        viewerPlan: fin.term
          ? { planName: fin.wallet?.subscription.plan?.name ?? "", discountBp: fin.term.discountBp }
          : null,
        items,
        hasMore,
        nextCursor: hasMore
          ? Buffer.from(JSON.stringify({ snapshot: fingerprint, offset: end })).toString(
              "base64url",
            )
          : null,
      };
    },
    async detail(viewer: MallViewer, id: string) {
      const at = deps.clock.now(),
        [{ home }, dict, fin, data] = await Promise.all([
          configs(),
          dictionaries(),
          finance(viewer, at),
          deps.tx.run(async (tx) => {
            const rows = await deps.content.getDramaCards(tx, [id], at),
              row = rows[0];
            if (!row || row.status === "draft" || row.archivedAt) throw new AppError("NOT_FOUND");
            const [ability, permits, params] = await Promise.all([
              deps.content.getOrderability(tx, [id]),
              tx.dramaPermit.findMany({
                where: { dramaId: id, status: "active" },
                orderBy: { id: "asc" },
              }),
              configParamsAt(tx, ["content.placement.open_slots", "ad.duration_options"], at),
            ]);
            const cartItem =
              viewer.role === "owner" && viewer.storeId && viewer.entityId
                ? await tx.cartItem.findFirst({
                    where: { storeId: viewer.storeId, entityId: viewer.entityId, dramaId: id },
                    select: { id: true },
                  })
                : null;
            return {
              row,
              ability: ability.get(id)!,
              permits,
              params,
              cartItemId: cartItem?.id ?? null,
            };
          }),
        ]);
      const { row, ability, permits, params } = data,
        allowed = row.allowedPlacements.filter(
          (slot) =>
            (params["content.placement.open_slots"] as readonly string[]).includes(slot) &&
            ["opening", "ending"].includes(slot),
        );
      return {
        ...(await cards([row], viewer, fin, home.content, dict, at))[0],
        viewerRole: viewer.role,
        orderability: { orderable: ability.orderable, reason: ability.reason },
        episodeDurationSec: row.episodeDurationSec,
        producerName: row.producerName,
        castNames: row.castNames,
        synopsis: row.synopsis,
        roles: row.roles,
        industries: dict.refs("industry", row.industryCodes),
        targetAudience: row.targetAudience,
        sellingTags: row.sellingTagCodes.flatMap((code) => {
          const tag = dict.byType.get("selling_tag")?.find((item) => item.code === code);
          return tag ? [{ code, name: tag.name, description: tag.description }] : [];
        }),
        dramaClass: row.dramaClass,
        allowedPlacements: allowed,
        placementDurations: allowed.map((slot) => ({
          slot,
          durationSecOptions: params["ad.duration_options"][slot as "opening" | "ending"],
        })),
        platforms: row.dramaCopyrights[0]?.platforms ?? [],
        permits: permits.map((item) => ({
          platform: item.platform,
          kind: item.permitKind,
          number: item.permitNo,
        })),
        adUnitPoints: fin.params.adUnitPoints,
        topModelSurchargeBp: fin.params.topModelSurchargeBp,
        trailer: null,
        ...(viewer.role === "owner"
          ? { owner: { ...ownerFields(fin), cartItemId: data.cartItemId } }
          : {}),
      };
    },
    async home(viewer: MallViewer, cityCode?: string) {
      const at = deps.clock.now(),
        [{ mall, home }, dict, fin, data] = await Promise.all([
          configs(),
          dictionaries(),
          finance(viewer, at),
          deps.tx.run(async (tx) => ({
            rows: await deps.content.visibleCatalog(tx, at),
            sales: new Map(
              (await tx.dramaStat.findMany({ select: { dramaId: true, orders30d: true } })).map(
                (row) => [row.dramaId, row.orders30d],
              ),
            ),
            profile: viewer.storeId
              ? await tx.storeProfile.findUnique({
                  where: { storeId: viewer.storeId },
                  select: { cityCode: true, industryCode: true, categoryCode: true },
                })
              : null,
            live:
              viewer.role === "owner" && viewer.storeId && viewer.entityId
                ? await tx.orderItem.aggregate({
                    where: { storeId: viewer.storeId, entityId: viewer.entityId, phase: "live" },
                    _count: true,
                    _sum: { liveEpisodeCount: true },
                  })
                : null,
            cartCount:
              viewer.role === "owner" && viewer.storeId
                ? await countCartBadge(tx, viewer.storeId, at)
                : 0,
            banners: await tx.homeBanner.findMany({
              where: {
                isEnabled: true,
                startAt: { lte: at },
                OR: [{ endAt: null }, { endAt: { gt: at } }],
              },
              orderBy: [{ position: "asc" }, { id: "asc" }],
            }),
          })),
        ]);
      const categoryKeys = new Set(
          mall.content.categories.filter((row) => row.visible).map((row) => row.key),
        ),
        ids = new Set(data.rows.map((row) => row.id)),
        banners = [];
      for (const row of data.banners) {
        const parsed = BannerJumpSchema.safeParse({
          jumpKind: row.jumpKind,
          jumpTarget: row.jumpKind === "none" ? null : row.jumpTarget,
        });
        if (!parsed.success) continue;
        const jump = parsed.data;
        if (jump.jumpKind === "drama" && !ids.has(jump.jumpTarget.dramaId)) continue;
        if (jump.jumpKind === "mall" && !categoryKeys.has(jump.jumpTarget.categoryKey)) continue;
        banners.push({
          homeBannerId: row.id,
          title: row.title,
          imageUrl: await deps.media.signRead({ fileId: row.imageFileId }),
          ...jump,
        });
        if (banners.length === 5) break;
      }
      if (!data.profile?.cityCode && cityCode) {
        const region = dict.byType.get("region")?.find((row) => row.code === cityCode);
        if (!region?.isSelectable || region.ext.level !== 2) fail("cityCode");
      }
      const city = data.profile?.cityCode ?? cityCode ?? null,
        common = {
          viewerRole: viewer.role,
          city: city ? (dict.refs("region", [city])[0] ?? null) : null,
          banners,
        };
      if (viewer.role === "clerk") return common;
      const hot = sortCatalog(data.rows, "heat", mall.content.weights, data.sales, 0, at),
        newest = sortCatalog(
          data.rows.filter(
            (row) =>
              row.firstListedAt &&
              diffDays(calendarDate(at), calendarDate(row.firstListedAt)) < home.content.newDays,
          ),
          "newest",
          mall.content.weights,
          data.sales,
          0,
          at,
        );
      const result = {
        ...common,
        hot: await cards(hot.slice(0, 4), viewer, fin, home.content, dict, at),
        new: await cards(newest.slice(0, 4), viewer, fin, home.content, dict, at),
        defaultTab: home.content.defaultTab,
      };
      if (viewer.role !== "owner") return result;
      const industry = data.profile?.industryCode ?? null,
        pin = home.content.pins.find((row) => row.industryCode === industry)?.dramaId;
      const recommended = industry
        ? hot.filter((row) => row.industryCodes.includes(industry))
        : hot;
      if (pin) {
        const index = recommended.findIndex((row) => row.id === pin);
        if (index >= 0) recommended.unshift(...recommended.splice(index, 1));
      }
      const owner = ownerFields(fin);
      return {
        ...result,
        noticeBar: null,
        launchOverview: {
          liveItemCount: data.live?._count ?? 0,
          liveEpisodeCount: data.live?._sum.liveEpisodeCount ?? 0,
          spendablePoints: owner.spendablePoints,
          planName: owner.planName,
          termEndDate: owner.termEndDate,
          expiringPlanPoints: owner.expiringPlanPoints,
          planPointsExpireAt: owner.planPointsExpireAt,
        },
        recommend: {
          matchBy:
            industry && dict.refs("industry", [industry])[0]
              ? {
                  industry: dict.refs("industry", [industry])[0],
                  category: data.profile?.categoryCode
                    ? (dict.refs("industry", [data.profile.categoryCode])[0] ?? null)
                    : null,
                }
              : null,
          items: await cards(
            recommended.slice(0, home.content.recommendCount),
            viewer,
            fin,
            home.content,
            dict,
            at,
          ),
        },
        cartCount: data.cartCount,
      };
    },
  };
}
export type Mall = ReturnType<typeof createMall>;
