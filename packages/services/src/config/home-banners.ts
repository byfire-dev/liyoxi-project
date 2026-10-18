import {
  BannerJumpSchema,
  BANNER_PAGE_LABELS,
  HomeBannerItemSchema,
  HomeBannerCreateBodySchema,
  HomeBannerUpdateBodySchema,
  HomeBannerListQuerySchema,
  HomeBannerReorderBodySchema,
  HomeBannerPageSchema,
} from "@liyoxi/contract";
import type { HomeBannerCreateBody, HomeBannerUpdateBody, z } from "@liyoxi/contract";
import { Prisma } from "@liyoxi/db";
import { AppError, catalogRefsOf, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx, TxRunOptions } from "../kernel/index.js";
import { record } from "../audit/index.js";
import { auditConfig, invalid } from "./admin-context.js";
import type { ConfigActor } from "./admin-context.js";
import { siteActor } from "./site-context.js";
import type { SiteAdminDeps } from "./site-context.js";
import { paramsAt } from "./params.js";
import { parseSite } from "./site-refs.js";
import { MallConfigSchema } from "@liyoxi/contract";
type Banner = Prisma.HomeBannerGetPayload<object>;
export function bannerState(row: Pick<Banner, "isEnabled" | "startAt" | "endAt">, now: Date) {
  return !row.isEnabled
    ? "disabled"
    : row.startAt > now
      ? "scheduled"
      : row.endAt && row.endAt <= now
        ? "ended"
        : "live";
}
/** 半开区间；同一时刻先结束后开始，已结束的区间不参与未来容量。 */
export function checkBannerCapacity(
  rows: readonly Pick<Banner, "isEnabled" | "startAt" | "endAt">[],
  now: Date,
  max: number,
) {
  const changes = rows
    .filter((row) => row.isEnabled && (!row.endAt || row.endAt > now))
    .flatMap((row) => [
      { at: Math.max(now.getTime(), row.startAt.getTime()), delta: 1 },
      ...(row.endAt ? [{ at: row.endAt.getTime(), delta: -1 }] : []),
    ])
    .sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  for (const change of changes) {
    active += change.delta;
    if (active > max)
      throw new AppError("BANNER_LIMIT_EXCEEDED", {
        details: { activeCount: active, maxActive: max, at: new Date(change.at).toISOString() },
      });
  }
}
export function createHomeBanners(deps: SiteAdminDeps) {
  const clickCache = new Map<string, { until: number; count: number }>();
  const lock = (tx: Tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('home_banner'))`;
  async function maximum(tx: Tx, at: Date) {
    return (await paramsAt(tx, ["home.banner.max_active"], at))["home.banner.max_active"];
  }
  async function target(tx: Tx, kind: string, value: unknown, at: Date) {
    const reject = (reason: string): never => {
      throw new AppError("BANNER_TARGET_INVALID", { details: { jumpKind: kind, reason } });
    };
    const parsed = BannerJumpSchema.safeParse({
      jumpKind: kind,
      jumpTarget: kind === "none" && value === undefined ? null : value,
    });
    if (!parsed.success) {
      const route =
        typeof value === "object" && value !== null && "route" in value ? value.route : null;
      return reject(
        kind === "page" && (typeof route !== "string" || !BANNER_PAGE_LABELS[route])
          ? "route_not_allowed"
          : "params_invalid",
      );
    }
    const jump = parsed.data;
    if (jump.jumpKind === "drama") {
      const row = (await catalogRefsOf(deps.assembly).read(tx, at, [jump.jumpTarget.dramaId]))[0];
      if (!row || !row.isListed || !row.isOrderable)
        reject(
          !row ? "drama_not_found" : !row.isListed ? "drama_not_listed" : "drama_not_orderable",
        );
    }
    if (jump.jumpKind === "mall") {
      const pub = await tx.siteConfigRevision.findFirst({
        where: { configKey: "mall", status: "published" },
      });
      if (
        !pub ||
        !MallConfigSchema.parse(parseSite("mall", pub.content)).categories.some(
          (row) => row.key === jump.jumpTarget.categoryKey,
        )
      )
        reject("category_not_found");
    }
    return jump.jumpKind === "none" ? null : jump.jumpTarget;
  }
  async function label(tx: Tx, row: Banner, at: Date) {
    const value = row.jumpTarget as {
      dramaId?: string;
      categoryKey?: string;
      route?: string;
    } | null;
    if (row.jumpKind === "drama" && value?.dramaId) {
      const ref = (await catalogRefsOf(deps.assembly).read(tx, at, [value.dramaId]))[0];
      return `短剧详情 · ${ref ? `《${ref.title}》` : value.dramaId}${ref?.isOrderable ? "" : "（已失效）"}`;
    }
    if (row.jumpKind === "mall" && value?.categoryKey) {
      const pub = await tx.siteConfigRevision.findFirst({
        where: { configKey: "mall", status: "published" },
      });
      const category = pub
        ? MallConfigSchema.parse(parseSite("mall", pub.content)).categories.find(
            (row) => row.key === value.categoryKey,
          )
        : null;
      return `商城分类 · ${category?.name ?? value.categoryKey}${category ? "" : "（已失效）"}`;
    }
    return row.jumpKind === "page"
      ? `小程序页面 · ${value?.route && BANNER_PAGE_LABELS[value.route] ? BANNER_PAGE_LABELS[value.route] : `${value?.route ?? ""}（已失效）`}`
      : null;
  }
  async function views(tx: Tx, ctx: ConfigActor, rows: readonly Banner[], at: Date) {
    const people = await deps.staffBriefs(tx, [
      ...new Set(
        rows.flatMap((row) => [
          row.createdByStaffId,
          ...(row.updatedByStaffId ? [row.updatedByStaffId] : []),
        ]),
      ),
    ]);
    const miss = rows
      .filter(
        (row) =>
          bannerState(row, at) !== "scheduled" &&
          (clickCache.get(row.id)?.until ?? 0) <= at.getTime(),
      )
      .map((row) => row.id);
    if (miss.length) {
      const counts = await deps.clicks(tx, miss);
      for (const id of miss)
        clickCache.set(id, { count: counts.get(id) ?? 0, until: at.getTime() + 300000 });
      if (clickCache.size > 1000)
        for (const [id, cached] of clickCache)
          if (cached.until <= at.getTime()) clickCache.delete(id);
      while (clickCache.size > 1000) clickCache.delete(clickCache.keys().next().value!);
    }
    return Promise.all(
      rows.map(async (row) => {
        const ended = !!row.endAt && row.endAt <= at;
        return HomeBannerItemSchema.parse({
          homeBannerId: row.id,
          title: row.title,
          imageFileId: row.imageFileId,
          imageUrl: null,
          jumpKind: row.jumpKind,
          jumpTarget: row.jumpTarget,
          jumpTargetLabel: await label(tx, row, at),
          startAt: row.startAt.toISOString(),
          endAt: row.endAt?.toISOString() ?? null,
          isEnabled: row.isEnabled,
          position: row.position,
          displayState: bannerState(row, at),
          clickCount:
            bannerState(row, at) === "scheduled" ? null : (clickCache.get(row.id)?.count ?? 0),
          lockVersion: row.lockVersion,
          createdBy: people.find((person) => person.staffId === row.createdByStaffId),
          updatedBy: people.find((person) => person.staffId === row.updatedByStaffId) ?? null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          actions:
            ctx.staff.moduleLevels.ops === "e"
              ? ["edit", ...(!ended ? [row.isEnabled ? "disable" : "enable"] : [])]
              : [],
        });
      }),
    );
  }
  async function sign<T extends { imageFileId: string; imageUrl: unknown }>(row: T) {
    return { ...row, imageUrl: await deps.files.sign(row.imageFileId) };
  }
  async function finish<T extends { imageFileId: string; imageUrl: unknown }>(
    result: T,
    options: TxRunOptions,
  ) {
    const replayed = options.idem?.replayed ?? false;
    return { ...(replayed ? result : await sign(result)), replayed };
  }
  function times(startAt: Date, endAt: Date | null, now: Date, changedEnd: boolean) {
    if (endAt && (endAt <= startAt || (changedEnd && endAt <= now)))
      invalid("endAt", "结束时间须晚于开始时间及当前时刻");
  }
  async function write<T>(fn: (tx: Tx) => Promise<T>, options: TxRunOptions) {
    let changed = false;
    const result = await deps.tx.run(async (tx) => {
      const value = await fn(tx);
      changed = true;
      return value;
    }, options);
    if (changed) await deps.config.cache.bump("site");
    return result;
  }
  return {
    async create(ctx: ConfigActor, raw: HomeBannerCreateBody, options: TxRunOptions = {}) {
      const staffId = siteActor(ctx, true),
        input = HomeBannerCreateBodySchema.parse(raw);
      const data = await write(async (tx) => {
        await lock(tx);
        const now = deps.clock.now(),
          id = uuidv7(),
          startAt = new Date(input.startAt),
          endAt = input.endAt ? new Date(input.endAt) : null;
        times(startAt, endAt, now, true);
        const jumpTarget = await target(tx, input.jumpKind, input.jumpTarget, now);
        const rows = await tx.homeBanner.findMany();
        checkBannerCapacity(
          [...rows, { startAt, endAt, isEnabled: input.isEnabled ?? true }],
          now,
          await maximum(tx, now),
        );
        await deps.files.link(tx, input.imageFileId, id);
        const row = await tx.homeBanner.create({
          data: {
            id,
            title: input.title,
            imageFileId: input.imageFileId,
            jumpKind: input.jumpKind,
            jumpTarget: jumpTarget === null ? Prisma.DbNull : (jumpTarget as Prisma.InputJsonValue),
            startAt,
            endAt,
            isEnabled: input.isEnabled ?? true,
            position: Math.max(-1, ...rows.map((row) => row.position)) + 1,
            createdByStaffId: staffId,
            updatedByStaffId: staffId,
            createdAt: now,
            updatedAt: now,
          },
        });
        await auditConfig(
          tx,
          ctx,
          "ops_config",
          "ops.home_banner.create",
          { type: "home_banner", id },
          null,
          row,
        );
        return (await views(tx, ctx, [row], now))[0]!;
      }, options);
      return finish(data, options);
    },
    async update(
      ctx: ConfigActor,
      id: string,
      raw: HomeBannerUpdateBody,
      options: TxRunOptions = {},
    ) {
      const staffId = siteActor(ctx, true),
        input = HomeBannerUpdateBodySchema.parse(raw);
      const data = await write(async (tx) => {
        await lock(tx);
        const before = await tx.homeBanner.findUnique({ where: { id } });
        if (!before) throw new AppError("NOT_FOUND");
        if (before.lockVersion !== input.lockVersion) throw new AppError("VERSION_CONFLICT");
        const now = deps.clock.now();
        if (input.jumpKind !== undefined && input.jumpTarget === undefined)
          invalid("jumpTarget", "修改跳转类型须同时提供目标");
        const startAt = input.startAt ? new Date(input.startAt) : before.startAt,
          endAt =
            input.endAt === undefined ? before.endAt : input.endAt ? new Date(input.endAt) : null;
        if (input.isEnabled !== undefined && endAt && endAt <= now)
          throw new AppError("STATE_NOT_ALLOWED");
        times(startAt, endAt, now, input.endAt !== undefined);
        const jumpKind = input.jumpKind ?? before.jumpKind,
          changed =
            input.jumpKind !== undefined ||
            input.jumpTarget !== undefined ||
            input.isEnabled === true;
        const jumpTarget = changed
          ? await target(
              tx,
              jumpKind,
              input.jumpTarget === undefined ? before.jumpTarget : input.jumpTarget,
              now,
            )
          : before.jumpTarget;
        const merged = {
          ...before,
          startAt,
          endAt,
          isEnabled: input.isEnabled ?? before.isEnabled,
        };
        const rows = await tx.homeBanner.findMany({ where: { id: { not: id } } });
        if (
          merged.isEnabled &&
          (input.startAt !== undefined ||
            input.endAt !== undefined ||
            input.isEnabled !== undefined)
        )
          checkBannerCapacity([...rows, merged], now, await maximum(tx, now));
        const imageFileId = input.imageFileId ?? before.imageFileId;
        if (imageFileId !== before.imageFileId)
          await lockRows(tx, "file_object", [before.imageFileId, imageFileId]);
        if (imageFileId !== before.imageFileId || merged.isEnabled)
          await deps.files.link(tx, imageFileId, id);
        const after = await tx.homeBanner.update({
          where: { id },
          data: {
            title: input.title ?? before.title,
            imageFileId,
            jumpKind,
            jumpTarget: jumpTarget === null ? Prisma.DbNull : (jumpTarget as Prisma.InputJsonValue),
            startAt,
            endAt,
            isEnabled: merged.isEnabled,
            lockVersion: { increment: 1 },
            updatedByStaffId: staffId,
            updatedAt: now,
          },
        });
        if (imageFileId !== before.imageFileId)
          await deps.files.release(
            tx,
            before.imageFileId,
            id,
            new Date(now.getTime() + 180 * 86400000),
          );
        await auditConfig(
          tx,
          ctx,
          "ops_config",
          input.isEnabled !== undefined &&
            Object.keys(input).every((key) => key === "isEnabled" || key === "lockVersion")
            ? input.isEnabled
              ? "ops.home_banner.enable"
              : "ops.home_banner.disable"
            : "ops.home_banner.update",
          { type: "home_banner", id },
          before,
          after,
        );
        return (await views(tx, ctx, [after], now))[0]!;
      }, options);
      return finish(data, options);
    },
    async reorder(
      ctx: ConfigActor,
      raw: z.input<typeof HomeBannerReorderBodySchema>,
      options: TxRunOptions = {},
    ) {
      const staffId = siteActor(ctx, true),
        input = HomeBannerReorderBodySchema.parse(raw);
      const data = await write(async (tx) => {
        await lock(tx);
        const now = deps.clock.now(),
          rows = await tx.homeBanner.findMany({
            where: { OR: [{ endAt: null }, { endAt: { gt: now } }] },
            orderBy: [{ position: "asc" }, { id: "asc" }],
          });
        const ids = new Set(input.homeBannerIds),
          current = new Set(rows.map((row) => row.id));
        const missingIds = rows.filter((row) => !ids.has(row.id)).map((row) => row.id),
          extraIds = input.homeBannerIds.filter((id) => !current.has(id));
        if (missingIds.length || extraIds.length)
          throw new AppError("BANNER_ORDER_STALE", {
            details: { missingHomeBannerIds: missingIds, unknownHomeBannerIds: extraIds },
          });
        const positions = rows.map((row) => row.position).sort((a, b) => a - b);
        const after: Banner[] = [];
        for (const [index, id] of input.homeBannerIds.entries()) {
          const row = rows.find((row) => row.id === id)!;
          after.push(
            row.position === positions[index]
              ? row
              : await tx.homeBanner.update({
                  where: { id },
                  data: { position: positions[index], updatedByStaffId: staffId, updatedAt: now },
                }),
          );
        }
        await record(
          tx,
          ctx.identity.actor,
          ctx.meta ?? {
            requestId: ctx.identity.requestId,
            ip: null,
            userAgent: null,
            authMethod: null,
            sessionId: null,
          },
          {
            stream: "ops",
            category: "ops_config",
            action: "ops.home_banner.reorder",
            summary: "调整首页轮播顺序",
            before: { ids: rows.map((row) => row.id) },
            after: { ids: input.homeBannerIds },
            fields: ["position"],
          },
        );
        return { items: await views(tx, ctx, after, now) };
      }, options);
      const replayed = options.idem?.replayed ?? false;
      return { items: replayed ? data.items : await Promise.all(data.items.map(sign)), replayed };
    },
    async list(ctx: ConfigActor, raw: z.input<typeof HomeBannerListQuerySchema> = {}) {
      siteActor(ctx);
      const query = HomeBannerListQuerySchema.parse(raw);
      const data = await deps.tx.run(async (tx) => {
        const now = deps.clock.now(),
          all = await tx.homeBanner.findMany(),
          states = query.displayState?.split(",");
        const rows = all
          .filter(
            (row) =>
              (!states || states.includes(bannerState(row, now))) &&
              (query.isEnded === undefined || (!!row.endAt && row.endAt <= now) === query.isEnded),
          )
          .sort((a, b) =>
            query.sort === "position"
              ? a.position - b.position || a.id.localeCompare(b.id)
              : (query.sort === "-startAt"
                  ? b.startAt.getTime() - a.startAt.getTime()
                  : b.createdAt.getTime() - a.createdAt.getTime()) || a.id.localeCompare(b.id),
          );
        return {
          items: await views(
            tx,
            ctx,
            rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
            now,
          ),
          page: query.page,
          pageSize: query.pageSize,
          total: rows.length,
        };
      });
      return HomeBannerPageSchema.parse({
        ...data,
        items: await Promise.all(data.items.map(sign)),
      });
    },
    async summary(ctx: ConfigActor) {
      siteActor(ctx);
      return deps.tx.run(async (tx) => {
        const at = deps.clock.now(),
          rows = await tx.homeBanner.findMany(),
          out = { live: 0, scheduled: 0, ended: 0, disabled: 0, maxActive: await maximum(tx, at) };
        for (const row of rows) out[bannerState(row, at)]++;
        return out;
      });
    },
  };
}
