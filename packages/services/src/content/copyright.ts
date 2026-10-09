import type { Prisma } from "@liyoxi/db";
import {
  CopyrightRevisionCreateBodySchema,
  CopyrightReplaceBodySchema,
  ConfirmPermitRecheckBodySchema,
  EVENT_PAYLOAD_SCHEMAS,
} from "@liyoxi/contract";
import type { CopyrightRevisionCreateBody, CopyrightReplaceBody } from "@liyoxi/contract";
import { addDays, calendarDate, dayRange } from "@liyoxi/shared/time";
import { record } from "../audit/index.js";
import { AppError, bumpLockVersion, lockRows, uuidv7 } from "../kernel/index.js";
import type { Clock, Tx } from "../kernel/index.js";
import type { Media } from "../media/index.js";
import type { Events, EmitContext } from "../events/index.js";
import type { DramaPrices } from "./ports.js";
import { dateOf, listingChecks } from "./checks.js";
import type { ContentLicense } from "./license-expiry.js";
export interface ContentCopyrightDeps {
  clock: Clock;
  media: Pick<Media, "link" | "release">;
  events: Pick<Events, "emit">;
  prices: DramaPrices;
  license: Pick<ContentLicense, "rearm">;
}
function checked<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError("VALIDATION_FAILED");
  return parsed.data;
}
export function copyrightSnapshot(row: {
  source: string | null;
  platforms: string[];
  territory: string | null;
  hasNetworkRight: boolean;
  canSublicense: boolean;
  canEditEmbed: boolean;
  canAdapt: boolean;
  licenseStartDate: Date | null;
  licenseEndDate: Date | null;
  proofFileIds: string[];
}) {
  return {
    source: row.source,
    platforms: row.platforms,
    territory: row.territory,
    hasNetworkRight: row.hasNetworkRight,
    canSublicense: row.canSublicense,
    canEditEmbed: row.canEditEmbed,
    canAdapt: row.canAdapt,
    licenseStartDate: dateOf(row.licenseStartDate),
    licenseEndDate: dateOf(row.licenseEndDate),
    proofFileIds: row.proofFileIds,
  };
}
const canonical = (v: unknown) => JSON.stringify(v);
const sameSnapshot = (row: ReturnType<typeof copyrightSnapshot>) =>
  canonical({
    ...row,
    platforms: [...row.platforms].sort(),
    proofFileIds: [...row.proofFileIds].sort(),
  });
