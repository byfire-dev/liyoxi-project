import type {
  StoreProfileBasicPatch,
  StoreProfileMediaPatch,
  StoreProfileServicePatch,
  ContactPatch,
} from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { record } from "../audit/index.js";
import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { clearDraftStoreName } from "../tenant/index.js";
import { sealPhone } from "../security/index.js";
import { metaOf } from "./context.js";
import type { ProfileDeps, ProfileViewer } from "./context.js";
import { ensureProfile, loginPhone, refreshCompleteness, snapshot } from "./repo.js";
import {
  assertVersion,
  invalid,
  lockFiles,
  newCode,
  newFile,
  requiredMissing,
  validateBasics,
} from "./validate.js";

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
  await lockRows(tx, "store", [storeId]);
  const p = await ensureProfile(tx, storeId, now),
    before = await snapshot(tx, storeId);
  if (before.store.lifecycle !== "active" || before.store.entity.lifecycle !== "active")
    throw new AppError("STORE_ARCHIVED");
  assertVersion(p.lockVersion, input.lockVersion);
  await validateBasics(tx, input, p);
  const review = [];
  if (input.storeName !== undefined && input.storeName !== before.store.name)
    review.push("store_name");
  if (
    input.industryCode !== undefined &&
    (input.industryCode !== p.industryCode || input.categoryCode !== p.categoryCode)
  )
    review.push("industry");
  const address = addressColumns(input.address);
  if (
    input.address !== undefined &&
    ["provinceCode", "cityCode", "districtCode", "addressDetail"].some(
      (key) => (address as Record<string, unknown>)[key] !== p[key as keyof typeof p],
    )
  )
    review.push("address");
  if (review.length && before.store.qualificationStatus === "pending")
    throw new AppError("QUALIFICATION_IN_REVIEW");
  if (review.length && before.store.qualificationStatus === "verified") {
    if (!input.confirmReview)
      throw new AppError("REVIEW_REQUIRED", { details: { changedFields: review } });
    throw new AppError("STATE_NOT_ALLOWED", { details: { reason: "change_round_not_open" } });
  }
  if (input.storeName !== undefined && input.storeName !== before.store.name) {
    if (input.storeName === null) {
      if (before.store.qualificationStatus !== "unsubmitted")
        throw new AppError("PROFILE_REQUIRED_MISSING");
      if (!input.draft) throw invalid("第 1 步必填缺项：store_name");
      await clearDraftStoreName(tx, now, viewer.ctx, { storeId });
    } else await deps.tenant.setStoreName(tx, viewer.ctx, { storeId, name: input.storeName });
  }
  await lockFiles(tx, [p.logoFileId, input.logoFileId]);
  if (input.logoFileId !== undefined && input.logoFileId !== p.logoFileId) {
    if (input.logoFileId) {
      await newFile(tx, viewer, input.logoFileId, ["profile_image"]);
      await deps.media.link(tx, {
        fileId: input.logoFileId,
        refType: "store_profile",
        refId: storeId,
        role: "logo",
        entityId: p.entityId,
        storeId,
      });
    }
    if (p.logoFileId)
      await deps.media.release(tx, {
        fileId: p.logoFileId,
        refType: "store_profile",
        refId: storeId,
        role: "logo",
        entityId: p.entityId,
        storeId,
        keepUntil: new Date(now.getTime() + 30 * 86_400_000),
      });
  }
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
    if (input[key] !== undefined) Object.assign(data, { [key]: input[key] });
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
  await lockFiles(tx, [
    ...before.media.map((row) => row.fileId),
    ...Object.values(input.groups).flatMap((items) => items.map((item) => item.fileId)),
  ]);
  for (const [group, items] of Object.entries(input.groups)) {
    if (new Set(items.map((item) => item.fileId)).size !== items.length)
      throw invalid("同组文件不能重复");
    const old = before.media.filter((row) => row.mediaGroup === group);
    const kinds = [];
    for (const item of items) {
      const kept = old.find((row) => row.fileId === item.fileId);
      const file = kept
        ? before.files.get(item.fileId)!
        : await newFile(
            tx,
            viewer,
            item.fileId,
            group === "promo"
              ? ["profile_promo"]
              : group === "product"
                ? ["profile_image", "profile_video"]
                : ["profile_image"],
          );
      const kind = (file.mime ?? "").startsWith("image/")
        ? "image"
        : (file.mime ?? "").startsWith("video/")
          ? "video"
          : "other";
      if (kind === "other" || ((group === "door" || group === "interior") && kind !== "image"))
        throw invalid("媒体组类型不符");
      if (kind === "video") {
        const info = await tx.mediaInfo.findUnique({ where: { fileId: item.fileId } });
        if (group === "product" && info?.durationMs != null && info.durationMs > 60_000)
          throw invalid("实拍视频不得超过 60 秒");
      }
      kinds.push(kind);
    }
    if (
      (group === "door" && items.length > 3) ||
      (group === "interior" && items.length > 9) ||
      (group === "promo" && items.length > 9) ||
      (group === "product" &&
        (kinds.filter((k) => k === "image").length > 9 ||
          kinds.filter((k) => k === "video").length > 3))
    )
      throw invalid("媒体组数量超限");
    // 临时挪开位置，免得同组的交换顺序撞在用位置唯一索引。
    await tx.storeProfileMedia.updateMany({
      where: { storeId, mediaGroup: group, removedAt: null },
      data: { position: { increment: 100 } },
    });
    for (const removed of old.filter((row) => !items.some((item) => item.fileId === row.fileId))) {
      await tx.storeProfileMedia.update({
        where: { id: removed.id },
        data: { removedAt: now, updatedAt: now },
      });
      await deps.media.release(tx, {
        fileId: removed.fileId,
        refType: "store_profile_media",
        refId: removed.id,
        role: "main",
        entityId: p.entityId,
        storeId,
        keepUntil: new Date(now.getTime() + 30 * 86_400_000),
      });
    }
    for (const [i, item] of items.entries()) {
      const kept = old.find((row) => row.fileId === item.fileId);
      if (kept)
        await tx.storeProfileMedia.update({
          where: { id: kept.id },
          data: { position: i + 1, updatedAt: now },
        });
      else {
        const id = uuidv7();
        await tx.storeProfileMedia.create({
          data: {
            id,
            entityId: p.entityId,
            storeId,
            mediaGroup: group,
            position: i + 1,
            fileId: item.fileId,
            mediaKind: kinds[i]!,
            createActorType: viewer.ctx.actor.type,
            createActorId: viewer.ctx.actor.id,
            createClient: viewer.ctx.actor.client,
            createdAt: now,
            updatedAt: now,
          },
        });
        await deps.media.link(tx, {
          fileId: item.fileId,
          refType: "store_profile_media",
          refId: id,
          role: "main",
          entityId: p.entityId,
          storeId,
        });
      }
    }
  }
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
  for (const code of input.sellingPointCodes ?? [])
    await newCode(
      tx,
      "store_selling_point",
      code,
      p.sellingPointCodes.includes(code) ? code : null,
      "sellingPointCodes",
    );
  if (input.serviceItems !== undefined) {
    const items = input.serviceItems,
      old = before.services;
    const ids = items.flatMap((item) => (item.serviceItemId ? [item.serviceItemId] : []));
    if (new Set(ids).size !== ids.length || ids.some((id) => !old.some((row) => row.id === id)))
      throw invalid("服务行不是本门店在用项，或重复");
    await lockFiles(tx, [
      ...old.map((row) => row.imageFileId),
      ...items.map((item) => item.imageFileId),
    ]);
    await tx.storeServiceItem.updateMany({
      where: { storeId, removedAt: null },
      data: { position: { increment: 100 } },
    });
    for (const row of old.filter((row) => !ids.includes(row.id))) {
      await tx.storeServiceItem.update({
        where: { id: row.id },
        data: { removedAt: now, updatedAt: now },
      });
      if (row.imageFileId)
        await deps.media.release(tx, {
          fileId: row.imageFileId,
          refType: "store_service_item",
          refId: row.id,
          role: "image",
          entityId: p.entityId,
          storeId,
          keepUntil: new Date(now.getTime() + 30 * 86_400_000),
        });
    }
    for (const [i, item] of items.entries()) {
      const row = old.find((row) => row.id === item.serviceItemId),
        id = row?.id ?? uuidv7();
      const imageFileId =
        item.imageFileId === undefined ? (row?.imageFileId ?? null) : item.imageFileId;
      if (imageFileId && imageFileId !== row?.imageFileId) {
        await newFile(tx, viewer, imageFileId, ["profile_image"]);
        await deps.media.link(tx, {
          fileId: imageFileId,
          refType: "store_service_item",
          refId: id,
          role: "image",
          entityId: p.entityId,
          storeId,
        });
      }
      if (row?.imageFileId && row.imageFileId !== imageFileId)
        await deps.media.release(tx, {
          fileId: row.imageFileId,
          refType: "store_service_item",
          refId: id,
          role: "image",
          entityId: p.entityId,
          storeId,
          keepUntil: new Date(now.getTime() + 30 * 86_400_000),
        });
      const previousOriginal =
        item.originalPriceFen === undefined
          ? (row?.originalPriceFen ?? null)
          : item.originalPriceFen;
      if (previousOriginal !== null && previousOriginal < item.priceFen)
        throw invalid("原价不得低于现价");
      const data = {
        name: item.name,
        priceFen: item.priceFen,
        originalPriceFen:
          item.originalPriceFen === undefined
            ? (row?.originalPriceFen ?? null)
            : item.originalPriceFen,
        imageFileId,
        intro: item.intro === undefined ? (row?.intro ?? null) : item.intro,
        position: i + 1,
        updatedAt: now,
      };
      if (row) await tx.storeServiceItem.update({ where: { id }, data });
      else
        await tx.storeServiceItem.create({
          data: { ...data, id, entityId: p.entityId, storeId, createdAt: now },
        });
    }
  }
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
  const phoneSource = phone === original ? "login" : "unverified";
  await tx.storeProfile.update({
    where: { storeId },
    data: {
      ...edit(viewer, now),
      contactName: input.name,
      contactPhoneEnc: sealed.enc,
      contactPhoneMask: sealed.mask,
      contactPhoneSource: phoneSource,
      contactPhoneVerifiedAt: null,
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
