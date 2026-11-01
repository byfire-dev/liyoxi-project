import { AdminFileCreateBodySchema } from "@liyoxi/contract";
import { assertAccess, assertPermission } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Clock, Tx } from "../kernel/index.js";
import { declareAdProduction } from "../media/index.js";
import type { FileCategoryGuard, MediaActor, RegisterInput } from "../media/index.js";
import { noCancel } from "./lifecycle.js";
import { requireAdProductionAccess } from "./production-parent-facts.js";
import { assertCurrentAdStaff } from "./admin-read.js";

/** One runtime owns this clock and guard; static registrations never borrow another runtime. */
export function createAdFileGuard(clock: Clock): FileCategoryGuard {
  const context = async (tx: Tx, actor: MediaActor, input: RegisterInput) => {
    const staff = actor.staff;
    if (
      !staff ||
      actor.identity.actor.type !== "staff" ||
      actor.identity.actor.id !== staff.staff.id ||
      actor.identity.actor.client !== "admin"
    )
      throw new AppError("PERMISSION_DENIED");
    assertAccess(staff, {
      module: { module: "delivery", need: "edit" },
      permission: "delivery.ad.upload",
    });
    assertPermission(staff, "delivery.ad.upload", clock.now());
    const production = AdminFileCreateBodySchema.shape.production.parse(input.production);
    if (
      input.category !== "ad_video" ||
      !production ||
      production.kind !== "ad" ||
      !production.adId ||
      production.orderItemId !== undefined ||
      production.episodeNo !== undefined ||
      production.dramaEpisodeMasterId !== undefined
    )
      throw new AppError("VALIDATION_FAILED");
    await lockRows(tx, "staff", [staff.staff.id], "share");
    await assertCurrentAdStaff(tx, { ctx: actor.identity, staff });
    const initial = await tx.ad.findUnique({ where: { id: production.adId } });
    if (!initial) throw new AppError("NOT_FOUND");
    await lockRows(tx, "entity", [initial.entityId], "share");
    await lockRows(tx, "store", [initial.storeId], "share");
    await lockRows(tx, "ad", [initial.id], "share");
    await requireAdProductionAccess(tx, actor, initial.id);
    const ad = await tx.ad.findUniqueOrThrow({ where: { id: initial.id } });
    if (
      ad.editorId !== staff.staff.id ||
      input.storeId !== ad.storeId ||
      (input.entityId !== undefined && input.entityId !== ad.entityId)
    )
      throw new AppError("NOT_FOUND");
    noCancel(ad);
    if (!["producing", "revising"].includes(ad.status)) throw new AppError("STATE_NOT_ALLOWED");
    const store = await tx.store.findUniqueOrThrow({
      where: { id: ad.storeId },
      include: { entity: true },
    });
    if (store.lifecycle !== "active" || store.entity.lifecycle !== "active")
      throw new AppError("STATE_NOT_ALLOWED");
    return { ad, production, staffId: staff.staff.id };
  };
  return {
    assert: async (tx, actor, input) => {
      await context(tx, actor, input);
    },
    registered: async (tx, fileId, actor, input) => {
      const { ad, production, staffId } = await context(tx, actor, input);
      await declareAdProduction(tx, clock, {
        fileId,
        adId: ad.id,
        entityId: ad.entityId,
        storeId: ad.storeId,
        uploadedByStaffId: staffId,
        aiUsage: production.aiUsage,
      });
    },
  };
}
