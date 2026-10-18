import type { Prisma } from "@liyoxi/db";
import {
  z,
  EVENT_PAYLOAD_SCHEMAS,
  DramaPermitCreateBodySchema,
  DramaPermitUpdateBodySchema,
  DramaPermitRetireBodySchema,
  DramaEpisodeUpdateBodySchema,
  DramaDelistBodySchema,
} from "@liyoxi/contract";
import type { DramaPermitCreateBody, DramaPermitUpdateBody } from "@liyoxi/contract";
import { dramaMediaReadiness } from "../media/index.js";
import { calendarDate, addDays, dayRange } from "@liyoxi/shared/time";
import { visible, orderable, stopDate, selectPermits } from "@liyoxi/shared/catalog";
import { AppError, uuidv7, lockRows, bumpLockVersion } from "../kernel/index.js";
import type { Tx, Clock, Assembly } from "../kernel/index.js";
import type { Flow } from "../flow/index.js";
import type { Events, EmitContext } from "../events/index.js";
import type { Media } from "../media/index.js";
import { record } from "../audit/index.js";
import { paramsAt } from "../config/index.js";
import { DramaPricePort } from "./ports.js";
import { assertListing, dateOf, dramaFacts, listingChecks, permitsOf } from "./checks.js";
import { basicInput, commercialInput, copyrightInput, rolesInput } from "./inputs.js";
import type {
  BasicInput,
  CommercialInput,
  CopyrightInput,
  PermitInput,
  RolesInput,
} from "./inputs.js";

