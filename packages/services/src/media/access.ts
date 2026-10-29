import type { Prisma } from "@liyoxi/db";
import { UPLOAD_CATEGORIES, extensionOf } from "@liyoxi/shared/uploads";
import type { UploadCategory } from "@liyoxi/shared/uploads";
import {
  assertCapability,
  assertPermission,
  byEntity,
  byStore,
  hasCapability,
  satisfiesLevel,
} from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { BoundMediaDeps, FileRow, MediaActor, RegisterInput } from "./context.js";
const notFound = () => new AppError("NOT_FOUND");
export const inStaffScope = (staff: StaffContext): Prisma.FileObjectWhereInput => ({
  OR: [
    // 平台资金回单不能因无entity而绕过数据范围；owned与readable共用此查询边界。
    {
      scopeType: "platform",
      ...(staff.scope.kind === "all" ? {} : { category: { not: "pay_receipt" } }),
    },
    { scopeType: "entity", ...byEntity(staff.scope) },
    { scopeType: "store", ...byStore(staff.scope) },
  ],
});
export async function owned(tx: Tx, actor: MediaActor, fileId: string): Promise<FileRow> {
  const where: Prisma.FileObjectWhereInput = {
    id: fileId,
    uploadActorType: actor.identity.actor.type,
    uploadActorId: actor.identity.actor.id,
  };
  const merchant = actor.merchant;
  if (merchant)
    where.AND = [
      { entityId: merchant.entityId },
      { OR: [{ scopeType: "entity" }, { scopeType: "store", storeId: merchant.storeId }] },
    ];
  if (actor.staff) where.AND = [inStaffScope(actor.staff)];
  const file = await tx.fileObject.findFirst({ where });
  if (!file) throw notFound();
  return file;
}
export function assertMerchantCategory(actor: MediaActor, input: RegisterInput): void {
  const merchant = actor.merchant;
  if (!merchant || actor.identity.actor.type !== "merchant") throw new AppError("ROLE_FORBIDDEN");
  if (!UPLOAD_CATEGORIES[input.category].merchant) throw new AppError("ROLE_FORBIDDEN");
  const { standing } = merchant;
  if (input.category === "pay_receipt") {
    if (!(hasCapability(standing, "plan.purchase") || hasCapability(standing, "points.topup")))
      throw new AppError("ROLE_FORBIDDEN");
  } else
    assertCapability(
      standing,
      input.category.startsWith("kyc_")
        ? "store.qualification.edit"
        : input.category === "channel_screenshot"
          ? "channel.manage"
          : ["store_asset", "portrait_auth"].includes(input.category)
            ? "asset.upload"
            : "store.profile.edit",
    );
  if ((input.category === "kyc_license") !== (input.licenseKind !== undefined))
    throw new AppError("VALIDATION_FAILED", {
      details: {
        fieldErrors: [{ path: "licenseKind", message: "营业执照上传须指定证照种类，其他分类不填" }],
      },
    });
}
export async function registerScope(
  tx: Tx,
  deps: BoundMediaDeps,
  actor: MediaActor,
  input: RegisterInput,
) {
  const definition = UPLOAD_CATEGORIES[input.category];
  let scopeType = definition.scope;
  if (input.category === "kyc_license" && input.licenseKind === "branch_license")
    scopeType = "store";
  if (actor.merchant) {
    assertMerchantCategory(actor, input);
    if (["store_asset", "portrait_auth"].includes(input.category)) {
      if (!deps.assets) throw new AppError("PROVIDER_UNAVAILABLE");
      const store = await deps.assets.readStore(tx, actor.merchant.storeId);
      if (!store || store.entityId !== actor.merchant.entityId) throw notFound();
      if (store.lifecycle !== "active") throw new AppError("STATE_NOT_ALLOWED");
      if (
        input.category === "store_asset" &&
        actor.identity.actor.role === "clerk" &&
        !store.isPrimary &&
        store.qualificationStatus !== "verified"
      )
        throw new AppError("ASSET_UPLOAD_GATED");
    }
    return {
      scopeType,
      entityId: actor.merchant.entityId,
      storeId: scopeType === "store" ? actor.merchant.storeId : null,
      onBehalfStoreId: null,
    };
  }
  const staff = actor.staff;
  if (!staff || !definition.admin) throw new AppError("FILE_CATEGORY_NOT_ALLOWED");
  const financeFile = input.category === "pay_receipt" || input.category === "invoice";
  if (financeFile) {
    if (actor.identity.actor.type !== "staff" || actor.identity.actor.id !== staff.staff.id)
      throw new AppError("PERMISSION_DENIED");
    assertPermission(
      staff,
      input.category === "pay_receipt"
        ? "finance.receipt.confirm"
        : staff.permissions.has("finance.invoice.issue")
          ? "finance.invoice.issue"
          : "finance.invoice.red",
      deps.clock.now(),
    );
    if (input.onBehalfStore === true) throw new AppError("FILE_CATEGORY_NOT_ALLOWED");
  }
  if (["banner", "trailer_src", "drama_license_doc"].includes(input.category)) {
    if (
      actor.identity.actor.type !== "staff" ||
      actor.identity.actor.id !== staff.staff.id ||
      (input.category === "banner" && !satisfiesLevel(staff.moduleLevels.ops, "edit")) ||
      (input.category === "trailer_src" && !staff.permissions.has("drama.media.manage")) ||
      (input.category === "drama_license_doc" &&
        !satisfiesLevel(staff.moduleLevels.drama, "edit") &&
        !staff.permissions.has("drama.copyright.revise"))
    )
      throw new AppError("PERMISSION_DENIED");
    if (input.entityId || input.storeId || input.onBehalfStore)
      throw new AppError("FILE_CATEGORY_NOT_ALLOWED");
  }
  if (input.category === "legal_doc") {
    if (
      !satisfiesLevel(staff.moduleLevels.ops, "edit") ||
      actor.identity.actor.type !== "staff" ||
      actor.identity.actor.id !== staff.staff.id
    )
      throw new AppError("PERMISSION_DENIED");
    if (input.entityId || input.storeId || input.onBehalfStore)
      throw new AppError("FILE_CATEGORY_NOT_ALLOWED");
    const allowedExts = ["docx", "pdf"];
    if (input.files.some((file) => !allowedExts.includes(extensionOf(file.fileName) ?? "")))
      throw new AppError("FILE_TYPE_NOT_ALLOWED", { details: { allowedExts } });
  }
  if (["store_asset", "portrait_auth"].includes(input.category)) {
    if (actor.identity.actor.type !== "staff" || actor.identity.actor.id !== staff.staff.id)
      throw new AppError("PERMISSION_DENIED");
    assertPermission(staff, "merchant.asset.upload_on_behalf", deps.clock.now());
    if (!input.onBehalfStore) throw new AppError("FILE_CATEGORY_NOT_ALLOWED");
    if (!deps.assets) throw new AppError("PROVIDER_UNAVAILABLE");
    const store = input.storeId
      ? await deps.assets.readStore(tx, input.storeId, staff.scope)
      : null;
    if (!store) throw notFound();
    if (store.lifecycle !== "active") throw new AppError("STATE_NOT_ALLOWED");
    if (input.entityId && input.entityId !== store.entityId) throw notFound();
  }
  const guard = deps.guards.get(input.category);
  if (["sample_video", "final_episode"].includes(input.category) && !guard)
    throw new AppError("FILE_CATEGORY_NOT_ALLOWED");
  if (input.category === "poster" && !satisfiesLevel(staff.moduleLevels.drama, "edit"))
    throw new AppError("PERMISSION_DENIED");
  await guard?.assert(tx, actor, input);
  if (financeFile) {
    // 无主体的错款退回/线下退款回单：只给全范围且可处理资金退回的当前财务员工。
    // 不接受客户端scope，也不替代消费回单时的本人、申请状态及资金守卫。
    if (input.category === "pay_receipt" && !input.entityId && !input.storeId) {
      if (staff.scope.kind !== "all") throw notFound();
      assertPermission(
        staff,
        staff.permissions.has("finance.refund.execute")
          ? "finance.refund.execute"
          : "finance.recon.resolve",
        deps.clock.now(),
      );
      return {
        scopeType: "platform" as const,
        entityId: null,
        storeId: null,
        onBehalfStoreId: null,
      };
    }
    const store = input.storeId
      ? await tx.store.findFirst({
          where: { id: input.storeId, ...byStore(staff.scope).store },
          select: { entityId: true },
        })
      : null;
    if (input.storeId && !store) throw notFound();
    if (input.entityId && store && input.entityId !== store.entityId) throw notFound();
    const entityId = input.entityId ?? store?.entityId;
    if (!entityId)
      throw new AppError("VALIDATION_FAILED", {
        details: { fieldErrors: [{ path: "entityId", message: "请选择归属主体" }] },
      });
    const entity = await tx.entity.findFirst({
      where: { id: entityId, ...byEntity(staff.scope).entity },
      select: { id: true },
    });
    if (!entity) throw notFound();
    return {
      scopeType: "entity" as const,
      entityId: entity.id,
      storeId: null,
      onBehalfStoreId: null,
    };
  }
  // 无主体的账号换绑也需要证明：仅该分类、全范围员工允许平台归属。
  if (input.category === "account_proof") {
    if (!guard) throw new AppError("FILE_CATEGORY_NOT_ALLOWED");
    if (!input.entityId && !input.storeId) {
      if (staff.scope.kind !== "all" || input.onBehalfStore === true) throw notFound();
      return {
        scopeType: "platform" as const,
        entityId: null,
        storeId: null,
        onBehalfStoreId: null,
      };
    }
    if (input.entityId && !input.storeId) {
      const entity = await tx.entity.findFirst({
        where: { id: input.entityId, ...byEntity(staff.scope).entity },
        select: { id: true },
      });
      if (!entity || input.onBehalfStore === true) throw notFound();
      return {
        scopeType: "entity" as const,
        entityId: entity.id,
        storeId: null,
        onBehalfStoreId: null,
      };
    }
  }
  if (scopeType === "platform")
    return { scopeType, entityId: null, storeId: null, onBehalfStoreId: null };
  if (!input.storeId)
    throw new AppError("VALIDATION_FAILED", {
      details: { fieldErrors: [{ path: "storeId", message: "请选择归属门店" }] },
    });
  const store = await tx.store.findFirst({
    where: { id: input.storeId, ...byStore(staff.scope).store },
    select: { id: true, entityId: true },
  });
  if (!store) throw notFound();
  return {
    scopeType,
    entityId: store.entityId,
    storeId: scopeType === "store" ? store.id : null,
    onBehalfStoreId: input.onBehalfStore ? store.id : null,
  };
}
export function canReadCategory(
  staff: StaffContext,
  file: Pick<FileRow, "category" | "scopeType">,
): boolean {
  const level = (module: keyof StaffContext["moduleLevels"]) =>
    satisfiesLevel(staff.moduleLevels[module], "view");
  switch (file.category) {
    case "banner":
    case "trailer_src":
      return true;
    case "kyc_license":
    case "kyc_permit":
      return (
        staff.permissions.has("merchant.qualification.review") ||
        staff.permissions.has("pii.license.view")
      );
    case "pay_receipt":
      return level("finance");
    case "invoice":
      return level("finance") || level("service");
    case "profile_image":
    case "profile_video":
    case "profile_promo":
      return level("merchant");
    case "store_asset":
      return level("merchant") || staff.permissions.has("merchant.asset.review");
    case "portrait_auth":
      return (
        staff.permissions.has("merchant.asset.review") ||
        staff.permissions.has("merchant.asset.upload_on_behalf")
      );
    case "evidence":
      return level("publish");
    case "channel_screenshot":
      return level("publish");
    case "sample_video":
      return level("delivery") || level("publish") || level("service");
    case "final_episode":
      return staff.permissions.has("delivery.download") || level("publish");
    case "poster":
    case "drama_license_doc":
      return level("drama");
    case "legal_doc":
      return file.scopeType === "platform" ? level("ops") : level("finance") || level("service");
    case "account_proof":
      return (
        staff.permissions.has("merchant.account_change.request") ||
        staff.permissions.has("merchant.account_change.approve")
      );
    default:
      throw new AppError("FILE_CATEGORY_NOT_ALLOWED");
  }
}
export async function readableByStaff(
  tx: Tx,
  staff: StaffContext,
  fileId: string,
  deps?: Pick<BoundMediaDeps, "assets">,
): Promise<FileRow> {
  const file = await tx.fileObject.findFirst({ where: { id: fileId, ...inStaffScope(staff) } });
  if (!file) throw notFound();
  if (file.category === "account_proof") {
    if (!canReadCategory(staff, file)) throw notFound();
    const refs = await tx.fileRef.findMany({
      where: { fileId, refType: "account_change_request", role: "proof", state: "live" },
      select: { refId: true },
    });
    if (!refs.length) {
      if (
        file.uploadActorType !== "staff" ||
        file.uploadActorId !== staff.staff.id ||
        (file.scopeType === "platform" && staff.scope.kind !== "all")
      )
        throw notFound();
    } else {
      const request = await tx.accountChangeRequest.findFirst({
        where: {
          id: { in: refs.map((ref) => ref.refId) },
          proofFileIds: { has: fileId },
          ...(staff.scope.kind === "all"
            ? {}
            : {
                OR: [
                  { entityId: { not: null }, entity: byEntity(staff.scope).entity },
                  { entityId: null, approvalRequest: { requesterStaffId: staff.staff.id } },
                ],
              }),
        },
        select: { id: true },
      });
      if (!request) throw notFound();
    }
  }
  if (
    !canReadCategory(staff, file) &&
    !(
      file.category === "store_asset" &&
      file.storeId &&
      (await deps?.assets?.canReadEditingAsset(tx, {
        storeId: file.storeId,
        staffId: staff.staff.id,
      }))
    )
  )
    throw notFound();
  if (
    file.category === "legal_doc" &&
    file.scopeType === "platform" &&
    !(await tx.fileRef.findFirst({
      where: { fileId, refType: "agreement_version", state: "live" },
    }))
  )
    throw notFound();
  return file;
}
export const categoryOf = (file: FileRow) => file.category as UploadCategory;
