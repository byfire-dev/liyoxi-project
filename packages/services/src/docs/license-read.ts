import type { LicenseLetter, LicenseLetterRevision } from "@liyoxi/db";
import type { LicenseLetterCard, LicenseLetterDetail, LicenseLetterFilter, LicenseLetterQuery, LicenseLetterDownloadBody, LicenseLetterDownloadUrl, LicenseLetterPreview } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { maskUscc } from "@liyoxi/shared/mask";
import { AppError } from "../kernel/index.js";
import type { Clock, IdentityContext, Tx, TxRunner } from "../kernel/index.js";
import { record, readLicenseRenderResults } from "../audit/index.js";
import type { AuditRequestMeta, LicenseRenderIssue } from "../audit/index.js";
import { assertAccess, byStore } from "../authz/index.js";
import type { StaffContext, DataScope } from "../authz/index.js";
import type { LicenseConvergenceDeps } from "./license-facts.js";
import { parseLicenseLetterSnapshot } from "./license-facts.js";

export interface LicenseViewer { readonly identity: IdentityContext; readonly merchantUserId: string; readonly entityId: string }
export interface LicenseReadDeps {
  readonly tx: TxRunner; readonly clock: Clock;
  readonly facts: LicenseConvergenceDeps["facts"];
  readonly snapshot: LicenseConvergenceDeps["snapshot"];
  readonly ownerAccess: (tx: Tx, input: { merchantUserId: string; entityId: string }) => Promise<boolean>;
  readonly signDownload: (input: { fileId: string; fileName: string }) => Promise<{ url: string; expiresAt: string }>;
  readonly clauses?: (templateVersion: string, keys: readonly string[]) => readonly { key: string; title: string; text: string }[];
}
export type LicenseReadRow = LicenseLetter & { revisions: LicenseLetterRevision[] };
const isoDate = (value: Date) => value.toISOString().slice(0, 10);
export async function assertLicenseOwner(tx: Tx, deps: Pick<LicenseReadDeps, "ownerAccess">, viewer: LicenseViewer): Promise<void> {
  if (viewer.identity.actor.type !== "merchant" || viewer.identity.actor.id !== viewer.merchantUserId || viewer.identity.actor.role !== "owner") throw new AppError("ROLE_FORBIDDEN");
  const allowed = await deps.ownerAccess(tx, { merchantUserId: viewer.merchantUserId, entityId: viewer.entityId });
  if (!allowed) throw new AppError("NOT_FOUND");
}
export async function licenseIssues(tx: Tx, row: LicenseReadRow): Promise<ReadonlyMap<string, LicenseRenderIssue | null>> {
  const result = await readLicenseRenderResults(tx, { letterId: row.id, entityId: row.entityId, storeId: row.storeId, revisionIds: row.revisions.map((revision) => revision.id) });
  return new Map(row.revisions.map((revision) => {
    const latest = result.get(revision.id);
    const valid = row.status !== "voided" && revision.renderStatus === "failed" && latest?.outcome === "failed" && latest.claim.attempt === revision.renderAttemptNo && latest.claim.leaseUntil === (revision.renderLeaseUntil?.toISOString() ?? null);
    return [revision.id, valid ? latest.issue : null];
  }));
}
export async function licenseCard(tx: Tx, deps: Pick<LicenseReadDeps, "facts" | "snapshot" | "clock">, row: LicenseReadRow): Promise<LicenseLetterCard> {
  const current = row.revisions.find((revision) => revision.id === row.currentRevisionId && revision.renderStatus === "ready" && revision.fileId !== null && revision.readyAt !== null);
  const snapshot = current ? parseLicenseLetterSnapshot(current.letterSnapshot) : null;
  const facts = snapshot ? null : (await deps.facts.readLicenseFacts(tx, [row.orderItemId])).find((item) => item.entityId === row.entityId && item.storeId === row.storeId);
  if (!snapshot && !facts) throw new AppError("PRECONDITION_CHANGED");
  const scope = snapshot ? null : await deps.snapshot.scope(tx, row.dramaId, row.platform);
  const latest = row.revisions[0];
  const issues = latest && row.status !== "voided" && latest.renderStatus === "failed" ? await licenseIssues(tx, row) : new Map<string, LicenseRenderIssue | null>();
  const expired = row.status === "effective" && isoDate(row.periodEnd) < calendarDate(deps.clock.now());
  return {
    licenseLetterId: row.id, letterNo: row.letterNo, orderId: row.dramaOrderId, orderNo: snapshot?.orderNo ?? facts!.orderNo,
    orderItemId: row.orderItemId, storeId: row.storeId, dramaTitle: snapshot?.drama.name ?? scope!.name, episodeCount: snapshot?.drama.episodes ?? scope!.episodes,
    platform: row.platform as LicenseLetterCard["platform"], accountName: snapshot?.account.name ?? facts!.accounts.find((account) => account.channelAccountId === row.channelAccountId)?.name ?? "",
    status: row.status as LicenseLetterCard["status"], displayStatus: expired ? "expired" : row.status as LicenseLetterCard["status"],
    periodStartDate: row.periodStart ? isoDate(row.periodStart) : null, periodEndDate: isoDate(row.periodEnd), createdAt: row.createdAt.toISOString(),
    currentRevNo: current?.revNo ?? null, issuedAt: current?.readyAt?.toISOString() ?? null,
    isRendering: !current || row.revisions.some((revision) => revision.revNo > current.revNo && ["queued", "rendering", "failed"].includes(revision.renderStatus)),
    voidReason: row.voidReason as LicenseLetterCard["voidReason"], voidedAt: row.voidedAt?.toISOString() ?? null, canDownload: !!current,
    renderIssue: latest ? issues.get(latest.id) ?? null : null,
  };
}
function preview(deps: LicenseReadDeps, revision: LicenseLetterRevision): LicenseLetterPreview {
  const value = parseLicenseLetterSnapshot(revision.letterSnapshot);
  return {
    licensorName: value.licensor.name, licensorCreditCodeMask: maskUscc(value.licensor.creditCode), licenseeName: value.licensee.name, licenseeCreditCodeMask: maskUscc(value.licensee.creditCode),
    storeName: value.licensee.store, dramaName: value.drama.name, episodes: value.drama.episodes, permits: value.drama.permits,
    account: { ...value.account, platform: value.account.platform as LicenseLetterPreview["account"]["platform"] },
    period: { startDate: value.period.start, startText: value.period.startText, endDate: value.period.end, territory: value.period.territory },
    clauses: [...(deps.clauses?.(revision.templateVersion, [value.rightsClauseKey, value.exclusiveClauseKey, value.obligationClauseKey]) ?? [])],
    consent: { consentNo: value.consent.consentNo, agreementName: value.consent.agreement, consentedAt: value.consent.at, operatorMask: value.consent.by },
    revNo: value.revNo, issuedAt: value.issuedAt, verifyUrl: value.verifyUrl, contentFp: revision.contentFp, signMode: revision.signMode as LicenseLetterPreview["signMode"],
  };
}
const whereFilter = (filter: LicenseLetterFilter) => ({ ...(filter.orderId ? { dramaOrderId: filter.orderId } : {}), ...(filter.storeId ? { storeId: filter.storeId } : {}), ...(filter.includeVoided ? {} : { status: { not: "voided" } }) });
function cursorWhere(cursor?: string) {
  if (cursor === undefined) return {};
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value[0]) || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value[1])) throw new Error("cursor");
    const at = new Date(value[0]);
    if (!Number.isFinite(at.getTime())) throw new Error("cursor");
    return { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: value[1] } }] };
  } catch { throw new AppError("VALIDATION_FAILED", { message: "游标不合法" }); }
}
const readRow = async (tx: Tx, deps: Pick<LicenseReadDeps, "ownerAccess">, viewer: LicenseViewer, id: string) => {
  await assertLicenseOwner(tx, deps, viewer);
  const row = await tx.licenseLetter.findFirst({ where: { id, entityId: viewer.entityId }, include: { revisions: { orderBy: { revNo: "desc" } } } });
  if (!row) throw new AppError("NOT_FOUND");
  return row;
};
export function createLicenseRead(deps: LicenseReadDeps) {
  return {
    list: (viewer: LicenseViewer, query: LicenseLetterQuery) => deps.tx.run(async (tx) => {
      await assertLicenseOwner(tx, deps, viewer);
      const rows = await tx.licenseLetter.findMany({ where: { entityId: viewer.entityId, ...whereFilter(query), ...cursorWhere(query.cursor) }, include: { revisions: { orderBy: { revNo: "desc" } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: query.limit + 1 });
      const items = rows.slice(0, query.limit), last = items.at(-1), hasMore = rows.length > query.limit;
      return { items: await Promise.all(items.map((row) => licenseCard(tx, deps, row))), hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify([last.createdAt.toISOString(), last.id]), "utf8").toString("base64url") : null };
    }),
    summary: (viewer: LicenseViewer, filter: LicenseLetterFilter) => deps.tx.run(async (tx) => {
      await assertLicenseOwner(tx, deps, viewer);
      const where = { entityId: viewer.entityId, ...whereFilter(filter) };
      const all = await tx.licenseLetter.count({ where });
      const effective = await tx.licenseLetter.count({ where: { ...where, status: "effective", periodEnd: { gte: new Date(`${calendarDate(deps.clock.now())}T00:00:00Z`) } } });
      return { all, effective };
    }),
    get: (viewer: LicenseViewer, id: string): Promise<LicenseLetterDetail> => deps.tx.run(async (tx) => {
      const row = await readRow(tx, deps, viewer, id);
      const card = await licenseCard(tx, deps, row);
      const current = row.revisions.find((revision) => revision.id === row.currentRevisionId && revision.renderStatus === "ready" && revision.readyAt !== null);
      return { ...card, preview: current ? preview(deps, current) : null, revisions: row.revisions.filter((revision) => revision.renderStatus === "ready" && revision.readyAt !== null).map((revision) => ({ revNo: revision.revNo, reason: revision.reason as LicenseLetterDetail["revisions"][number]["reason"], issuedAt: revision.readyAt!.toISOString() })) };
    }),
    download: async (viewer: LicenseViewer, id: string, input: LicenseLetterDownloadBody, meta: AuditRequestMeta): Promise<LicenseLetterDownloadUrl> => {
      const select = async (tx: Tx) => {
        const row = await readRow(tx, deps, viewer, id);
        const revision = input.revNo === undefined ? row.revisions.find((value) => value.id === row.currentRevisionId) : row.revisions.find((value) => value.revNo === input.revNo);
        if (!revision || revision.renderStatus !== "ready" || !revision.fileId || !revision.readyAt || !revision.pdfSha256) throw new AppError("LICENSE_LETTER_NOT_READY", { details: { renderStatus: revision?.renderStatus ?? row.revisions[0]?.renderStatus ?? "queued" } });
        return { row, revision };
      };
      const first = await deps.tx.run(select);
      const title = parseLicenseLetterSnapshot(first.revision.letterSnapshot).drama.name.replace(/[\p{Cc}\\/:*?"<>|]/gu, "_").slice(0, 80);
      const fileName = `定制内容授权书_${title}_${first.row.letterNo}_第${first.revision.revNo}版.pdf`;
      const signed = await deps.signDownload({ fileId: first.revision.fileId!, fileName });
      await deps.tx.run(async (tx) => {
        const fresh = await select(tx);
        if (fresh.revision.id !== first.revision.id || fresh.revision.fileId !== first.revision.fileId || fresh.revision.pdfSha256 !== first.revision.pdfSha256) throw new AppError("FILE_NOT_AVAILABLE");
        await record(tx, viewer.identity.actor, meta, { stream: "access", category: "file_access", action: "docs.license_letter.download", summary: "下载授权书", target: { type: "license_letter", id }, entityId: fresh.row.entityId, storeId: fresh.row.storeId, meta: { revisionId: fresh.revision.id, fileCategory: "legal_doc", urlTtlSec: 300 } });
      });
      return { ...signed, fileName, revNo: first.revision.revNo };
    },
  };
}
export type LicenseRead = ReturnType<typeof createLicenseRead>;

/** Narrow public bridge for the media owner; only a ready revision permits order-based access. */
export async function assertLicenseFileVisible(tx: Tx, input: { fileId: string; staff: StaffContext }): Promise<boolean> {
  const revision = await tx.licenseLetterRevision.findFirst({ where: { fileId: input.fileId }, select: { renderStatus: true, readyAt: true, licenseLetter: { select: { id: true } } } });
  if (!revision) return false;
  assertAccess(input.staff, { module: { module: "order", need: "view" }, permission: null });
  if (revision.renderStatus !== "ready" || !revision.readyAt || !(await tx.licenseLetter.findFirst({ where: { id: revision.licenseLetter.id, ...byStore(input.staff.scope) }, select: { id: true } }))) throw new AppError("NOT_FOUND");
  return true;
}

/** Public current metadata projection. The caller owns order access; this query still applies its scope. */
export async function readLicenseOrderProjection(tx: Tx, input: { orderId: string; now: Date; entityId?: string; scope?: DataScope }) {
  const rows = await tx.licenseLetter.findMany({ where: { dramaOrderId: input.orderId, status: { not: "voided" }, ...(input.entityId ? { entityId: input.entityId } : {}), ...(input.scope ? byStore(input.scope) : {}) }, include: { currentRevision: true, revisions: { orderBy: { revNo: "desc" }, take: 1 } }, orderBy: { id: "asc" } });
  return rows.map((row) => {
    const revision = row.currentRevision;
    const source = revision ?? row.revisions[0];
    const value = source ? parseLicenseLetterSnapshot(source.letterSnapshot) : null;
    const isExpired = row.status === "effective" && isoDate(row.periodEnd) < calendarDate(input.now);
    return { licenseLetterId: row.id, orderItemId: row.orderItemId, dramaTitle: value?.drama.name ?? "", letterNo: row.letterNo, platform: row.platform, accountName: value?.account.name ?? "", status: row.status, isExpired, displayStatus: isExpired ? "expired" : row.status, periodStartDate: row.periodStart ? isoDate(row.periodStart) : null, periodEndDate: isoDate(row.periodEnd), periodStart: row.periodStart ? isoDate(row.periodStart) : null, periodEnd: isoDate(row.periodEnd), currentRevision: revision ? { licenseLetterRevisionId: revision.id, revNo: revision.revNo, renderStatus: revision.renderStatus, fileId: revision.fileId } : null };
  });
}
