import type {
  AgreementVersionCreateBody,
  AgreementVersionUpdateBody,
  AgreementVersionScheduleBody,
  AgreementVersionWithdrawBody,
  AgreementVersionMutationResult,
  AgreementVersionScheduleResultSchema,
  AgreementVersionWithdrawResultSchema,
  z,
} from "@liyoxi/contract";
import {
  AdminAgreementListQuerySchema,
  AdminAgreementConsentListQuerySchema,
} from "@liyoxi/contract";
import type { AuditAction } from "@liyoxi/contract";
import { assertPermission, hasPermission } from "../authz/index.js";
import { record } from "../audit/index.js";
import type { Notices } from "../config/index.js";
import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { Clock, IdempotencyContext, Tx, TxRunner } from "../kernel/index.js";
import type { AgreementActor } from "./admin-context.js";
import { assertAgreementEdit, assertAgreementView } from "./admin-context.js";
import type { AgreementFilePort, PreparedAgreementContent } from "./ports.js";
import {
  noticeView,
  readVersion,
  versionView,
  agreementRows,
  agreementDetail,
  consentList,
  consentDetail,
} from "./admin-read.js";
import type { StaffBriefs } from "./admin-read.js";
import { versionLabel } from "./versions.js";
export interface DocsAdminDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly files: AgreementFilePort;
  readonly notices: Notices;
  readonly staffBriefs: StaffBriefs;
  readonly announceMinDays: (tx: Tx, now: Date) => Promise<number>;
  readonly bumpSite: () => Promise<void>;
  readonly bumpAgreement: () => Promise<void>;
}
export interface AgreementOptions {
  readonly idem?: IdempotencyContext;
}
const TEN_MIN = 600000;
export async function lockAgreement(tx: Tx, key: string): Promise<void> {
  // 自然键agreement不在UUID锁序表；agreement_version是技术簿记链，不是25个flow业务链。
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"docs.agreement:" + key}, 0))`;
  const rows = await tx.$queryRaw<
    { key: string }[]
  >`SELECT key FROM agreement WHERE key=${key} FOR UPDATE`;
  if (!rows.length) throw new AppError("NOT_FOUND");
}
async function lockVersion(tx: Tx, id: string) {
  const found = await tx.agreementVersion.findUnique({
    where: { id },
    select: { agreementKey: true },
  });
  if (!found) throw new AppError("NOT_FOUND");
  await lockAgreement(tx, found.agreementKey);
  await tx.$queryRaw`SELECT id FROM agreement_version WHERE id=${id}::uuid FOR UPDATE`;
  return readVersion(tx, id);
}
export async function auditVersion(
  tx: Tx,
  actor: AgreementActor,
  action: AuditAction,
  id: string,
  before: object | null,
  after: object | null,
  reason?: string,
) {
  await record(tx, actor.identity.actor, actor.meta, {
    stream: "ops",
    category: "agreement",
    action,
    summary: action,
    target: { type: "agreement_version", id },
    before,
    after,
    fields: [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])],
    ...(reason ? { reason: { code: "other", text: reason } } : {}),
  });
}
async function assertDraftFree(tx: Tx, key: string) {
  const old = await tx.agreementVersion.findFirst({
    where: { agreementKey: key, status: "draft" },
  });
  if (old)
    throw new AppError("AGREEMENT_DRAFT_EXISTS", {
      details: { draftAgreementVersionId: old.id, versionLabel: versionLabel(old) },
    });
}
async function lockFiles(
  tx: Tx,
  old: { sourceFileId: string | null; pdfFileId: string | null } | null,
  prepared: PreparedAgreementContent,
) {
  await lockRows(
    tx,
    "file_object",
    [
      ...new Set(
        [old?.sourceFileId, old?.pdfFileId, prepared.sourceFileId, prepared.pdfFileId].filter(
          (id): id is string => !!id,
        ),
      ),
    ].sort(),
  );
}
async function references(
  tx: Tx,
  deps: DocsAdminDeps,
  id: string,
  old: { sourceFileId: string | null; pdfFileId: string | null } | null,
  prepared: PreparedAgreementContent,
  now: Date,
) {
  for (const role of ["source", "pdf"] as const) {
    const field = role === "source" ? "sourceFileId" : "pdfFileId",
      prior = old?.[field],
      next = prepared[field];
    if (next && next !== prior) await deps.files.link(tx, { fileId: next, versionId: id, role });
    if (prior && prior !== next)
      await deps.files.release(tx, {
        fileId: prior,
        versionId: id,
        role,
        keepUntil: new Date(now.getTime() + 7 * 86400000),
      });
  }
}
function fields(input: AgreementVersionCreateBody | AgreementVersionUpdateBody) {
  return {
    ...(input.effectiveAt === undefined
      ? {}
      : { effectiveAt: input.effectiveAt === null ? null : new Date(input.effectiveAt) }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.isReconsentRequired === undefined
      ? {}
      : { isReconsentRequired: input.isReconsentRequired }),
    ...(input.isLegalApproved === undefined ? {} : { isLegalApproved: input.isLegalApproved }),
  };
}
function content(prepared: PreparedAgreementContent) {
  return {
    sourceFileId: prepared.sourceFileId,
    pdfFileId: prepared.pdfFileId,
    contentHtml: prepared.contentHtml,
    htmlSha256: prepared.htmlSha256,
    contentSha256: prepared.contentSha256,
  };
}
function conversion(
  p: PreparedAgreementContent | undefined,
): AgreementVersionMutationResult["conversion"] {
  return {
    state: !p ? "unchanged" : p.contentHtml !== null ? "converted" : "pdf_only",
    warnings:
      p?.similarityBp !== null && p?.similarityBp !== undefined && p.similarityBp < 9800
        ? [{ code: "text_mismatch", similarityBp: p.similarityBp }]
        : [],
  };
}
async function draftPreparation(
  deps: DocsAdminDeps,
  actor: AgreementActor,
  sourceFileId: string | null,
  pdfFileId: string | null,
) {
  const p = await deps.files.prepare({
    identity: actor.identity,
    staff: actor.staff,
    sourceFileId,
    pdfFileId,
  });
  if (p.sourceFileId !== sourceFileId || p.pdfFileId !== pdfFileId) throw new AppError("INTERNAL");
  return p;
}
export function createDocsAdmin(deps: DocsAdminDeps) {
  return {
    async list(actor: AgreementActor, raw: z.input<typeof AdminAgreementListQuerySchema> = {}) {
      assertAgreementView(actor);
      const q = AdminAgreementListQuerySchema.parse(raw);
      return deps.tx.run(async (tx) => {
        const rows = await agreementRows(tx, deps.clock.now());
        return {
          items: rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
          page: q.page,
          pageSize: q.pageSize,
          total: rows.length,
        };
      });
    },
    get(actor: AgreementActor, key: string) {
      assertAgreementView(actor);
      return deps.tx.run((tx) =>
        agreementDetail(tx, actor, deps.clock.now(), key, deps.staffBriefs),
      );
    },
    consents(
      actor: AgreementActor,
      raw: z.input<typeof AdminAgreementConsentListQuerySchema> = {},
    ) {
      assertAgreementView(actor);
      const q = AdminAgreementConsentListQuerySchema.parse(raw);
      return deps.tx.run((tx) => consentList(tx, actor, deps.clock.now(), q));
    },
    consent(actor: AgreementActor, id: string) {
      assertAgreementView(actor);
      return deps.tx.run((tx) => consentDetail(tx, actor, id));
    },
    async createVersion(
      actor: AgreementActor,
      key: string,
      input: AgreementVersionCreateBody,
      options: AgreementOptions = {},
    ) {
      assertAgreementEdit(actor);
      const now = deps.clock.now();
      if (input.bumpMajor) assertPermission(actor.staff, "sys.super_admin", now);
      // 转换仍在事务外；失败只交给新执行的幂等回调，同键成功重放保留原结果。
      let prepared: PreparedAgreementContent | undefined;
      let prepareFailure: { error: unknown } | undefined;
      try {
        if (input.sourceFileId || input.pdfFileId)
          prepared = await draftPreparation(
            deps,
            actor,
            input.sourceFileId ?? null,
            input.pdfFileId ?? null,
          );
      } catch (error) {
        prepareFailure = { error };
      }
      return deps.tx.run(async (tx) => {
        if (prepareFailure) throw prepareFailure.error;
        await lockAgreement(tx, key);
        await assertDraftFree(tx, key);
        const latest = await tx.agreementVersion.findFirst({
          where: { agreementKey: key, status: { not: "withdrawn" } },
          orderBy: [{ major: "desc" }, { minor: "desc" }],
        });
        const major = input.bumpMajor ? (latest?.major ?? 0) + 1 : (latest?.major ?? 1),
          minor = input.bumpMajor ? 0 : latest ? latest.minor + 1 : 0;
        const id = uuidv7();
        if (prepared) {
          await lockFiles(tx, null, prepared);
          await deps.files.assertFiles(
            tx,
            {
              identity: actor.identity,
              staff: actor.staff,
              sourceFileId: prepared.sourceFileId,
              pdfFileId: prepared.pdfFileId,
            },
            prepared.claims,
          );
        }
        await tx.agreementVersion.create({
          data: {
            id,
            agreementKey: key,
            major,
            minor,
            status: "draft",
            ...fields(input),
            ...(prepared ? content(prepared) : {}),
            createdByStaffId: actor.staff.staff.id,
            createdAt: now,
            updatedAt: now,
          },
        });
        if (prepared) await references(tx, deps, id, null, prepared, now);
        await auditVersion(tx, actor, "docs.agreement_version.create", id, null, {
          major,
          minor,
          ...fields(input),
          sourceFileId: prepared?.sourceFileId ?? null,
          pdfFileId: prepared?.pdfFileId ?? null,
        });
        const row = await readVersion(tx, id);
        return {
          version: await versionView(tx, actor, now, row, deps.staffBriefs),
          contentHtml: row.contentHtml,
          conversion: conversion(prepared),
        };
      }, options);
    },
    async updateVersion(
      actor: AgreementActor,
      id: string,
      input: AgreementVersionUpdateBody,
      options: AgreementOptions = {},
    ) {
      assertAgreementEdit(actor);
      const snapshot = await deps.tx.run((tx) => readVersion(tx, id));
      // 转换仍在事务外；失败只交给新执行的幂等回调，同键成功重放保留原结果。
      let prepared: PreparedAgreementContent | undefined;
      let prepareFailure: { error: unknown } | undefined;
      try {
        if (input.sourceFileId !== undefined || input.pdfFileId !== undefined)
          prepared = await draftPreparation(
            deps,
            actor,
            input.sourceFileId === undefined ? snapshot.sourceFileId : input.sourceFileId,
            input.pdfFileId === undefined ? snapshot.pdfFileId : input.pdfFileId,
          );
      } catch (error) {
        prepareFailure = { error };
      }
      return deps.tx.run(async (tx) => {
        const row = await lockVersion(tx, id),
          now = deps.clock.now();
        if (row.status !== "draft") throw new AppError("STATE_NOT_ALLOWED");
        if (row.lockVersion !== input.lockVersion)
          throw new AppError("VERSION_CONFLICT", { details: { lockVersion: row.lockVersion } });
        if (prepareFailure) throw prepareFailure.error;
        if (prepared) {
          await lockFiles(tx, row, prepared);
          await deps.files.assertFiles(
            tx,
            {
              identity: actor.identity,
              staff: actor.staff,
              sourceFileId: prepared.sourceFileId,
              pdfFileId: prepared.pdfFileId,
            },
            prepared.claims,
          );
          await references(tx, deps, id, row, prepared, now);
        }
        const change = { ...fields(input), ...(prepared ? content(prepared) : {}) };
        await tx.agreementVersion.update({
          where: { id },
          data: { ...change, lockVersion: { increment: 1 }, updatedAt: now },
        });
        const before = Object.fromEntries(Object.keys(change).map((k) => [k, Reflect.get(row, k)]));
        const after = Object.fromEntries(
          Object.keys(change).map((k) => [k, Reflect.get(change, k)]),
        );
        await auditVersion(tx, actor, "docs.agreement_version.update", id, before, after);
        const next = await readVersion(tx, id);
        return {
          version: await versionView(tx, actor, now, next, deps.staffBriefs),
          contentHtml: next.contentHtml,
          conversion: conversion(prepared),
        };
      }, options);
    },
    async scheduleVersion(
      actor: AgreementActor,
      id: string,
      input: AgreementVersionScheduleBody,
      options: AgreementOptions = {},
    ): Promise<z.infer<typeof AgreementVersionScheduleResultSchema>> {
      assertAgreementEdit(actor);
      const result = await deps.tx.run(async (tx) => {
        const row = await lockVersion(tx, id),
          now = deps.clock.now();
        if (row.status !== "draft") throw new AppError("STATE_NOT_ALLOWED");
        if (row.lockVersion !== input.lockVersion)
          throw new AppError("VERSION_CONFLICT", { details: { lockVersion: row.lockVersion } });
        const missing = [
          ...(!row.pdfFileId ? ["pdf"] : []),
          ...(!row.sourceFileId ? ["source"] : []),
          ...(!row.summary ? ["summary"] : []),
          ...(!row.effectiveAt ? ["effective_at"] : []),
          ...(!row.isLegalApproved ? ["legal_approved"] : []),
        ];
        if (missing.length)
          throw new AppError("AGREEMENT_DRAFT_INCOMPLETE", { details: { missing } });
        const effectiveAt = row.effectiveAt!;
        if (effectiveAt.getTime() <= now.getTime() + TEN_MIN)
          throw new AppError("AGREEMENT_EFFECTIVE_TOO_SOON", {
            details: { earliestEffectiveAt: new Date(now.getTime() + TEN_MIN + 1).toISOString() },
          });
        const pending = await tx.agreementVersion.findFirst({
          where: { agreementKey: row.agreementKey, status: "pending" },
        });
        if (pending)
          throw new AppError("AGREEMENT_PENDING_EXISTS", {
            details: {
              pendingAgreementVersionId: pending.id,
              versionLabel: versionLabel(pending),
              effectiveAt: pending.effectiveAt!.toISOString(),
            },
          });
        const minDays = await deps.announceMinDays(tx, now);
        const announced = ["member", "points"].includes(row.agreementKey),
          leadDays = Math.floor((effectiveAt.getTime() - now.getTime()) / 86400000),
          short = announced && leadDays < minDays;
        if (
          short &&
          (!hasPermission(actor.staff, "agreement.short_notice") || !input.shortNoticeReason)
        )
          throw new AppError("AGREEMENT_SHORT_NOTICE", {
            details: {
              minDays,
              actualDays: leadDays,
              earliestEffectiveAt: new Date(now.getTime() + minDays * 86400000).toISOString(),
              canOverride: hasPermission(actor.staff, "agreement.short_notice"),
            },
          });
        if (short) assertPermission(actor.staff, "agreement.short_notice", now);
        const prepared = {
          sourceFileId: row.sourceFileId,
          pdfFileId: row.pdfFileId,
          contentHtml: row.contentHtml,
          htmlSha256: row.htmlSha256,
          contentSha256: row.contentSha256,
          similarityBp: null,
          claims: [],
        };
        await lockFiles(tx, row, prepared);
        await deps.files.assertFiles(tx, {
          identity: actor.identity,
          staff: actor.staff,
          sourceFileId: row.sourceFileId,
          pdfFileId: row.pdfFileId,
        });
        let noticeId: string | null = null;
        if (announced) {
          const agreement = await tx.agreement.findUniqueOrThrow({
            where: { key: row.agreementKey },
          });
          noticeId = (
            await deps.notices.announce(tx, actor.identity, {
              kind: "agreement_version",
              refId: id,
              title: agreement.name + "更新公告",
              summary: row.summary!,
              effectiveAt,
              shortNoticeReason: short ? input.shortNoticeReason! : null,
              link: { route: "agreement.view", params: { key: row.agreementKey } },
              createdByStaffId: actor.staff.staff.id,
            })
          ).siteNoticeId;
        }
        await tx.agreementVersion.update({
          where: { id },
          data: {
            status: "pending",
            publishedByStaffId: actor.staff.staff.id,
            siteNoticeId: noticeId,
            shortNoticeReason: short ? input.shortNoticeReason! : null,
            lockVersion: { increment: 1 },
            updatedAt: now,
          },
        });
        await auditVersion(
          tx,
          actor,
          "docs.agreement_version.schedule",
          id,
          { status: "draft" },
          {
            status: "pending",
            effectiveAt: effectiveAt.toISOString(),
            leadDays,
            shortNoticeReason: short ? input.shortNoticeReason : null,
          },
        );
        return {
          version: await versionView(tx, actor, now, await readVersion(tx, id), deps.staffBriefs),
          siteNotice: await noticeView(tx, noticeId, now, deps.staffBriefs),
        };
      }, options);
      await Promise.all([deps.bumpSite(), deps.bumpAgreement()]);
      return result;
    },
    async withdrawVersion(
      actor: AgreementActor,
      id: string,
      input: AgreementVersionWithdrawBody,
      options: AgreementOptions = {},
    ): Promise<z.infer<typeof AgreementVersionWithdrawResultSchema>> {
      assertAgreementEdit(actor);
      const result = await deps.tx.run(async (tx) => {
        const row = await lockVersion(tx, id),
          now = deps.clock.now();
        if (row.status !== "pending") throw new AppError("STATE_NOT_ALLOWED");
        if (!row.effectiveAt || row.effectiveAt.getTime() <= now.getTime() + TEN_MIN)
          throw new AppError("AGREEMENT_WITHDRAW_TOO_LATE", {
            details: {
              reason: "effective_soon",
              effectiveAt: row.effectiveAt?.toISOString() ?? null,
            },
          });
        const changed =
          await tx.$executeRaw`UPDATE agreement_version SET status='withdrawn', lock_version=lock_version+1, updated_at=${now} WHERE id=${id}::uuid AND status='pending' AND effective_at>${new Date(now.getTime() + TEN_MIN)} AND NOT EXISTS (SELECT 1 FROM agreement_consent WHERE agreement_version_id=${id}::uuid)`;
        if (changed !== 1)
          throw new AppError("AGREEMENT_WITHDRAW_TOO_LATE", {
            details: { reason: "has_consents", effectiveAt: row.effectiveAt.toISOString() },
          });
        if (row.siteNoticeId)
          await deps.notices.withdraw(tx, actor.identity, {
            siteNoticeId: row.siteNoticeId,
            staffId: actor.staff.staff.id,
          });
        let draftId: string | null = null;
        if (
          !(await tx.agreementVersion.findFirst({
            where: { agreementKey: row.agreementKey, status: "draft" },
            select: { id: true },
          }))
        ) {
          draftId = uuidv7();
          const prepared = {
            sourceFileId: row.sourceFileId,
            pdfFileId: row.pdfFileId,
            contentHtml: row.contentHtml,
            htmlSha256: row.htmlSha256,
            contentSha256: row.contentSha256,
            similarityBp: null,
            claims: [],
          };
          await lockFiles(tx, null, prepared);
          await tx.agreementVersion.create({
            data: {
              id: draftId,
              agreementKey: row.agreementKey,
              major: row.major,
              minor: row.minor,
              status: "draft",
              effectiveAt: row.effectiveAt,
              summary: row.summary,
              isReconsentRequired: row.isReconsentRequired,
              isLegalApproved: row.isLegalApproved,
              ...content(prepared),
              createdByStaffId: actor.staff.staff.id,
              createdAt: now,
              updatedAt: now,
            },
          });
          await references(tx, deps, draftId, null, prepared, now);
        }
        await auditVersion(
          tx,
          actor,
          "docs.agreement_version.withdraw",
          id,
          { status: "pending" },
          { status: "withdrawn", newDraftId: draftId },
          input.reason,
        );
        return {
          withdrawn: await versionView(tx, actor, now, await readVersion(tx, id), deps.staffBriefs),
          newDraft: draftId
            ? await versionView(tx, actor, now, await readVersion(tx, draftId), deps.staffBriefs)
            : null,
          siteNotice: await noticeView(tx, row.siteNoticeId, now, deps.staffBriefs),
        };
      }, options);
      await Promise.all([deps.bumpSite(), deps.bumpAgreement()]);
      return result;
    },
  };
}
