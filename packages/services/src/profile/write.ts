import type {
  StoreProfileBasicPatch,
  StoreProfileMediaPatch,
  StoreProfileServicePatch,
  ContactPatch,
} from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { record } from "../audit/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { clearDraftStoreName, STORE_NAME_MIN, STORE_NAME_MAX } from "../tenant/index.js";
import { sealPhone } from "../security/index.js";
import { metaOf } from "./context.js";
import type { ProfileDeps, ProfileViewer } from "./context.js";
import { ensureProfile, loginPhone, refreshCompleteness, snapshot } from "./repo.js";
import { ensureDraft, linkCarried } from "./draft.js";
import { reviewFields } from "./round-basics.js";
import {
  assertVersion,
  invalid,
  lockFiles,
  newFile,
  requiredMissing,
  validateBasics,
} from "./validate.js";

import { applyLogo, applyMedia, applyServices } from "./write-parts.js";
const merchantEditScope = (viewer: ProfileViewer) => ({
  ctx: viewer.ctx,
  entityId: viewer.membership.entityId,
  storeId: viewer.membership.storeId,
  checkFile: (tx: Tx, id: string, categories: readonly string[]) =>
    newFile(tx, viewer, id, categories),
});
const edit = (viewer: ProfileViewer, now: Date) => ({
  lastEditedAt: now,
  lastEditActorType: viewer.ctx.actor.type,
  lastEditActorId: viewer.ctx.actor.id,
  lastEditClient: viewer.ctx.actor.client,
  lockVersion: { increment: 1 },
  updatedAt: now,
});
export async function changed(
  tx: Tx,
  deps: ProfileDeps,
  viewer: ProfileViewer,
  fields: string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  const { storeId, entityId } = viewer.membership;
  await record(tx, viewer.ctx.actor, metaOf(viewer.ctx), {
    stream: "activity",
    category: "profile_edit",
    action: "profile.store.save",
    summary: "保存门店档案",
    target: { type: "store_profile", id: storeId },
    entityId,
    storeId,
    fields,
    before,
    after,
  });
  if (fields.length)
    await deps.events.emit(tx, viewer.ctx, {
      type: "store.profile.changed",
      aggregate: { type: "store", id: storeId },
      payload: { v: 1, storeId, entityId, fields, source: "merchant" },
    });
}
const addressColumns = (
  address: StoreProfileBasicPatch["address"],
): Prisma.StoreProfileUpdateInput =>
  address === null
    ? {
        provinceCode: null,
        cityCode: null,
        districtCode: null,
        zoneCode: null,
        addressDetail: null,
        poiName: null,
        latitude: null,
        longitude: null,
      }
    : address
      ? {
          provinceCode: address.provinceCode,
          cityCode: address.cityCode,
          districtCode: address.districtCode,
          zoneCode: address.zoneCode,
          addressDetail: address.detail,
          poiName: address.poiName,
          latitude: address.latitude,
          longitude: address.longitude,
        }
      : {};
