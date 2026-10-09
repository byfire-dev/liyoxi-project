import type { Prisma } from "@liyoxi/db";
import { UPLOAD_CATEGORIES, extensionOf } from "@liyoxi/shared/uploads";
import type { UploadCategory } from "@liyoxi/shared/uploads";
import {
  assertCapability,
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
    { scopeType: "platform" },
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
    return {
      scopeType,
      entityId: actor.merchant.entityId,
      storeId: scopeType === "store" ? actor.merchant.storeId : null,
      onBehalfStoreId: null,
    };
  }
  const staff = actor.staff;
  if (!staff || !definition.admin) throw new AppError("FILE_CATEGORY_NOT_ALLOWED");
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
  const guard = deps.guards.get(input.category);
  if (["sample_video", "final_episode"].includes(input.category) && !guard)
    throw new AppError("FILE_CATEGORY_NOT_ALLOWED");
  if (input.category === "poster" && !satisfiesLevel(staff.moduleLevels.drama, "edit"))
    throw new AppError("PERMISSION_DENIED");
  await guard?.assert(tx, actor, input);
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
    case "profile_image":
    case "profile_video":
    case "profile_promo":
      return level("merchant");
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
    default:
      throw new AppError("FILE_CATEGORY_NOT_ALLOWED");
  }
}
export async function readableByStaff(
  tx: Tx,
  staff: StaffContext,
  fileId: string,
): Promise<FileRow> {
  const file = await tx.fileObject.findFirst({ where: { id: fileId, ...inStaffScope(staff) } });
  if (!file || !canReadCategory(staff, file)) throw notFound();
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