export interface ContentDeps {
  readonly events?: Pick<Events, "emit">;
  readonly license?: { rearm(tx: Tx, id: string): Promise<void> };
  readonly clock: Clock;
  readonly flow: Flow;
  readonly media: Pick<Media, "link" | "release"> &
    Partial<Pick<Media, "retireDramaMedia" | "enqueueTrailer">>;
  readonly assembly: Pick<Assembly, "port">;
}
const json = (value: unknown) => value as Prisma.InputJsonValue;
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError("VALIDATION_FAILED", {
      details: {
        fieldErrors: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  return result.data;
};
const metaOf = (ctx: EmitContext) => ({
  requestId: ctx.requestId,
  ip: ctx.ip,
  userAgent: ctx.userAgent,
  authMethod: null,
  sessionId: null,
  ...(ctx.actor.client === "cli" ? { jobName: "cli.demo_seed" } : {}),
});
const staff = (ctx: EmitContext): string => {
  if (ctx.actor.type !== "staff" || !ctx.actor.id) throw new AppError("PERMISSION_DENIED");
  return ctx.actor.id;
};
async function audit(
  tx: Tx,
  ctx: EmitContext,
  id: string,
  action: `${string}.${string}.${string}`,
  summary: string,
  before: object,
  after: object,
  fields: readonly string[],
) {
  await record(
    tx,
    ctx.actor,
    {
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      authMethod: null,
      sessionId: null,
      ...(ctx.actor.client === "cli" ? { jobName: "cli.demo_seed" } : {}),
    },
    {
      stream: "activity",
      category: "flow",
      action,
      summary,
      target: { type: "drama", id },
      before,
      after,
      fields,
    },
  );
}
async function editable(tx: Tx, id: string) {
  await lockRows(tx, "drama", [id]);
  const row = await tx.drama.findUnique({ where: { id } });
  if (!row) throw new AppError("NOT_FOUND");
  if (row.archivedAt) throw new AppError("DRAMA_ARCHIVED");
  return row;
}
async function dicts(
  tx: Tx,
  type: string,
  selected: readonly string[] | undefined,
  previous: readonly string[],
  primary = false,
) {
  if (!selected) return;
  for (const code of selected.filter((code) => !previous.includes(code))) {
    await tx.$queryRaw`SELECT id FROM dict_item WHERE dict_type_key=${type} AND code=${code} ORDER BY id FOR SHARE`;
    const row = await tx.dictItem.findUnique({
      where: { dictTypeKey_code: { dictTypeKey: type, code } },
    });
    const ext = row?.ext as { open?: boolean } | undefined;
    if (!row?.isEnabled || (primary && (row.parentCode !== null || ext?.open !== true)))
      throw new AppError("DICT_ITEM_DISABLED", { details: { dictTypeKey: type, code } });
  }
}
export function createContent(deps: ContentDeps) {
  const prices = deps.assembly.port(DramaPricePort);
  const checks = (tx: Tx, id: string, at = deps.clock.now()) => listingChecks(tx, id, at, prices);
  const assertSaved = async (tx: Tx, id: string, status: string) => {
    if (status !== "listed") return;
    const result = await checks(tx, id);
    const failed = result.items.filter(
      (v) => v.severity === "block" && !v.isOk && v.code !== "L12",
    );
    if (failed.length)
      throw new AppError("LISTING_CHECK_FAILED", {
        details: { failed: failed.map(({ code, note }) => ({ code, note })) },
      });
  };
  const readiness = async (tx: Tx, id: string, at = deps.clock.now()) => {
    const facts = await dramaFacts(tx, id);
    return dramaMediaReadiness(
      tx,
      {
        dramaId: id,
        totalEpisodes: facts.drama.totalEpisodes,
        posterFileId: facts.drama.posterFileId,
        episodeNos: facts.episodes.map((v) => v.episodeNo),
      },
      at,
    );
  };
  const permitEvent = async (
    tx: Tx,
    ctx: EmitContext,
    permit: { id: string; dramaId: string; platform: string },
  ) => {
    if (!deps.events) throw new AppError("PROVIDER_UNAVAILABLE");
    await deps.events.emit(tx, ctx, {
      type: "drama.permit_changed",
      aggregate: { type: "drama", id: permit.dramaId },
      payload: {
        v: 1,
        dramaId: permit.dramaId,
        dramaPermitId: permit.id,
        platform: parse(DramaPermitCreateBodySchema.shape.platform, permit.platform),
      },
    });
  };
  const link = async (
    tx: Tx,
    ids: readonly string[],
    refType: string,
    refId: string,
    role: string,
  ) => {
    await lockRows(tx, "file_object", ids);
    for (const fileId of ids)
      await deps.media.link(tx, { fileId, refType, refId, role, entityId: null, storeId: null });
  };
  return {
    listingChecks: checks,
    mediaReadiness: readiness,
    async createDraft(tx: Tx, ctx: EmitContext, input: { title: string }) {
      const title = parse(
        z
          .string()
          .refine(
            (value) => [...value].length >= 1 && [...value].length <= 20 && value.trim().length > 0,
          ),
        input.title,
      );
      const id = uuidv7(),
        now = deps.clock.now(),
        actor = staff(ctx);
      await tx.drama.create({
        data: {
          id,
          title,
          status: "draft",
          statusChangedAt: now,
          createdByStaffId: actor,
          updatedByStaffId: actor,
          createdAt: now,
          updatedAt: now,
        },
      });
      await tx.dramaCopyright.create({ data: { dramaId: id, createdAt: now, updatedAt: now } });
      await deps.flow.transition(tx, ctx, {
        machine: "drama",
        stateField: "status",
        id,
        event: "drama.create",
        created: true,
        meta: metaOf(ctx),
        emit: { type: "drama.created", payload: { v: 1, dramaId: id } },
      });
      return tx.drama.findUniqueOrThrow({ where: { id } });
    },
    async saveBasic(tx: Tx, ctx: EmitContext, id: string, raw: BasicInput) {
      const input = parse(basicInput, raw),
        before = await editable(tx, id),
        actor = staff(ctx),
        now = deps.clock.now();
      if (input.totalEpisodes !== undefined && input.totalEpisodes !== before.totalEpisodes) {
        if (before.status === "listed")
          throw new AppError("TOTAL_EPISODES_LOCKED", {
            details: { currentTotalEpisodes: before.totalEpisodes },
          });
        const media = await readiness(tx, id, now);
        const removed = media.allCurrentMasterEpisodeNos.filter(
          (no) => no > (input.totalEpisodes ?? 0),
        );
        if (removed.length)
          throw new AppError("EPISODE_HAS_MASTER", { details: { episodeNos: removed } });
      }
      await dicts(tx, "genre", input.genreCodes, before.genreCodes);
      await dicts(tx, "selling_tag", input.sellingTagCodes, before.sellingTagCodes);
      if (
        input.dramaClass &&
        input.dramaClass !== "class_3" &&
        before.allowedPlacements.some((slot) => !["opening", "ending"].includes(slot))
      )
        throw new AppError("PLACEMENT_NOT_OPEN");
      await bumpLockVersion(tx, { table: "drama", id, expected: input.lockVersion });
      const { lockVersion: _version, ...data } = input;
      const after = await tx.drama.update({
        where: { id },
        data: { ...data, updatedByStaffId: actor, updatedAt: now },
      });
      if (input.totalEpisodes !== undefined) {
        const n = input.totalEpisodes ?? 0;
        await tx.dramaEpisode.deleteMany({ where: { dramaId: id, episodeNo: { gt: n } } });
        const current = new Set(
          (
            await tx.dramaEpisode.findMany({ where: { dramaId: id }, select: { episodeNo: true } })
          ).map((row) => row.episodeNo),
        );
        const missing = Array.from({ length: n }, (_, index) => index + 1).filter(
          (no) => !current.has(no),
        );
        if (missing.length)
          await tx.dramaEpisode.createMany({
            data: missing.map((episodeNo) => ({
              id: uuidv7(),
              dramaId: id,
              episodeNo,
              createdAt: now,
              updatedAt: now,
            })),
          });
      }
      if (input.posterFileId && input.posterFileId !== before.posterFileId)
        await link(tx, [input.posterFileId], "drama", id, "poster");
      await audit(
        tx,
        ctx,
        id,
        "content.drama.basic_update",
        "更新短剧基础信息",
        before,
        after,
        Object.keys(data),
      );
      await assertSaved(tx, id, before.status);
      return after;
    },
    async saveCommercial(tx: Tx, ctx: EmitContext, id: string, raw: CommercialInput) {
      const input = parse(commercialInput, raw),
        before = await editable(tx, id),
        actor = staff(ctx),
        now = deps.clock.now();
      await dicts(tx, "industry", input.industryCodes, before.industryCodes, true);
      if (input.allowedPlacements) {
        const params = await paramsAt(tx, ["content.placement.open_slots"], now);
        if (
          input.allowedPlacements.some(
            (slot) =>
              !params["content.placement.open_slots"].includes(slot) ||
              (before.dramaClass !== "class_3" && !["opening", "ending"].includes(slot)),
          )
        )
          throw new AppError("PLACEMENT_NOT_OPEN");
      }
      await bumpLockVersion(tx, { table: "drama", id, expected: input.lockVersion });
      const { lockVersion: _version, ...data } = input;
      const after = await tx.drama.update({
        where: { id },
        data: { ...data, updatedByStaffId: actor, updatedAt: now },
      });
      await audit(
        tx,
        ctx,
        id,
        "content.drama.commercial_update",
        "更新短剧商业信息",
        before,
        after,
        Object.keys(data),
      );
      if (before.heatTier !== after.heatTier) {
        if (!deps.events) throw new AppError("PROVIDER_UNAVAILABLE");
        await audit(
          tx,
          ctx,
          id,
          "drama.heat_tier.change",
          "修改热度等级",
          { heatTier: before.heatTier },
          { heatTier: after.heatTier },
          ["heatTier"],
        );
        await deps.events.emit(tx, ctx, {
          type: "drama.tier_changed",
          aggregate: { type: "drama", id },
          payload: EVENT_PAYLOAD_SCHEMAS["drama.tier_changed"].parse({
            v: 1,
            dramaId: id,
            fromTier: before.heatTier,
            toTier: after.heatTier,
          }),
        });
      }
      await assertSaved(tx, id, before.status);
      return after;
    },
    async saveRoles(tx: Tx, ctx: EmitContext, id: string, raw: RolesInput) {
      const input = parse(rolesInput, raw),
        before = await editable(tx, id);
      staff(ctx);
      await bumpLockVersion(tx, { table: "drama", id, expected: input.lockVersion });
      const after = await tx.drama.update({
        where: { id },
        data: {
          roles: json(input.roles.map((row) => ({ ...row, actor: row.actor ?? null }))),
          updatedByStaffId: staff(ctx),
          updatedAt: deps.clock.now(),
        },
      });
      await audit(tx, ctx, id, "content.drama.roles_update", "更新角色介绍", before, after, [
        "roles",
      ]);
      return after;
    },
    async saveCopyrightDraft(tx: Tx, ctx: EmitContext, id: string, raw: CopyrightInput) {
      const input = parse(copyrightInput, raw),
        drama = await editable(tx, id);
      staff(ctx);
      if (drama.firstListedAt) throw new AppError("COPYRIGHT_REVISION_REQUIRED");
      const before = await tx.dramaCopyright.findUniqueOrThrow({ where: { dramaId: id } }),
        now = deps.clock.now();
      await bumpLockVersion(tx, {
        table: "drama_copyright",
        id,
        expected: input.lockVersion,
        key: { column: "drama_id", type: "uuid" },
      });
      const { lockVersion: _version, licenseStartDate, licenseEndDate, ...data } = input;
      const after = await tx.dramaCopyright.update({
        where: { dramaId: id },
        data: {
          ...data,
          licenseStartDate: licenseStartDate ? new Date(`${licenseStartDate}T00:00:00Z`) : null,
          licenseEndDate: licenseEndDate ? new Date(`${licenseEndDate}T00:00:00Z`) : null,
          updatedAt: now,
        },
      });
      const newIds = input.proofFileIds.filter((fileId) => !before.proofFileIds.includes(fileId)),
        removed = before.proofFileIds.filter((fileId) => !input.proofFileIds.includes(fileId));
      await lockRows(tx, "file_object", [...newIds, ...removed]);
      await link(tx, newIds, "drama_copyright", id, "proof");
      for (const fileId of removed)
        await deps.media.release(tx, {
          fileId,
          refType: "drama_copyright",
          refId: id,
          role: "proof",
          entityId: null,
          storeId: null,
          keepUntil: dayRange(addDays(calendarDate(now), 30)).start,
        });
      await audit(
        tx,
        ctx,
        id,
        "content.drama.copyright_update",
        "填写版权信息并上传授权合同",
        before,
        after,
        Object.keys(data).concat("licenseStartDate", "licenseEndDate"),
      );
      return after;
    },
    async createPermit(
      tx: Tx,
      ctx: EmitContext,
      id: string,
      raw: PermitInput | DramaPermitCreateBody,
    ) {
      const input = parse(DramaPermitCreateBodySchema, raw),
        before = await editable(tx, id),
        now = deps.clock.now();
      let retired = null;
      if (input.replacesDramaPermitId) {
        const previous = await tx.dramaPermit.findUnique({
          where: { id: input.replacesDramaPermitId },
        });
        if (!previous || previous.dramaId !== id) throw new AppError("NOT_FOUND");
        if (previous.status !== "active") throw new AppError("STATE_NOT_ALLOWED");
        retired = await tx.dramaPermit.update({
          where: { id: previous.id },
          data: {
            status: "retired",
            retiredAt: now,
            retireReason: input.retireReason!,
            updatedAt: now,
          },
        });
        await permitEvent(tx, ctx, retired);
      }
      if (
        await tx.dramaPermit.findFirst({
          where: {
            dramaId: id,
            platform: input.platform,
            permitKind: input.permitKind,
            status: "active",
          },
        })
      )
        throw new AppError("PERMIT_ACTIVE_EXISTS", {
          details: { platform: input.platform, permitKind: input.permitKind },
        });
      const permit = await tx.dramaPermit.create({
        data: {
          id: uuidv7(),
          dramaId: id,
          platform: input.platform,
          permitKind: input.permitKind,
          status: "active",
          permitNo: input.permitNo,
          scanFileIds: input.scanFileIds,
          note: input.note ?? null,
          createdByStaffId: staff(ctx),
          createdAt: now,
          updatedAt: now,
        },
      });
      const released = retired && !before.firstListedAt ? retired.scanFileIds : [];
      await lockRows(tx, "file_object", [...input.scanFileIds, ...released]);
      await link(tx, input.scanFileIds, "drama_permit", permit.id, "scan");
      if (retired)
        for (const fileId of released)
          await deps.media.release(tx, {
            fileId,
            refType: "drama_permit",
            refId: retired.id,
            role: "scan",
            entityId: null,
            storeId: null,
            keepUntil: dayRange(addDays(calendarDate(now), 30)).start,
          });
      await tx.drama.update({
        where: { id },
        data: { lockVersion: { increment: 1 }, updatedByStaffId: staff(ctx), updatedAt: now },
      });
      await assertSaved(tx, id, before.status);
      await audit(
        tx,
        ctx,
        id,
        "content.drama.permit_create",
        "填写短剧许可信息",
        before,
        { ...before, permit },
        ["permit"],
      );
      await permitEvent(tx, ctx, permit);
      return permit;
    },
    async updatePermit(tx: Tx, ctx: EmitContext, id: string, raw: DramaPermitUpdateBody) {
      const input = parse(DramaPermitUpdateBodySchema, raw);
      const found = await tx.dramaPermit.findUnique({ where: { id }, select: { dramaId: true } });
      if (!found) throw new AppError("NOT_FOUND");
      const drama = await editable(tx, found.dramaId);
      const before = await tx.dramaPermit.findUniqueOrThrow({ where: { id } });
      if (before.status !== "active") throw new AppError("STATE_NOT_ALLOWED");
      if (
        drama.firstListedAt &&
        ((input.platform !== undefined && input.platform !== before.platform) ||
          (input.permitKind !== undefined && input.permitKind !== before.permitKind) ||
          (input.permitNo !== undefined && input.permitNo !== before.permitNo))
      )
        throw new AppError("PERMIT_FROZEN");
      const { dramaLockVersion, ...data } = input;
      if (
        await tx.dramaPermit.findFirst({
          where: {
            dramaId: drama.id,
            id: { not: id },
            status: "active",
            platform: data.platform ?? before.platform,
            permitKind: data.permitKind ?? before.permitKind,
          },
        })
      )
        throw new AppError("PERMIT_ACTIVE_EXISTS", {
          details: {
            platform: data.platform ?? before.platform,
            permitKind: data.permitKind ?? before.permitKind,
          },
        });
      await bumpLockVersion(tx, { table: "drama", id: drama.id, expected: dramaLockVersion });
      const now = deps.clock.now();
      const after = await tx.dramaPermit.update({
        where: { id },
        data: { ...data, updatedAt: now },
      });
      const added = after.scanFileIds.filter((v) => !before.scanFileIds.includes(v));
      const removed = drama.firstListedAt
        ? []
        : before.scanFileIds.filter((v) => !after.scanFileIds.includes(v));
      await lockRows(tx, "file_object", [...added, ...removed]);
      await link(tx, added, "drama_permit", id, "scan");
      for (const fileId of removed)
        await deps.media.release(tx, {
          fileId,
          refType: "drama_permit",
          refId: id,
          role: "scan",
          entityId: null,
          storeId: null,
          keepUntil: dayRange(addDays(calendarDate(now), 30)).start,
        });
      await tx.drama.update({
        where: { id: drama.id },
        data: { updatedByStaffId: staff(ctx), updatedAt: now },
      });
      await assertSaved(tx, drama.id, drama.status);
      await audit(
        tx,
        ctx,
        drama.id,
        "content.drama.permit_update",
        "更新短剧许可信息",
        before,
        after,
        Object.keys(data),
      );
      return after;
    },
    async retirePermit(tx: Tx, ctx: EmitContext, id: string, raw: unknown) {
      const input = parse(DramaPermitRetireBodySchema, raw),
        found = await tx.dramaPermit.findUnique({ where: { id }, select: { dramaId: true } });
      if (!found) throw new AppError("NOT_FOUND");
      const drama = await editable(tx, found.dramaId);
      const before = await tx.dramaPermit.findUniqueOrThrow({ where: { id } });
      if (before.status !== "active") throw new AppError("STATE_NOT_ALLOWED");
      const now = deps.clock.now(),
        after = await tx.dramaPermit.update({
          where: { id },
          data: {
            status: "retired",
            retiredAt: now,
            retireReason: input.retireReason,
            updatedAt: now,
          },
        });
      if (!drama.firstListedAt) {
        await lockRows(tx, "file_object", before.scanFileIds);
        for (const fileId of before.scanFileIds)
          await deps.media.release(tx, {
            fileId,
            refType: "drama_permit",
            refId: id,
            role: "scan",
            entityId: null,
            storeId: null,
            keepUntil: dayRange(addDays(calendarDate(now), 30)).start,
          });
      }
      await tx.drama.update({
        where: { id: drama.id },
        data: { lockVersion: { increment: 1 }, updatedByStaffId: staff(ctx), updatedAt: now },
      });
      await assertSaved(tx, drama.id, drama.status);
      await audit(
        tx,
        ctx,
        drama.id,
        "content.drama.permit_retire",
        "停用短剧许可信息",
        before,
        after,
        ["status", "retiredAt", "retireReason"],
      );
      await permitEvent(tx, ctx, after);
      return after;
    },
    async updateEpisode(tx: Tx, ctx: EmitContext, id: string, raw: unknown) {
      const input = parse(DramaEpisodeUpdateBodySchema, raw),
        found = await tx.dramaEpisode.findUnique({ where: { id }, select: { dramaId: true } });
      if (!found) throw new AppError("NOT_FOUND");
      const drama = await editable(tx, found.dramaId),
        before = await tx.dramaEpisode.findUniqueOrThrow({ where: { id } });
      await bumpLockVersion(tx, { table: "drama", id: drama.id, expected: input.dramaLockVersion });
      const now = deps.clock.now(),
        after = await tx.dramaEpisode.update({
          where: { id },
          data: { title: input.title, updatedAt: now },
        });
      await tx.drama.update({
        where: { id: drama.id },
        data: { updatedByStaffId: staff(ctx), updatedAt: now },
      });
      await audit(
        tx,
        ctx,
        drama.id,
        "content.drama.episode_update",
        "更新剧集标题",
        before,
        after,
        ["title"],
      );
      return after;
    },
    async list(tx: Tx, ctx: EmitContext, id: string) {
      const before = await editable(tx, id),
        now = deps.clock.now();
      staff(ctx);
      if (before.status === "listed") throw new AppError("STATE_NOT_ALLOWED");
      const isRelist = before.status === "delisted";
      const result = await checks(tx, id, now);
      assertListing(result);
      await deps.flow.transition(tx, ctx, {
        machine: "drama",
        stateField: "status",
        id,
        event: isRelist ? "drama.relist" : "drama.list",
        meta: metaOf(ctx),
        set: {
          ...(isRelist ? {} : { first_listed_at: now }),
          listed_at: now,
          updated_by_staff_id: staff(ctx),
        },
        payload: {
          passed: result.isShelvable,
          total: result.total,
          items: result.items.map(({ code, severity, isOk }) => ({ code, severity, ok: isOk })),
        },
        args: { prices, media: deps.media },
        emit: { type: "drama.listed", payload: { v: 1, dramaId: id, isRelist } },
      });
      await deps.license?.rearm(tx, id);
      return tx.drama.findUniqueOrThrow({ where: { id: before.id } });
    },
    async delist(tx: Tx, ctx: EmitContext, id: string, raw: unknown) {
      const input = parse(DramaDelistBodySchema, raw),
        before = await editable(tx, id),
        now = deps.clock.now();
      if (before.status !== "listed") throw new AppError("STATE_NOT_ALLOWED");
      await deps.flow.transition(tx, ctx, {
        machine: "drama",
        stateField: "status",
        id,
        event: "drama.delist",
        meta: metaOf(ctx),
        set: {
          delisted_at: now,
          delist_reason_code: input.reasonCode,
          delist_note: input.note ?? null,
          updated_by_staff_id: staff(ctx),
        },
        reasonCode: input.reasonCode,
        note: input.note ?? null,
        emit: {
          type: "drama.delisted",
          payload: { v: 1, dramaId: id, reasonCode: input.reasonCode },
        },
      });
      if (!deps.license) throw new AppError("PROVIDER_UNAVAILABLE");
      await deps.license.rearm(tx, id);
      if (input.reasonCode === "rights_issue") {
        if (!deps.media.retireDramaMedia) throw new AppError("PROVIDER_UNAVAILABLE");
        await deps.media.retireDramaMedia(tx, id, { scope: "trailer", immediate: true });
      }
      return tx.drama.findUniqueOrThrow({ where: { id } });
    },
    async replaceTrailer(tx: Tx, ctx: EmitContext, id: string, fileId: string) {
      await editable(tx, id);
      if (!deps.media.enqueueTrailer) throw new AppError("PROVIDER_UNAVAILABLE");
      await deps.media.enqueueTrailer(tx, { dramaId: id, fileId, staffId: staff(ctx) });
      const now = deps.clock.now();
      await tx.drama.update({
        where: { id },
        data: { lockVersion: { increment: 1 }, updatedByStaffId: staff(ctx), updatedAt: now },
      });
      await audit(
        tx,
        ctx,
        id,
        "content.drama.trailer_replace",
        "设置短剧预告片",
        {},
        { sourceFileId: fileId },
        ["sourceFileId"],
      );
      return readiness(tx, id, now);
    },
    async getDramaCards(tx: Tx, ids: readonly string[], at = deps.clock.now()) {
      const rows = await tx.drama.findMany({
        where: { id: { in: [...ids] } },
        include: { dramaCopyrights: true },
      });
      const priceMap = await prices.priceAt(tx, ids, at);
      return rows.map((row) => ({
        ...row,
        listPricePoints:
          typeof priceMap.get(row.id) === "object"
            ? (priceMap.get(row.id) as { points: number }).points
            : null,
        priceVersion:
          typeof priceMap.get(row.id) === "object"
            ? (priceMap.get(row.id) as { source: object }).source
            : null,
        licenseEndDate: dateOf(row.dramaCopyrights[0]?.licenseEndDate ?? null),
        usableUntilDate: dateOf(row.dramaCopyrights[0]?.licenseEndDate ?? null),
      }));
    },
    async visibleCatalog(tx: Tx, at = deps.clock.now()) {
      const ids = (
        await tx.drama.findMany({
          where: { status: "listed", archivedAt: null },
          select: { id: true },
        })
      ).map((row) => row.id);
      const rows = await this.getDramaCards(tx, ids, at),
        months = await prices.minLicenseMonths(tx, at);
      return rows.filter((row) =>
        visible(
          {
            status: row.status,
            archivedAt: row.archivedAt,
            licenseEndDate: row.licenseEndDate,
            minLicenseMonths: months,
          },
          calendarDate(at),
        ),
      );
    },
    async getOrderability(tx: Tx, ids: readonly string[], today = calendarDate(deps.clock.now())) {
      const rows = await this.getDramaCards(tx, ids),
        months = await prices.minLicenseMonths(tx, deps.clock.now());
      return new Map(
        rows.map((row) => [
          row.id,
          {
            dramaId: row.id,
            orderable: visible(
              {
                status: row.status,
                archivedAt: row.archivedAt,
                licenseEndDate: row.licenseEndDate,
                minLicenseMonths: months,
              },
              today,
            ),
            reason:
              row.status !== "listed" || row.archivedAt
                ? ("not_listed" as const)
                : row.licenseEndDate === null || today >= stopDate(row.licenseEndDate, months)
                  ? ("stopped" as const)
                  : null,
            stopDate: row.licenseEndDate ? stopDate(row.licenseEndDate, months) : null,
            licenseEndDate: row.licenseEndDate,
          },
        ]),
      );
    },
    async assertOrderable(
      tx: Tx,
      id: string,
      platforms: readonly string[],
      today = calendarDate(deps.clock.now()),
    ) {
      const facts = await dramaFacts(tx, id),
        months = await prices.minLicenseMonths(tx, deps.clock.now()),
        params = await paramsAt(tx, ["content.permit.platform_check"], deps.clock.now());
      const { drama: d, copyright: c, permits } = facts,
        licenseEndDate = dateOf(c?.licenseEndDate ?? null);
      if (
        !orderable(
          {
            status: d.status,
            archivedAt: d.archivedAt,
            licenseEndDate,
            minLicenseMonths: months,
            platforms: c?.platforms ?? [],
            permits: permitsOf(permits),
            dramaClass: d.dramaClass,
            permitCheck: params["content.permit.platform_check"],
          },
          platforms,
          today,
        )
      )
        throw new AppError("DRAMA_NOT_ORDERABLE", {
          details: {
            dramaId: id,
            reason:
              d.status !== "listed" || d.archivedAt
                ? "not_listed"
                : !licenseEndDate || today >= stopDate(licenseEndDate, months)
                  ? "stopped"
                  : platforms.some((platform) => !c?.platforms.includes(platform))
                    ? "platform_not_licensed"
                    : "permit_missing",
          },
        });
      const selected = [
        ...new Map(
          platforms
            .flatMap((platform) => selectPermits(permitsOf(permits), platform))
            .map((row) => [`${row.platform}/${row.kind}`, row]),
        ).values(),
      ];
      return {
        dramaId: id,
        title: d.title,
        totalEpisodes: d.totalEpisodes!,
        dramaClass: d.dramaClass,
        genreCodes: d.genreCodes,
        permits: selected.map(({ platform, kind, number }) => ({ platform, kind, number })),
        licenseEndDate: licenseEndDate!,
        posterFileId: d.posterFileId,
        allowedPlacements: d.allowedPlacements,
        isAiGenerated: d.isAiGenerated,
      };
    },
  };
}
export type Content = ReturnType<typeof createContent>;