const fields = [
  "source",
  "platforms",
  "territory",
  "hasNetworkRight",
  "canSublicense",
  "canEditEmbed",
  "canAdapt",
  "licenseStartDate",
  "licenseEndDate",
  "proofFileIds",
];
const dbDate = (v: string | null) => (v ? new Date(`${v}T00:00:00Z`) : null);
async function dramaForWrite(tx: Tx, id: string) {
  await lockRows(tx, "drama", [id]);
  const row = await tx.drama.findUnique({ where: { id } });
  if (!row) throw new AppError("NOT_FOUND");
  if (row.archivedAt)
    throw new AppError("DRAMA_ARCHIVED", { details: { archivedAt: row.archivedAt.toISOString() } });
  return row;
}
function staff(ctx: EmitContext) {
  if (ctx.actor.type !== "staff" || !ctx.actor.id) throw new AppError("PERMISSION_DENIED");
  return ctx.actor.id;
}
async function audit(
  tx: Tx,
  ctx: EmitContext,
  id: string,
  action: `${string}.${string}.${string}`,
  before: object,
  after: object,
  reason?: string,
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
    },
    {
      stream: "activity",
      category: "flow",
      action,
      summary: action,
      target: { type: "drama", id },
      before,
      after,
      fields,
      ...(reason ? { reason: { code: "other", text: reason } } : {}),
    },
  );
}
async function files(tx: Tx, ids: readonly string[]) {
  await lockRows(tx, "file_object", ids);
  const rows = await tx.fileObject.findMany({ where: { id: { in: [...ids] } } });
  if (
    ids.some(
      (id) =>
        !rows.some(
          (f) =>
            f.id === id &&
            f.status === "stored" &&
            f.category === "drama_license_doc" &&
            f.moderationState !== "block",
        ),
    )
  )
    throw new AppError("FILE_NOT_USABLE");
}
export function createContentCopyright(deps: ContentCopyrightDeps) {
  return {
    async replace(tx: Tx, ctx: EmitContext, id: string, raw: CopyrightReplaceBody) {
      const input = checked(CopyrightReplaceBodySchema, raw),
        drama = await dramaForWrite(tx, id);
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
      const removed = before.proofFileIds.filter((v) => !input.proofFileIds.includes(v));
      await lockRows(tx, "file_object", [...new Set([...input.proofFileIds, ...removed])].sort());
      await files(tx, input.proofFileIds);
      const { lockVersion: _lock, licenseStartDate, licenseEndDate, ...rest } = input;
      const after = await tx.dramaCopyright.update({
        where: { dramaId: id },
        data: {
          ...rest,
          licenseStartDate: dbDate(licenseStartDate),
          licenseEndDate: dbDate(licenseEndDate),
          updatedAt: now,
        },
      });
      for (const fileId of input.proofFileIds.filter((v) => !before.proofFileIds.includes(v)))
        await deps.media.link(tx, {
          fileId,
          refType: "drama_copyright",
          refId: id,
          role: "proof",
          entityId: null,
          storeId: null,
        });
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
      await audit(tx, ctx, id, "content.drama.copyright_update", before, after);
      return after;
    },
    async revise(tx: Tx, ctx: EmitContext, id: string, raw: CopyrightRevisionCreateBody) {
      const input = checked(CopyrightRevisionCreateBodySchema, raw),
        drama = await dramaForWrite(tx, id),
        staffId = staff(ctx),
        now = deps.clock.now();
      if (!drama.firstListedAt) throw new AppError("STATE_NOT_ALLOWED");
      const before = await tx.dramaCopyright.findUniqueOrThrow({ where: { dramaId: id } }),
        previous = copyrightSnapshot(before),
        next = input.copyright;
      if (before.lockVersion !== input.lockVersion)
        throw new AppError("VERSION_CONFLICT", { details: { lockVersion: before.lockVersion } });
      if (previous.licenseEndDate !== input.confirm.prevEndDate)
        throw new AppError("CONFIRM_MISMATCH");
      if (sameSnapshot(previous) === sameSnapshot(next)) throw new AppError("COPYRIGHT_NO_CHANGE");
      const oldEnd = previous.licenseEndDate!;
      const scopeChanged =
        canonical([...previous.platforms].sort()) !== canonical([...next.platforms].sort()) ||
        previous.territory !== next.territory;
      if (
        (input.changeKind === "extend" && next.licenseEndDate <= oldEnd) ||
        (input.changeKind === "shorten" && next.licenseEndDate >= oldEnd) ||
        (input.changeKind === "scope_change" && (next.licenseEndDate !== oldEnd || !scopeChanged))
      )
        throw new AppError("COPYRIGHT_CHANGE_KIND_MISMATCH", {
          details: {
            allowedKinds: [
              ...(next.licenseEndDate > oldEnd ? ["extend"] : []),
              ...(next.licenseEndDate < oldEnd ? ["shorten"] : []),
              ...(next.licenseEndDate === oldEnd && scopeChanged ? ["scope_change"] : []),
              "correction",
            ],
          },
        });
      if (input.changeKind === "shorten" || next.licenseEndDate < oldEnd)
        throw new AppError("LICENSE_SHORTEN_NOT_OPEN", { details: { currentEndDate: oldEnd } });
      await files(tx, [...new Set([...next.proofFileIds, ...input.revisionProofFileIds])].sort());
      const revisionId = uuidv7();
      await tx.dramaCopyrightRevision.create({
        data: {
          id: revisionId,
          dramaId: id,
          changeKind: input.changeKind,
          copyrightSnapshot: next as Prisma.InputJsonValue,
          prevEndDate: before.licenseEndDate,
          newEndDate: dbDate(next.licenseEndDate)!,
          reason: input.reason,
          proofFileIds: input.revisionProofFileIds,
          createdByStaffId: staffId,
          createdAt: now,
        },
      });
      const after = await tx.dramaCopyright.update({
        where: { dramaId: id },
        data: {
          ...next,
          licenseStartDate: dbDate(next.licenseStartDate),
          licenseEndDate: dbDate(next.licenseEndDate),
          currentDramaCopyrightRevisionId: revisionId,
          lockVersion: { increment: 1 },
          updatedAt: now,
        },
      });
      if (drama.status === "listed") {
        const check = await listingChecks(tx, id, now, deps.prices),
          failed = check.items.filter((v) => v.code !== "L12" && v.severity === "block" && !v.isOk);
        if (failed.length)
          throw new AppError("LISTING_CHECK_FAILED", {
            details: { failed: failed.map((v) => ({ code: v.code, note: v.note })) },
          });
      }
      for (const fileId of input.revisionProofFileIds)
        await deps.media.link(tx, {
          fileId,
          refType: "drama_copyright_revision",
          refId: revisionId,
          role: "proof",
          entityId: null,
          storeId: null,
        });
      for (const fileId of next.proofFileIds.filter((v) => !before.proofFileIds.includes(v)))
        await deps.media.link(tx, {
          fileId,
          refType: "drama_copyright",
          refId: id,
          role: "proof",
          entityId: null,
          storeId: null,
        });
      if (next.licenseEndDate !== oldEnd) await deps.license.rearm(tx, id);
      if (next.licenseEndDate > oldEnd)
        await deps.events.emit(tx, ctx, {
          type: "drama.license_extended",
          aggregate: { type: "drama", id },
          payload: {
            v: 1,
            dramaId: id,
            dramaCopyrightRevisionId: revisionId,
            prevEndDate: oldEnd,
            newEndDate: next.licenseEndDate,
          },
        });
      if (scopeChanged)
        await deps.events.emit(tx, ctx, {
          type: "drama.license_scope_changed",
          aggregate: { type: "drama", id },
          payload: EVENT_PAYLOAD_SCHEMAS["drama.license_scope_changed"].parse({
            v: 1,
            dramaId: id,
            dramaCopyrightRevisionId: revisionId,
            platformsRemoved: previous.platforms.filter(
              (v) => !next.platforms.includes(v as "douyin" | "wechat_channels"),
            ),
            platformsAdded: next.platforms.filter((v) => !previous.platforms.includes(v)),
            isTerritoryChanged: previous.territory !== next.territory,
          }),
        });
      await audit(tx, ctx, id, "content.drama.copyright_revise", before, after, input.reason);
      return revisionId;
    },
    async confirmPermit(tx: Tx, ctx: EmitContext, id: string, raw: unknown) {
      const input = checked(ConfirmPermitRecheckBodySchema, raw),
        before = await dramaForWrite(tx, id),
        now = deps.clock.now();
      const staffId = staff(ctx);
      if (!before.isPermitRecheckRequired) throw new AppError("STATE_NOT_ALLOWED");
      const after = await tx.drama.update({
        where: { id },
        data: {
          isPermitRecheckRequired: false,
          lockVersion: { increment: 1 },
          updatedByStaffId: staffId,
          updatedAt: now,
        },
      });
      await audit(
        tx,
        ctx,
        id,
        "content.drama.permit_recheck",
        before,
        after,
        input.note ?? undefined,
      );
      return after;
    },
  };
}
export type ContentCopyright = ReturnType<typeof createContentCopyright>;
