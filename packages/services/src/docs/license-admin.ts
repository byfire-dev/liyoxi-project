import type { LicenseLetterCorrectBody, LicenseLetterVoidBody, LicenseLetterRevisionView, AdminLicenseLetterView } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { assertAccess, authorize, byStore, hasPermission } from "../authz/index.js";
import type { StaffContext, DataScope } from "../authz/index.js";
import type { AuditRequestMeta } from "../audit/index.js";
import { AppError } from "../kernel/index.js";
import type { Clock, IdentityContext, IdempotencyContext, Tx, TxRunner } from "../kernel/index.js";
import type { LicenseConvergenceDeps } from "./license-facts.js";
import { parseLicenseLetterSnapshot } from "./license-facts.js";
import { correctLicenseLetter, voidLicenseLetter } from "./license-convergence.js";
import { licenseIssues } from "./license-read.js";
import type { LicenseReadRow } from "./license-read.js";

export interface LicenseAdminActor { readonly staff: StaffContext; readonly identity: IdentityContext; readonly meta: AuditRequestMeta }
export interface LicenseAdminDeps {
  readonly tx: TxRunner; readonly clock: Clock; readonly convergence: LicenseConvergenceDeps;
  readonly storeVisible: (tx: Tx, input: { entityId: string; storeId: string; scope: DataScope }) => Promise<boolean>;
  readonly rerender: (tx: Tx, ctx: IdentityContext, input: { revisionId: string }) => Promise<unknown>;
}
function assertActor(actor: LicenseAdminActor, now: Date, write = false) {
  if (actor.identity.actor.type !== "staff" || actor.identity.actor.id !== actor.staff.staff.id) throw new AppError("PERMISSION_DENIED");
  if (write) authorize(actor.staff, { module: { module: "order", need: "view" }, permission: "order.license_letter.manage" }, now);
  else assertAccess(actor.staff, { module: { module: "order", need: "view" }, permission: null });
}
async function visibleLetter(tx: Tx, actor: LicenseAdminActor, id: string): Promise<LicenseReadRow> {
  const row = await tx.licenseLetter.findFirst({ where: { id, ...byStore(actor.staff.scope) }, include: { revisions: { orderBy: { revNo: "desc" } } } });
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}
async function view(tx: Tx, deps: LicenseAdminDeps, actor: LicenseAdminActor, row: LicenseReadRow): Promise<AdminLicenseLetterView> {
  const issues = await licenseIssues(tx, row);
  const canManage = hasPermission(actor.staff, "order.license_letter.manage");
  const revisions: LicenseLetterRevisionView[] = row.revisions.map((revision) => ({
    licenseLetterRevisionId: revision.id, revNo: revision.revNo, reason: revision.reason as LicenseLetterRevisionView["reason"], renderStatus: revision.renderStatus as LicenseLetterRevisionView["renderStatus"], renderAttemptNo: revision.renderAttemptNo,
    fileId: revision.renderStatus === "ready" ? revision.fileId : null, contentFp: revision.contentFp, templateVersion: revision.templateVersion,
    signMode: revision.signMode as LicenseLetterRevisionView["signMode"], platformSignedAt: revision.platformSignedAt?.toISOString() ?? null, readyAt: revision.readyAt?.toISOString() ?? null, createdAt: revision.createdAt.toISOString(),
    actions: canManage && row.status !== "voided" && revision.renderStatus === "failed" ? ["rerender"] : [], renderIssue: issues.get(revision.id) ?? null,
  }));
  const fact = (await deps.convergence.facts.readLicenseFacts(tx, [row.orderItemId]))[0];
  const source = row.revisions.find((revision) => revision.id === row.currentRevisionId) ?? row.revisions[0];
  const snapshot = source ? parseLicenseLetterSnapshot(source.letterSnapshot) : null;
  return {
    licenseLetterId: row.id, letterNo: row.letterNo, orderItemId: row.orderItemId, channelAccountId: row.channelAccountId, platform: row.platform as AdminLicenseLetterView["platform"],
    accountName: fact?.accounts.find((account) => account.channelAccountId === row.channelAccountId)?.name ?? snapshot?.account.name ?? "",
    status: row.status as AdminLicenseLetterView["status"], isExpired: row.status === "effective" && row.periodEnd.toISOString().slice(0, 10) < calendarDate(deps.clock.now()),
    periodStart: row.periodStart?.toISOString().slice(0, 10) ?? null, periodEnd: row.periodEnd.toISOString().slice(0, 10), voidReason: row.voidReason as AdminLicenseLetterView["voidReason"], voidedAt: row.voidedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
    currentRevision: revisions.find((revision) => revision.licenseLetterRevisionId === row.currentRevisionId && revision.renderStatus === "ready") ?? null, revisions,
    actions: canManage && row.status !== "voided" ? ["correct", "void"] : [],
  };
}
export function createLicenseAdmin(deps: LicenseAdminDeps) {
  const result = (tx: Tx, actor: LicenseAdminActor, id: string) => visibleLetter(tx, actor, id).then((row) => view(tx, deps, actor, row));
  return {
    list: (actor: LicenseAdminActor, orderItemId: string, query: { includeVoided: boolean }) => deps.tx.run(async (tx) => {
      assertActor(actor, deps.clock.now());
      const fact = (await deps.convergence.facts.readLicenseFacts(tx, [orderItemId]))[0];
      if (!fact || !(await deps.storeVisible(tx, { storeId: fact.storeId, entityId: fact.entityId, scope: actor.staff.scope }))) throw new AppError("NOT_FOUND");
      const rows = await tx.licenseLetter.findMany({ where: { orderItemId, ...byStore(actor.staff.scope), ...(query.includeVoided ? {} : { status: { not: "voided" } }) }, include: { revisions: { orderBy: { revNo: "desc" } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      return { items: await Promise.all(rows.map((row) => view(tx, deps, actor, row))) };
    }),
    correct: async (actor: LicenseAdminActor, id: string, input: LicenseLetterCorrectBody, options: { idem?: IdempotencyContext } = {}) => {
      assertActor(actor, deps.clock.now(), true);
      await deps.tx.run((tx) => visibleLetter(tx, actor, id));
      return deps.tx.run(async (tx) => {
      assertActor(actor, deps.clock.now(), true);
      await visibleLetter(tx, actor, id);
      await correctLicenseLetter(tx, deps.convergence, actor.identity, { licenseLetterId: id, ...input });
      return result(tx, actor, id);
      }, options);
    },
    void: async (actor: LicenseAdminActor, id: string, input: LicenseLetterVoidBody, options: { idem?: IdempotencyContext } = {}) => {
      assertActor(actor, deps.clock.now(), true);
      await deps.tx.run((tx) => visibleLetter(tx, actor, id));
      return deps.tx.run(async (tx) => {
      assertActor(actor, deps.clock.now(), true);
      await visibleLetter(tx, actor, id);
      const changed = await voidLicenseLetter(tx, deps.convergence, actor.identity, { licenseLetterId: id, ...input });
      return { voided: await result(tx, actor, id), reissued: changed.reissuedLicenseLetterId ? await result(tx, actor, changed.reissuedLicenseLetterId) : null };
      }, options);
    },
    rerender: async (actor: LicenseAdminActor, revisionId: string, options: { idem?: IdempotencyContext } = {}) => {
      assertActor(actor, deps.clock.now(), true);
      await deps.tx.run(async (tx) => {
        const ref = await tx.licenseLetterRevision.findUnique({ where: { id: revisionId }, select: { licenseLetterId: true } });
        if (!ref) throw new AppError("NOT_FOUND");
        await visibleLetter(tx, actor, ref.licenseLetterId);
      });
      return deps.tx.run(async (tx) => {
      assertActor(actor, deps.clock.now(), true);
      const ref = await tx.licenseLetterRevision.findUnique({ where: { id: revisionId }, select: { licenseLetterId: true } });
      if (!ref) throw new AppError("NOT_FOUND");
      await visibleLetter(tx, actor, ref.licenseLetterId);
      await deps.rerender(tx, actor.identity, { revisionId });
      const letter = await result(tx, actor, ref.licenseLetterId);
      const revision = letter.revisions.find((value) => value.licenseLetterRevisionId === revisionId);
      if (!revision) throw new AppError("NOT_FOUND");
      return revision;
      }, options);
    },
  };
}
export type LicenseAdmin = ReturnType<typeof createLicenseAdmin>;
