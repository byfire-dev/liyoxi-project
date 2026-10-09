import type {
  AgreementDetail,
  AgreementListItem,
  AgreementVersionItem,
  AgreementConsentItem,
  AgreementConsentDetail,
  AdminAgreementConsentListQuery,
  AgreementSiteNotice,
  StaffBrief,
} from "@liyoxi/contract";
import { divRoundHalfUp } from "@liyoxi/shared/pricing";
import { addDays, calendarDate, dayRange } from "@liyoxi/shared/time";
import { maskIp } from "@liyoxi/shared/mask";
import { assertAccess } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { AgreementActor } from "./admin-context.js";
import { canAgreementEdit, mayRevealConsents } from "./admin-context.js";
import { currentVersions, upcomingVersions, versionLabel } from "./versions.js";
export type StaffBriefs = (tx: Tx, ids: readonly string[]) => Promise<StaffBrief[]>;
export const versionInclude = { sourceFile: true, pdfFile: true } as const;
export async function readVersion(tx: Tx, id: string) {
  const row = await tx.agreementVersion.findUnique({ where: { id }, include: versionInclude });
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}
type Version = Awaited<ReturnType<typeof readVersion>>;
const iso = (d: Date | null): string | null => d?.toISOString() ?? null;
function staffOf(map: Map<string, StaffBrief>, id: string): StaffBrief {
  const found = map.get(id);
  if (!found) throw new AppError("INTERNAL");
  return found;
}
export async function versionView(
  tx: Tx,
  actor: AgreementActor,
  now: Date,
  row: Version,
  briefs: StaffBriefs,
  currentId?: string,
): Promise<AgreementVersionItem> {
  const current = currentId ?? (await currentVersions(tx, now)).get(row.agreementKey)?.id;
  const displayStatus =
    row.status === "pending" && row.effectiveAt && row.effectiveAt <= now
      ? row.id === current
        ? "active"
        : "superseded"
      : row.status === "active" && row.id !== current
        ? "superseded"
        : row.status;
  const map = new Map(
    (
      await briefs(tx, [
        row.createdByStaffId,
        ...(row.publishedByStaffId ? [row.publishedByStaffId] : []),
      ])
    ).map((s) => [s.staffId, s]),
  );
  const file = (f: Version["pdfFile"]) =>
    f
      ? {
          fileId: f.id,
          originalName: f.originalName,
          sizeBytes: f.sizeBytes?.toString() ?? null,
          mime: f.mime,
        }
      : null;
  const editable = canAgreementEdit(actor);
  const consents =
    row.status === "pending" && editable
      ? await tx.agreementConsent.count({ where: { agreementVersionId: row.id } })
      : 0;
  return {
    agreementVersionId: row.id,
    agreementKey: row.agreementKey,
    major: row.major,
    minor: row.minor,
    versionLabel: versionLabel(row),
    status: row.status as AgreementVersionItem["status"],
    displayStatus: displayStatus as AgreementVersionItem["displayStatus"],
    effectiveAt: iso(row.effectiveAt),
    summary: row.summary,
    isReconsentRequired: row.isReconsentRequired,
    isLegalApproved: row.isLegalApproved,
    sourceFile: file(row.sourceFile),
    pdfFile: file(row.pdfFile),
    hasContentHtml: row.contentHtml !== null,
    contentSha256: row.contentSha256,
    siteNoticeId: row.siteNoticeId,
    shortNoticeReason: row.shortNoticeReason,
    expectedConsents: row.expectedConsents,
    activatedAt: iso(row.activatedAt),
    createdBy: staffOf(map, row.createdByStaffId),
    publishedBy: row.publishedByStaffId ? staffOf(map, row.publishedByStaffId) : null,
    lockVersion: row.lockVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    actions:
      editable && row.status === "draft"
        ? ["edit", "schedule"]
        : editable &&
            row.status === "pending" &&
            row.effectiveAt &&
            row.effectiveAt.getTime() > now.getTime() + 600000 &&
            consents === 0
          ? ["withdraw"]
          : [],
  };
}
export async function agreementRows(tx: Tx, now: Date): Promise<AgreementListItem[]> {
  const [agreements, current, upcoming, drafts] = await Promise.all([
    tx.agreement.findMany({ orderBy: { sortNo: "asc" } }),
    currentVersions(tx, now),
    upcomingVersions(tx, now),
    tx.agreementVersion.findMany({ where: { status: "draft" } }),
  ]);
  const draftMap = new Map(drafts.map((v) => [v.agreementKey, v]));
  const brief = (
    v: { id: string; major: number; minor: number; effectiveAt: Date | null } | undefined,
  ) =>
    v
      ? { agreementVersionId: v.id, versionLabel: versionLabel(v), effectiveAt: iso(v.effectiveAt) }
      : null;
  return agreements.map((a) => ({
    agreementKey: a.key,
    name: a.name,
    subjectKind: a.subjectKind,
    consentMode: a.consentMode,
    scenes: a.scenes,
    signSceneLabel: a.signSceneLabel,
    audienceLabel: a.audienceLabel,
    sinceVersion: a.sinceVersion,
    currentVersion: brief(current.get(a.key)),
    pendingVersion: brief(upcoming.get(a.key)),
    draftVersion: brief(draftMap.get(a.key)),
  }));
}
export async function agreementDetail(
  tx: Tx,
  actor: AgreementActor,
  now: Date,
  key: string,
  briefs: StaffBriefs,
): Promise<AgreementDetail> {
  assertAccess(actor.staff, { module: { module: "ops", need: "view" }, permission: null });
  const item = (await agreementRows(tx, now)).find((a) => a.agreementKey === key);
  if (!item) throw new AppError("NOT_FOUND");
  const rows = await tx.agreementVersion.findMany({
    where: { agreementKey: key },
    include: versionInclude,
    orderBy: [{ major: "desc" }, { minor: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
  const current = rows.find((r) => r.id === item.currentVersion?.agreementVersionId),
    draft = rows.find((r) => r.status === "draft");
  let progress: AgreementDetail["reconsentProgress"] = null;
  if (
    item.subjectKind === "user" &&
    current?.isReconsentRequired &&
    current.expectedConsents !== null &&
    rows.some(
      (r) =>
        r.status !== "draft" &&
        r.status !== "withdrawn" &&
        (r.major < current.major || (r.major === current.major && r.minor < current.minor)),
    )
  ) {
    const signed = await tx.agreementConsent.findMany({
      where: { agreementVersionId: current.id },
      distinct: ["merchantUserId"],
      select: { merchantUserId: true },
    });
    progress = {
      agreementVersionId: current.id,
      versionLabel: versionLabel(current),
      consentedCount: signed.length,
      expectedCount: current.expectedConsents,
      ratioBp:
        current.expectedConsents === 0
          ? 10000
          : Math.min(10000, divRoundHalfUp([signed.length, 10000], [current.expectedConsents])),
    };
  }
  return {
    ...item,
    versions: await Promise.all(
      rows.map((r) =>
        versionView(tx, actor, now, r, briefs, item.currentVersion?.agreementVersionId),
      ),
    ),
    currentContentHtml: current?.contentHtml ?? null,
    draftContentHtml: draft?.contentHtml ?? null,
    reconsentProgress: progress,
  };
}
export async function noticeView(
  tx: Tx,
  id: string | null,
  now: Date,
  briefs: StaffBriefs,
): Promise<AgreementSiteNotice | null> {
  if (!id) return null;
  const n = await tx.siteNotice.findUnique({ where: { id } });
  if (!n) throw new AppError("INTERNAL");
  const map = new Map(
    (
      await briefs(tx, [
        n.createdByStaffId,
        ...(n.withdrawnByStaffId ? [n.withdrawnByStaffId] : []),
      ])
    ).map((s) => [s.staffId, s]),
  );
  const link = n.link as { route: string; params?: Record<string, unknown> };
  return {
    siteNoticeId: n.id,
    kind: n.kind,
    refId: n.refId,
    title: n.title,
    summary: n.summary,
    summaryNoPrice: n.summaryNoPrice,
    effectiveAt: n.effectiveAt.toISOString(),
    announcedAt: n.announcedAt.toISOString(),
    leadDays: n.leadDays,
    shortNoticeReason: n.shortNoticeReason,
    link,
    isBarEnabled: n.barEnabled,
    status: n.status as AgreementSiteNotice["status"],
    displayState:
      n.status === "withdrawn" ? "withdrawn" : n.effectiveAt > now ? "scheduled" : "effective",
    createdBy: staffOf(map, n.createdByStaffId),
    withdrawnBy: n.withdrawnByStaffId ? staffOf(map, n.withdrawnByStaffId) : null,
    withdrawnAt: iso(n.withdrawnAt),
    createdAt: n.createdAt.toISOString(),
  };
}
const consentInclude = {
  agreementVersion: { include: { agreement: true } },
  store: { select: { name: true } },
} as const;
async function consentRow(tx: Tx, id: string) {
  const row = await tx.agreementConsent.findUnique({ where: { id }, include: consentInclude });
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}
type Consent = Awaited<ReturnType<typeof consentRow>>;
function consentItem(r: Consent): AgreementConsentItem {
  return {
    agreementConsentId: r.id,
    consentNo: String(r.seq),
    agreementKey: r.agreementKey,
    agreementName: r.agreementVersion.agreement.name,
    agreementVersionId: r.agreementVersionId,
    versionLabel: versionLabel(r.agreementVersion),
    scene: r.scene,
    method: r.method,
    merchantUserId: r.merchantUserId,
    phoneMask: r.phoneMask,
    operatorNameMask: r.operatorNameMask,
    role: r.role,
    entityId: r.entityId,
    entityName: r.entityName,
    usccMask: r.usccMask,
    storeId: r.storeId,
    storeName: r.store?.name ?? null,
    bizType: r.bizType,
    bizId: r.bizId,
    bizNo: r.bizNo,
    consentedAt: r.consentedAt.toISOString(),
  };
}
export async function consentDetail(
  tx: Tx,
  actor: AgreementActor,
  id: string,
): Promise<AgreementConsentDetail> {
  assertAccess(actor.staff, { module: { module: "ops", need: "view" }, permission: null });
  const r = await consentRow(tx, id);
  const device: AgreementConsentDetail["device"] = {};
  const raw = r.deviceSnapshot;
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    for (const key of ["model", "system", "wechatVersion", "sdkVersion", "appVersion"] as const) {
      const value = raw[key];
      if (typeof value === "string") device[key] = value;
    }
  return {
    ...consentItem(r),
    contentSha256: r.contentSha256,
    isContentHashConsistent: r.contentSha256 === r.agreementVersion.contentSha256,
    appid: r.appid,
    hasOpenidSnapshot: r.openidHmac !== null,
    ipMask: maskIp(r.ip),
    userAgent: r.userAgent,
    device,
    requestId: r.requestId,
    revealableFields: mayRevealConsents(actor)
      ? ["phone", ...(r.usccEnc ? ["uscc" as const] : [])]
      : [],
    createdAt: r.createdAt.toISOString(),
  };
}
export async function consentList(
  tx: Tx,
  actor: AgreementActor,
  now: Date,
  q: AdminAgreementConsentListQuery,
) {
  assertAccess(actor.staff, { module: { module: "ops", need: "view" }, permission: null });
  const indexed = !!(
    q.merchantUserId ||
    q.entityId ||
    q.storeId ||
    q.bizId ||
    q.consentNo ||
    q.agreementVersionId
  );
  // 单侧日期补为有界自然日窗口；no不是索引键，不解除默认30日。
  const today = calendarDate(now);
  const fromDay = q.consentedFrom ?? (q.consentedTo ? addDays(q.consentedTo, -29) : !indexed ? addDays(today, -29) : undefined);
  const toDay = q.consentedTo ?? (q.consentedFrom ? today : !indexed ? today : undefined);
  if (fromDay && toDay && (fromDay > toDay || dayRange(toDay).start.getTime() - dayRange(fromDay).start.getTime() > 365 * 86400000))
    throw new AppError("VALIDATION_FAILED", { details: { fieldErrors: [{path: "consentedTo", message: "日期范围须为正序且至多366天"}] } });
  const from = fromDay ? dayRange(fromDay).start : undefined;
  const to = toDay ? dayRange(toDay).end : undefined;
  const where = {
    ...(q.agreementKey ? { agreementKey: { in: q.agreementKey.split(",") } } : {}),
    ...(q.agreementVersionId ? { agreementVersionId: q.agreementVersionId } : {}),
    ...(q.merchantUserId ? { merchantUserId: q.merchantUserId } : {}),
    ...(q.entityId ? { entityId: q.entityId } : {}),
    ...(q.storeId ? { storeId: q.storeId } : {}),
    ...(q.scene ? { scene: { in: q.scene.split(",") } } : {}),
    ...(q.method ? { method: q.method } : {}),
    ...(q.bizType ? { bizType: q.bizType } : {}),
    ...(q.bizId ? { bizId: q.bizId } : {}),
    ...(q.no ? { bizNo: q.no } : {}),
    ...(q.consentNo ? { seq: BigInt(q.consentNo) } : {}),
    ...(from || to
      ? { consentedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } }
      : {}),
  };
  const sort = q.sort === "consentedAt" ? ("asc" as const) : ("desc" as const);
  const [rows, total] = await Promise.all([
    tx.agreementConsent.findMany({
      where,
      include: consentInclude,
      orderBy: [{ consentedAt: sort }, { seq: sort }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    tx.agreementConsent.count({ where }),
  ]);
  return { items: rows.map(consentItem), page: q.page, pageSize: q.pageSize, total };
}