export async function saveBasic(
  tx: Tx,
  deps: ProfileDeps,
  viewer: ProfileViewer,
  input: StoreProfileBasicPatch,
) {
  const now = deps.clock.now(),
    storeId = viewer.membership.storeId;
  const first = await snapshot(tx, storeId);
  assertVersion(first.profile?.lockVersion ?? 0, input.lockVersion);
  const supplied =
    input.storeName !== undefined ||
    input.industryCode !== undefined ||
    input.address !== undefined;
  const willReview =
    first.store.qualificationStatus === "verified" &&
    (reviewFields(first, input).length > 0 ||
      (supplied && first.open?.kind === "change" && !first.open.submittedAt));
  if (first.open?.submittedAt && reviewFields(first, input).length)
    throw new AppError("QUALIFICATION_IN_REVIEW");
  if (willReview && !input.confirmReview && reviewFields(first, input).length)
    throw new AppError("REVIEW_REQUIRED", {
      details: { changedFields: reviewFields(first, input) },
    });
  const draft = willReview ? await ensureDraft(tx, deps, viewer) : null;
  if (!draft) await lockRows(tx, "store", [storeId]);
  const p = await ensureProfile(tx, storeId, now),
    before = await snapshot(tx, storeId);
  if (before.store.lifecycle !== "active" || before.store.entity.lifecycle !== "active")
    throw new AppError("STORE_ARCHIVED");
  assertVersion(p.lockVersion, input.lockVersion);
  await validateBasics(tx, input, p);
  const review = reviewFields(before, input);
  const address = addressColumns(input.address);
  if (review.length && (before.store.qualificationStatus === "pending" || before.open?.submittedAt))
    throw new AppError("QUALIFICATION_IN_REVIEW");
  if (review.length && before.store.qualificationStatus === "verified") {
    if (!input.confirmReview)
      throw new AppError("REVIEW_REQUIRED", { details: { changedFields: review } });
    if (!draft) throw new AppError("PRECONDITION_CHANGED");
  }
  if (draft) {
    const proposedName = input.storeName?.trim();
    if (
      proposedName !== undefined &&
      ([...proposedName].length < STORE_NAME_MIN || [...proposedName].length > STORE_NAME_MAX)
    )
      throw invalid("门店名称长度不符");
    if (
      input.storeName === null ||
      input.industryCode === null ||
      input.address === null ||
      (input.address &&
        [
          input.address.provinceCode,
          input.address.cityCode,
          input.address.districtCode,
          input.address.detail,
        ].some((v) => !v))
    )
      throw new AppError("PROFILE_REQUIRED_MISSING");
    const saved = await tx.qualificationSubmission.update({
      where: { id: draft.round.id },
      data: {
        ...(input.storeName === undefined ? {} : { proposedStoreName: proposedName }),
        ...(input.industryCode === undefined
          ? {}
          : { proposedIndustryCode: input.industryCode, proposedCategoryCode: input.categoryCode }),
        ...(input.address === undefined
          ? {}
          : {
              proposedAddressSnapshot: {
                provinceCode: input.address!.provinceCode,
                cityCode: input.address!.cityCode,
                districtCode: input.address!.districtCode,
                detail: input.address!.detail,
                poiName: input.address!.poiName,
                latitude: input.address!.latitude,
                longitude: input.address!.longitude,
              },
            }),
        lockVersion: { increment: 1 },
        updatedAt: now,
      },
    });
    await record(tx, viewer.ctx.actor, metaOf(viewer.ctx), {
      stream: "activity",
      category: "profile_edit",
      action: "profile.qualification.basic.save",
      summary: "保存资质变更待审值",
      target: { type: "qualification_submission", id: saved.id },
      entityId: p.entityId,
      storeId,
      fields: [
        "proposedStoreName",
        "proposedIndustryCode",
        "proposedCategoryCode",
        "proposedAddressSnapshot",
      ],
      before: {
        proposedStoreName: draft.round.proposedStoreName,
        proposedIndustryCode: draft.round.proposedIndustryCode,
        proposedCategoryCode: draft.round.proposedCategoryCode,
        proposedAddressSnapshot: draft.round.proposedAddressSnapshot,
      },
      after: {
        proposedStoreName: saved.proposedStoreName,
        proposedIndustryCode: saved.proposedIndustryCode,
        proposedCategoryCode: saved.proposedCategoryCode,
        proposedAddressSnapshot: saved.proposedAddressSnapshot,
      },
    });
    for (const key of ["provinceCode", "cityCode", "districtCode", "addressDetail"] as const)
      delete address[key];
  }
  if (!draft && input.storeName !== undefined && input.storeName !== before.store.name) {
    if (input.storeName === null) {
      if (before.store.qualificationStatus !== "unsubmitted")
        throw new AppError("PROFILE_REQUIRED_MISSING");
      if (!input.draft) throw invalid("第 1 步必填缺项：store_name");
      await clearDraftStoreName(tx, now, viewer.ctx, { storeId });
    } else await deps.tenant.setStoreName(tx, viewer.ctx, { storeId, name: input.storeName });
  }
  await lockFiles(tx, [
    p.logoFileId,
    input.logoFileId,
    ...(draft?.carried.map((d) => d.fileId) ?? []),
  ]);
  if (draft) await linkCarried(tx, deps, viewer, draft.carried);
  await applyLogo(tx, deps, merchantEditScope(viewer), p.logoFileId, input, now);
  const data: Prisma.StoreProfileUpdateInput = { ...address, ...edit(viewer, now) };
  for (const key of [
    "brandName",
    "logoFileId",
    "industryCode",
    "categoryCode",
    "businessHours",
    "storeTel",
    "avgSpendFen",
    "brandIntro",
  ] as const)
    if (input[key] !== undefined && !(draft && (key === "industryCode" || key === "categoryCode")))
      Object.assign(data, { [key]: input[key] });
  await tx.storeProfile.update({ where: { storeId }, data });
  const after = await snapshot(tx, storeId);
  requiredMissing(before, after, 1, input.draft);
  await refreshCompleteness(tx, storeId, now);
  const auditValue = (s: typeof after) => ({
    brandName: s.profile?.brandName,
    storeName: s.store.name,
    industryCode: s.profile?.industryCode,
    categoryCode: s.profile?.categoryCode,
    address: {
      provinceCode: s.profile?.provinceCode,
      cityCode: s.profile?.cityCode,
      districtCode: s.profile?.districtCode,
      zoneCode: s.profile?.zoneCode,
      detail: s.profile?.addressDetail,
      poiName: s.profile?.poiName,
      latitude: s.profile?.latitude?.toNumber(),
      longitude: s.profile?.longitude?.toNumber(),
    },
    businessHours: s.profile?.businessHours,
    publicContactNumber: s.profile?.storeTel,
    avgSpendFen: s.profile?.avgSpendFen,
    brandIntro: s.profile?.brandIntro,
    logoFileId: s.profile?.logoFileId,
  });
  const oldValue = auditValue(before),
    newValue = auditValue(after);
  await changed(
    tx,
    deps,
    viewer,
    Object.keys(newValue).filter(
      (key) =>
        JSON.stringify(oldValue[key as keyof typeof oldValue]) !==
        JSON.stringify(newValue[key as keyof typeof newValue]),
    ),
    oldValue,
    newValue,
  );
  return after;
}
export async function saveMedia(
  tx: Tx,
  deps: ProfileDeps,
  viewer: ProfileViewer,
  input: StoreProfileMediaPatch,
) {
  const now = deps.clock.now(),
    storeId = viewer.membership.storeId;
  await lockRows(tx, "store", [storeId]);
  const p = await ensureProfile(tx, storeId, now),
    before = await snapshot(tx, storeId);
  if (before.store.lifecycle !== "active" || before.store.entity.lifecycle !== "active")
    throw new AppError("STORE_ARCHIVED");
  assertVersion(p.lockVersion, input.lockVersion);
  await applyMedia(tx, deps, merchantEditScope(viewer), before, input.groups, now);
  await tx.storeProfile.update({ where: { storeId }, data: edit(viewer, now) });
  const after = await snapshot(tx, storeId);
  requiredMissing(before, after, 2, input.draft);
  await refreshCompleteness(tx, storeId, now);
  const rows = (s: typeof after) =>
    s.media.map((row) => ({ fileId: row.fileId, group: row.mediaGroup, position: row.position }));
  const same = JSON.stringify(rows(before)) === JSON.stringify(rows(after));
  await changed(
    tx,
    deps,
    viewer,
    same ? [] : ["media"],
    { media: rows(before) },
    { media: rows(after) },
  );
  return after;
}
export async function saveService(
  tx: Tx,
  deps: ProfileDeps,
  viewer: ProfileViewer,
  input: StoreProfileServicePatch,
) {
  const now = deps.clock.now(),
    storeId = viewer.membership.storeId;
  await lockRows(tx, "store", [storeId]);
  const p = await ensureProfile(tx, storeId, now),
    before = await snapshot(tx, storeId);
  if (before.store.lifecycle !== "active" || before.store.entity.lifecycle !== "active")
    throw new AppError("STORE_ARCHIVED");
  assertVersion(p.lockVersion, input.lockVersion);
  await applyServices(tx, deps, merchantEditScope(viewer), before, input, now);
  const data: Prisma.StoreProfileUpdateInput = edit(viewer, now);
  for (const key of ["promoText", "groupBuyText", "sellingNote", "sellingPointCodes"] as const)
    if (input[key] !== undefined) Object.assign(data, { [key]: input[key] });
  await tx.storeProfile.update({ where: { storeId }, data });
  const after = await snapshot(tx, storeId);
  requiredMissing(before, after, 3, input.draft);
  await refreshCompleteness(tx, storeId, now);
  const value = (s: typeof after) => ({
    serviceItems: s.services.map((row) => ({
      id: row.id,
      name: row.name,
      priceFen: row.priceFen,
      originalPriceFen: row.originalPriceFen,
      imageFileId: row.imageFileId,
      intro: row.intro,
      position: row.position,
    })),
    promoText: s.profile?.promoText,
    groupBuyText: s.profile?.groupBuyText,
    sellingPointCodes: s.profile?.sellingPointCodes,
    sellingNote: s.profile?.sellingNote,
  });
  const a = value(before),
    b = value(after);
  await changed(
    tx,
    deps,
    viewer,
    Object.keys(b).filter(
      (key) =>
        JSON.stringify(a[key as keyof typeof a]) !== JSON.stringify(b[key as keyof typeof b]),
    ),
    a,
    b,
  );
  return after;
}
export async function saveContact(
  tx: Tx,
  deps: ProfileDeps,
  viewer: ProfileViewer,
  input: ContactPatch,
  verified = false,
) {
  const now = deps.clock.now(),
    storeId = viewer.membership.storeId;
  await lockRows(tx, "store", [storeId]);
  const profile = await ensureProfile(tx, storeId, now);
  const current = await snapshot(tx, storeId);
  if (current.store.lifecycle !== "active" || current.store.entity.lifecycle !== "active")
    throw new AppError("STORE_ARCHIVED");
  assertVersion(profile.lockVersion, input.lockVersion);
  const user = await tx.merchantUser.findUniqueOrThrow({
    where: { id: viewer.principal.merchantUserId },
    select: { phoneEnc: true, phoneMask: true },
  });
  const original = loginPhone(deps.keyring(), user);
  const phone = input.phoneSource === "login" ? original : input.phone;
  if (!phone || !/^1\d{10}$/.test(phone)) throw invalid("登录手机号不可用");
  const sealed = sealPhone(deps.keyring(), "store_profile.contact_phone_enc", phone);
  const phoneSource = phone === original ? "login" : verified ? "sms_verified" : "unverified";
  await tx.storeProfile.update({
    where: { storeId },
    data: {
      ...edit(viewer, now),
      contactName: input.name,
      contactPhoneEnc: sealed.enc,
      contactPhoneMask: sealed.mask,
      contactPhoneSource: phoneSource,
      contactPhoneVerifiedAt: phoneSource === "sms_verified" ? now : null,
    },
  });
  await refreshCompleteness(tx, storeId, now);
  await changed(
    tx,
    deps,
    viewer,
    ["contact"],
    { contactName: profile.contactName, contactPhoneMask: profile.contactPhoneMask },
    { contactName: input.name, contactPhoneMask: sealed.mask },
  );
  return snapshot(tx, storeId);
}
