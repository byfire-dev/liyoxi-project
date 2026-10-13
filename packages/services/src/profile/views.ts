import { QUALIFICATION_DECLARATION_VERSION } from "@liyoxi/contract";
import { paramsAt } from "../config/index.js";
import type { QualificationDoc } from "@liyoxi/db";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import type { Tx } from "../kernel/index.js";
import type { Keyring } from "../security/index.js";
import type { ProfileDeps } from "./context.js";
import { dictRef, permitSpec, submittedFields } from "./repo.js";
import type { ProfileSnapshot } from "./repo.js";
import { pendingView } from "./round-basics.js";
import { readQualificationRecognition } from "../media/index.js";

export const instant = (date: Date | null | undefined) => date?.toISOString() ?? null;
const day = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;
export async function mediaFile(tx: Tx, fileId: string | null) {
  if (!fileId) return null;
  const file = await tx.fileObject.findUnique({ where: { id: fileId } });
  if (!file) return null;
  const info = await tx.mediaInfo.findUnique({ where: { fileId } });
  return {
    fileId,
    kind: (file.mime ?? "").startsWith("image/")
      ? "image"
      : (file.mime ?? "").startsWith("video/")
        ? "video"
        : "document",
    url: null,
    expiresAt: null,
    coverUrl: null,
    durationMs: info?.durationMs ?? null,
    displayWidth: info?.displayWidth ?? null,
    displayHeight: info?.displayHeight ?? null,
    moderationState: file.moderationState,
  };
}
export async function addressView(tx: Tx, p: ProfileSnapshot["profile"]) {
  return {
    province: await dictRef(tx, "region", p?.provinceCode),
    city: await dictRef(tx, "region", p?.cityCode),
    district: await dictRef(tx, "region", p?.districtCode),
    zone: await dictRef(tx, "region", p?.zoneCode),
    detail: p?.addressDetail ?? null,
    poiName: p?.poiName ?? null,
    latitude: p?.latitude?.toNumber() ?? null,
    longitude: p?.longitude?.toNumber() ?? null,
  };
}
export async function basicView(tx: Tx, s: ProfileSnapshot) {
  const p = s.profile;
  return {
    viewerRole: "owner" as const,
    brandName: p?.brandName ?? null,
    logo: await mediaFile(tx, p?.logoFileId ?? null),
    storeName: s.store.name,
    industry: await dictRef(tx, "industry", p?.industryCode),
    category: await dictRef(tx, "industry", p?.categoryCode),
    address: await addressView(tx, p),
    businessHours: p?.businessHours ?? [],
    storeTel: p?.storeTel ?? null,
    avgSpendFen: p?.avgSpendFen ?? null,
    brandIntro: p?.brandIntro ?? null,
    reviewFieldsLocked:
      s.store.qualificationStatus === "pending" ||
      (s.open?.kind === "change" && s.open.submittedAt !== null),
    reviewRequiredOnChange: s.store.qualificationStatus === "verified",
    pendingChange: await pendingView(tx, s.open),
    lastEditedAt: instant(p?.lastEditedAt),
    lockVersion: p?.lockVersion ?? 0,
    completeness: s.completeness,
  };
}
export async function mediaView(tx: Tx, s: ProfileSnapshot) {
  const groups: Record<"door" | "interior" | "product" | "promo", unknown[]> = {
    door: [],
    interior: [],
    product: [],
    promo: [],
  };
  for (const row of s.media)
    groups[row.mediaGroup as keyof typeof groups].push({
      mediaItemId: row.id,
      position: row.position,
      mediaKind: row.mediaKind,
      file: await mediaFile(tx, row.fileId),
      isCopied: row.copiedFromStoreId !== null,
    });
  return {
    viewerRole: "owner" as const,
    groups,
    lockVersion: s.profile?.lockVersion ?? 0,
    completeness: s.completeness,
  };
}
export async function serviceView(tx: Tx, s: ProfileSnapshot) {
  const serviceItems = [];
  for (const row of s.services)
    serviceItems.push({
      serviceItemId: row.id,
      position: row.position,
      name: row.name,
      priceFen: row.priceFen,
      originalPriceFen: row.originalPriceFen,
      image: await mediaFile(tx, row.imageFileId),
      intro: row.intro,
    });
  const sellingPoints = [];
  for (const code of s.profile?.sellingPointCodes ?? [])
    sellingPoints.push(await dictRef(tx, "store_selling_point", code));
  return {
    viewerRole: "owner" as const,
    serviceItems,
    promoText: s.profile?.promoText ?? null,
    groupBuyText: s.profile?.groupBuyText ?? null,
    sellingPoints,
    sellingNote: s.profile?.sellingNote ?? null,
    lockVersion: s.profile?.lockVersion ?? 0,
    completeness: s.completeness,
  };
}
export async function docView(tx: Tx, keyring: Keyring, now: Date, doc: QualificationDoc) {
  const fields = submittedFields(keyring, doc);
  const recognition = await readQualificationRecognition(tx, keyring, doc);
  const displayFields = [];
  if (doc.docType === "industry_permit" && doc.permitType) {
    const spec = await permitSpec(tx, doc.permitType);
    for (const field of spec.fields)
      if (
        !field.sensitive &&
        ![spec.holderNameKey, spec.validFromKey, spec.validToKey].includes(field.key) &&
        fields[field.key]
      )
        displayFields.push({ key: field.key, label: field.label, value: fields[field.key]! });
  } else
    for (const [key, label] of [
      ["address", "住所"],
      ["businessScope", "经营范围"],
    ])
      if (key && fields[key]) displayFields.push({ key, label: label!, value: fields[key]! });
  const end = day(doc.validEndDate);
  const today = calendarDate(now);
  const remind = (await paramsAt(tx, ["remind.cert_expiry.days"], now))["remind.cert_expiry.days"];
  return {
    qualificationDocId: doc.id,
    docType: doc.docType,
    permitType: await dictRef(tx, "permit_type", doc.permitType),
    scope: doc.scope,
    origin: doc.origin,
    fileId: doc.fileId,
    ocrStatus: recognition.status,
    ocrWarnings: recognition.warnings,
    hasSubmittedFields: doc.submittedFieldsEnc !== null,
    holderName: doc.holderName,
    certNoMask: doc.certNoMask,
    principalNameMask: doc.principalNameMask,
    principalRole: doc.principalRole,
    subjectType: doc.subjectType,
    validStartDate: day(doc.validStartDate),
    validEndDate: end,
    isLongTerm: doc.isLongTerm,
    expiryState:
      end && end < today ? "expired" : end && end <= addDays(today, remind) ? "expiring" : "none",
    displayFields,
    verdict: doc.verdict,
    isEffective: doc.effectiveAt !== null && doc.supersededAt === null,
    uploadedAt: doc.createdAt.toISOString(),
  };
}
export async function contactView(
  tx: Tx,
  s: ProfileSnapshot,
  merchantUserId: string,
  available = false,
) {
  const user = await tx.merchantUser.findUnique({
    where: { id: merchantUserId },
    select: { phoneMask: true },
  });
  return {
    name: s.profile?.contactName ?? null,
    phoneMask: s.profile?.contactPhoneMask ?? null,
    phoneVerifyState: s.profile?.contactPhoneSource ?? null,
    phoneVerifiedAt: instant(s.profile?.contactPhoneVerifiedAt),
    loginPhoneMask: user?.phoneMask ?? null,
    isSmsVerifyAvailable: available,
    lockVersion: s.profile?.lockVersion ?? 0,
  };
}
async function roundView(tx: Tx, deps: ProfileDeps, round: NonNullable<ProfileSnapshot["open"]>) {
  const approval = round.approvalRequest;
  const contact = round.contactSnapshot as {
    name: string;
    phoneMask: string;
    phoneSource: string;
  } | null;
  const docs = [];
  for (const doc of round.qualificationDocs)
    docs.push(await docView(tx, deps.keyring(), deps.clock.now(), doc));
  const rejectReasons = [];
  for (const code of approval?.reasonCodes ?? [])
    rejectReasons.push(await dictRef(tx, "reject_reason", code));
  return {
    qualificationSubmissionId: round.id,
    kind: round.kind,
    phase: round.closedAt ? "closed" : round.submittedAt ? "in_review" : "draft",
    roundNo: round.roundNo,
    isResubmit: round.resubmitOfQualificationSubmissionId !== null,
    claimedEntityType: round.claimedEntityType,
    declarationConfirmedAt: instant(round.declarationConfirmedAt),
    declarationVersion: round.declarationVersion,
    changedFields: round.changedFields,
    proposed: await pendingView(tx, round),
    contactSnapshot: contact
      ? { name: contact.name, phoneMask: contact.phoneMask, phoneVerifyState: contact.phoneSource }
      : null,
    submittedAt: instant(round.submittedAt),
    dueAt: instant(approval?.dueAt),
    closedAt: instant(round.closedAt),
    outcome: round.outcome,
    decidedAt: instant(approval?.decidedAt),
    isDecidedBySystem: approval?.isDecidedBySystem ?? false,
    rejectReasons,
    decisionNote: approval?.decisionNote ?? null,
    systemRejectCode: round.systemRejectCode,
    finalRejectedAt: instant(round.finalRejectedAt),
    docs,
    lockVersion: round.lockVersion,
  };
}
export async function qualificationView(
  tx: Tx,
  deps: ProfileDeps,
  s: ProfileSnapshot,
  merchantUserId: string,
) {
  const e = s.store.entity;
  const effective = await tx.qualificationDoc.findMany({
    where: {
      entityId: e.id,
      effectiveAt: { not: null },
      supersededAt: null,
      removedAt: null,
      OR: [
        { scope: "entity", docType: "business_license" },
        { storeId: s.store.id, scope: "store" },
      ],
    },
  });
  const effectiveDocs = [];
  for (const doc of effective)
    effectiveDocs.push(await docView(tx, deps.keyring(), deps.clock.now(), doc));
  const required = [];
  for (const code of s.permits)
    required.push({
      permitType: await dictRef(tx, "permit_type", code),
      isProvided: s.open?.qualificationDocs.some((d) => d.permitType === code) ?? false,
    });
  return {
    viewerRole: "owner" as const,
    storeQualificationStatus: s.store.qualificationStatus,
    isChangeInReview: s.open?.kind === "change" && s.open.submittedAt !== null,
    isFinalRejected: s.profile?.finalRejectedAt != null,
    entity: {
      verificationStatus: e.verificationStatus,
      name: e.name,
      entityType: e.entityType,
      usccMask: e.usccMask,
      legalRepNameMask: e.legalRepNameMask,
      verifiedAt: instant(e.verifiedAt),
    },
    openRound: s.open ? await roundView(tx, deps, s.open) : null,
    lastClosedRound: s.last ? await roundView(tx, deps, s.last) : null,
    effectiveDocs,
    requiredPermits: required,
    contact: await contactView(
      tx,
      s,
      merchantUserId,
      (await deps.contactSms?.available(tx)) ?? false,
    ),
    declaration: { currentVersion: QUALIFICATION_DECLARATION_VERSION },
    actions:
      s.open && !s.open.submittedAt
        ? s.open.kind === "initial"
          ? s.profile?.finalRejectedAt
            ? []
            : ["submit"]
          : [...(s.profile?.finalRejectedAt ? [] : ["submit"]), "discard"]
        : [],
  };
}
/** DTO 随事务落幂等结果时地址为空。首响应/GET 在提交后签地址；重放永不重新签。 */
export async function attachUrls<T>(
  deps: ProfileDeps,
  result: T,
  replayed = false,
  signing: {
    audience?: "staff" | "merchant";
    assertAccess?: (fileId: string, coverFileId?: string) => Promise<void>;
  } = {},
): Promise<T> {
  if (replayed) return result;
  async function visit(value: unknown): Promise<void> {
    if (Array.isArray(value)) {
      for (const item of value) await visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (
      typeof row["fileId"] === "string" &&
      typeof row["kind"] === "string" &&
      Object.hasOwn(row, "url")
    ) {
      const fileId = row["fileId"];
      const technical = await deps.tx.run((tx) =>
        tx.fileObject.findUnique({
          where: { id: fileId },
          select: {
            status: true,
            moderationState: true,
            mediaInfo: { select: { coverFileId: true } },
          },
        }),
      );
      if (technical?.status === "stored" && technical.moderationState !== "block") {
        await signing.assertAccess?.(fileId);
        const signed = await deps.media.signRead({
          fileId,
          audience: signing.audience ?? "merchant",
        });
        await signing.assertAccess?.(fileId);
        row["url"] = signed.url;
        row["expiresAt"] = signed.expiresAt;
        const coverFileId = technical.mediaInfo?.coverFileId;
        if (coverFileId) {
          const cover = await deps.tx.run((tx) =>
            tx.fileObject.findUnique({
              where: { id: coverFileId },
              select: { status: true, moderationState: true },
            }),
          );
          if (cover?.status === "stored" && cover.moderationState !== "block") {
            await signing.assertAccess?.(fileId, coverFileId);
            const signedCover = await deps.media.signRead({
              fileId: coverFileId,
              audience: signing.audience ?? "merchant",
            });
            await signing.assertAccess?.(fileId, coverFileId);
            row["coverUrl"] = signedCover.url;
          }
        }
      }
      return;
    }
    for (const child of Object.values(row)) await visit(child);
  }
  await visit(result);
  return result;
}
