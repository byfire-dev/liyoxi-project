import {
  SiteConfigDraftBodySchema,
  SiteConfigPublishBodySchema,
  SiteConfigRevisionViewSchema,
  SiteConfigDraftViewSchema,
  SiteConfigRevisionsQuerySchema,
  SiteConfigViewSchema,
  SiteConfigRevisionsPageSchema,
} from "@liyoxi/contract";
import type { z } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { AppError, uuidv7 } from "../kernel/index.js";
import type { Tx, TxRunOptions } from "../kernel/index.js";
import { auditConfig } from "./admin-context.js";
import type { ConfigActor } from "./admin-context.js";
import { siteActor } from "./site-context.js";
import type { SiteAdminDeps } from "./site-context.js";
import { parseSite, siteRefs } from "./site-refs.js";
import type { SiteKey } from "./site-refs.js";
import { createHomeBanners } from "./home-banners.js";
import { listSiteNotices, readHomeNotice } from "./notice-read.js";
type Revision = Prisma.SiteConfigRevisionGetPayload<object>;
export function createSiteAdmin(deps: SiteAdminDeps) {
  async function published(tx: Tx, key: SiteKey, lock = false) {
    if (lock)
      await tx.$queryRaw`SELECT id FROM site_config_revision WHERE config_key=${key} AND status='published' FOR UPDATE`;
    const row = await tx.siteConfigRevision.findFirst({
      where: { configKey: key, status: "published" },
    });
    if (!row) throw new AppError("NOT_FOUND");
    return row;
  }
  async function draft(tx: Tx, key: SiteKey, lock = false) {
    if (lock)
      await tx.$queryRaw`SELECT id FROM site_config_revision WHERE config_key=${key} AND status='draft' FOR UPDATE`;
    return tx.siteConfigRevision.findFirst({ where: { configKey: key, status: "draft" } });
  }
  async function draftConflict(tx: Tx, row: Revision | null): Promise<never> {
    throw new AppError("VERSION_CONFLICT", {
      details: {
        lockVersion: row?.lockVersion ?? null,
        savedBy: row?.createdByStaffId
          ? ((await deps.staffBriefs(tx, [row.createdByStaffId]))[0] ?? null)
          : null,
        savedAt: row?.updatedAt.toISOString() ?? null,
      },
    });
  }
  async function view(tx: Tx, row: Revision) {
    const ids = [row.createdByStaffId, row.publishedByStaffId].filter(
      (id): id is string => id !== null,
    );
    const people = await deps.staffBriefs(tx, ids);
    const brief = (id: string | null) => people.find((person) => person.staffId === id) ?? null;
    const content = parseSite(row.configKey as SiteKey, row.content);
    return row.status === "draft"
      ? SiteConfigDraftViewSchema.parse({
          siteConfigRevisionId: row.id,
          baseRevNo: row.baseRevNo,
          content,
          note: row.note,
          lockVersion: row.lockVersion,
          createdBy: brief(row.createdByStaffId),
          updatedAt: row.updatedAt.toISOString(),
        })
      : SiteConfigRevisionViewSchema.parse({
          siteConfigRevisionId: row.id,
          revNo: row.revNo,
          status: row.status,
          content,
          note: row.note,
          publishedAt: row.publishedAt?.toISOString(),
          publishedBy: brief(row.publishedByStaffId),
        });
  }
  async function fullView(tx: Tx, key: SiteKey) {
    const pub = await published(tx, key),
      saved = await draft(tx, key);
    return SiteConfigViewSchema.parse({
      configKey: key,
      published: await view(tx, pub),
      draft: saved ? await view(tx, saved) : null,
      refs: await siteRefs(tx, deps, key, saved?.content ?? pub.content, deps.clock.now()),
    });
  }
  async function write<T>(fn: (tx: Tx) => Promise<T>, options: TxRunOptions = {}) {
    let changed = false;
    const data = await deps.tx.run(async (tx) => {
      const value = await fn(tx);
      changed = true;
      return value;
    }, options);
    if (changed) await deps.config.cache.bump("site");
    return data;
  }
  const banners = createHomeBanners(deps);
  return {
    async get(ctx: ConfigActor, key: SiteKey) {
      siteActor(ctx);
      return deps.tx.run((tx) => fullView(tx, key));
    },
    async replaceDraft(
      ctx: ConfigActor,
      key: SiteKey,
      raw: z.input<typeof SiteConfigDraftBodySchema>,
      options: TxRunOptions = {},
    ) {
      const staffId = siteActor(ctx, true),
        input = SiteConfigDraftBodySchema.parse(raw),
        content = parseSite(key, input.content);
      // 草稿替换不发布、不变更已发布缓存版本。不存在的草稿由唯一索引仲裁。
      return deps.tx.run(async (tx) => {
        const before = await draft(tx, key, true);
        if (before ? input.lockVersion !== before.lockVersion : input.lockVersion !== null)
          return draftConflict(tx, before);
        await published(tx, key);
        const now = deps.clock.now();
        let after: Revision;
        if (before)
          after = await tx.siteConfigRevision.update({
            where: { id: before.id },
            data: {
              content: content as Prisma.InputJsonValue,
              baseRevNo: input.baseRevNo,
              note: input.note ?? null,
              lockVersion: { increment: 1 },
              updatedAt: now,
            },
          });
        else {
          const id = uuidv7();
          const rows = await tx.$queryRaw<
            { id: string }[]
          >`INSERT INTO site_config_revision(id,config_key,status,content,base_rev_no,note,lock_version,created_by_staff_id,created_at,updated_at) VALUES(${id}::uuid,${key},'draft',${JSON.stringify(content)}::jsonb,${input.baseRevNo},${input.note ?? null},0,${staffId}::uuid,${now},${now}) ON CONFLICT(config_key) WHERE status='draft' DO NOTHING RETURNING id::text`;
          if (!rows.length) return draftConflict(tx, await draft(tx, key));
          after = await tx.siteConfigRevision.findUniqueOrThrow({ where: { id } });
        }
        await auditConfig(
          tx,
          ctx,
          "ops_config",
          "ops.site_config.save_draft",
          { type: "site_config_revision", id: after.id },
          before,
          after,
          input.note,
        );
        return fullView(tx, key);
      }, options);
    },
    async publish(
      ctx: ConfigActor,
      key: SiteKey,
      raw: z.input<typeof SiteConfigPublishBodySchema>,
      options: TxRunOptions = {},
    ) {
      const staffId = siteActor(ctx, true),
        input = SiteConfigPublishBodySchema.parse(raw);
      return write(async (tx) => {
        const saved = await draft(tx, key, true);
        if (!saved) {
          await published(tx, key);
          throw new AppError("STATE_NOT_ALLOWED");
        }
        if (saved.lockVersion !== input.lockVersion) return draftConflict(tx, saved);
        const pub = await published(tx, key, true);
        if (pub.revNo !== input.baseRevNo || saved.baseRevNo !== pub.revNo)
          throw new AppError("CONFIG_REV_CONFLICT", {
            details: {
              publishedRevNo: pub.revNo,
              publishedAt: pub.publishedAt?.toISOString(),
              publishedByName: pub.publishedByStaffId
                ? ((await deps.staffBriefs(tx, [pub.publishedByStaffId]))[0]?.name ?? null)
                : null,
            },
          });
        const content = parseSite(key, saved.content),
          now = deps.clock.now(),
          refs = await siteRefs(tx, deps, key, content, now);
        if (refs.invalidRefs.length)
          throw new AppError("CONFIG_REF_INVALID", { details: { items: refs.invalidRefs } });
        await tx.siteConfigRevision.update({
          where: { id: pub.id },
          data: { status: "archived", updatedAt: now },
        });
        const after = await tx.siteConfigRevision.update({
          where: { id: saved.id },
          data: {
            status: "published",
            revNo: pub.revNo! + 1,
            publishedAt: now,
            publishedByStaffId: staffId,
            updatedAt: now,
          },
        });
        await auditConfig(
          tx,
          ctx,
          "ops_config",
          "ops.site_config.publish",
          { type: "site_config_revision", id: after.id },
          saved,
          after,
          saved.note ?? undefined,
        );
        return fullView(tx, key);
      }, options);
    },
    async revisions(
      ctx: ConfigActor,
      key: SiteKey,
      raw: z.input<typeof SiteConfigRevisionsQuerySchema> = {},
    ) {
      siteActor(ctx);
      const query = SiteConfigRevisionsQuerySchema.parse(raw);
      return deps.tx.run(async (tx) => {
        await published(tx, key);
        const where = {
          configKey: key,
          status: { in: query.status?.split(",") ?? ["published", "archived"] },
        };
        const [rows, total] = await Promise.all([
          tx.siteConfigRevision.findMany({
            where,
            orderBy: { revNo: "desc" },
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
          }),
          tx.siteConfigRevision.count({ where }),
        ]);
        return SiteConfigRevisionsPageSchema.parse({
          items: await Promise.all(rows.map((row) => view(tx, row))),
          page: query.page,
          pageSize: query.pageSize,
          total,
        });
      });
    },
    banners,
    homeNotice: (tx: Tx, at: Date, mode: "in_app" | "offline_contract" | "hidden") =>
      readHomeNotice(tx, at, mode, deps.noticeLink),
    async notices(ctx: ConfigActor, query: Parameters<typeof listSiteNotices>[3] = {}) {
      siteActor(ctx, false, true);
      return deps.tx.run((tx) => listSiteNotices(tx, deps, ctx, query));
    },
  };
}
export type SiteAdmin = ReturnType<typeof createSiteAdmin>;
