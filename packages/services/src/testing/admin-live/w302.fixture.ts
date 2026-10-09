import { DramaSnapshotSchema } from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import type { AdminLiveFixture, AdminLiveFixtureContext } from "./context.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";

/** Legal input facts only: every file, job, check and ready state comes from the real workflow. */
export async function createOutputBatchLiveFixture({ runtime, make }: AdminLiveFixtureContext) {
  const scope = assertDeliveryLiveEnvironment(runtime.env);
  const staff = await runtime.tx.run(async (tx) => ({
    uploader: await tx.staff.findFirstOrThrow({
      where: { staffRoleKey: "super_admin", status: "active" },
    }),
    manager: await tx.staff.findFirstOrThrow({
      where: { name: "演练交付", staffRoleKey: "delivery_manager", status: "active" },
    }),
  }));
  const merchant = await make.subscribedMerchant();
  await runtime.tx.run((tx) =>
    tx.store.update({
      where: { id: merchant.store.id },
      data: { name: `批次演练-${scope.runId}` },
    }),
  );
  const drama = await make.drama({
    title: `批次演练二十集-${scope.runId}`,
    totalEpisodes: 20,
    createdByStaffId: staff.uploader.id,
  });
  for (let episodeNo = 1; episodeNo <= 20; episodeNo++)
    await make.dramaEpisode({ dramaId: drama.id, episodeNo });
  const order = await make.dramaOrder({
    entityId: merchant.entity.id,
    storeId: merchant.store.id,
    placedByUserId: merchant.user.id,
    subscriptionTermId: merchant.term.id,
    status: "producing",
    subStatus: "batch_compose",
    itemCount: 1,
    totalChargePoints: 100,
  });
  const item = await make.orderItem({
    dramaOrderId: order.id,
    dramaId: drama.id,
    phase: "producing",
    episodeCount: 20,
    dramaSnapshot: DramaSnapshotSchema.parse({
      dramaId: drama.id,
      title: drama.title,
      totalEpisodes: 20,
      dramaClass: drama.dramaClass,
      genreCodes: drama.genreCodes,
      permits: [],
      licenseEndDate: addDays(calendarDate(runtime.clock.now()), 365),
      posterFileId: null,
      allowedPlacements: drama.allowedPlacements,
      isAiGenerated: drama.isAiGenerated,
    }),
  });
  const ticket = await make.deliveryTicket({
    orderItemId: item.id,
    step: "batch_compose",
    editorId: staff.uploader.id,
    deliveryManagerId: staff.manager.id,
  });
  return {
    scope: {
      ...scope,
      startedAt: runtime.clock.now().toISOString(),
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      orderId: order.id,
      itemId: item.id,
      ticketId: ticket.id,
      dramaId: drama.id,
      uploaderId: staff.uploader.id,
    },
    ticketNo: ticket.ticketNo,
  };
}
const fixture: AdminLiveFixture = createOutputBatchLiveFixture;
export default fixture;
