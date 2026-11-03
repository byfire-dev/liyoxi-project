import { z } from "zod";
import type { Runtime } from "../../runtime.js";
import { assertDeliveryLiveEnvironment, DeliveryLiveScopeSchema } from "./delivery-known-media.js";

/** No credentials, arbitrary target IDs or foreign upload authority cross this boundary. */
export const W608LiveScopeSchema = DeliveryLiveScopeSchema.extend({
  dramaId: z.uuid(),
  planId: z.uuid(),
  merchantUserId: z.uuid(),
  memberId: z.uuid(),
  posterFileId: z.uuid(),
  accountIds: z.tuple([z.uuid(), z.uuid()]),
  foreign: z.strictObject({ entityId: z.uuid(), storeId: z.uuid(), accountId: z.uuid() }),
}).superRefine((scope, context) => {
  if (
    scope.name !== `lyx_test_admin_live_${scope.runId}` ||
    scope.prefix !== `lyx:test:admin_live_${scope.runId}:` ||
    scope.uploaderId === scope.managerId ||
    scope.accountIds[0] === scope.accountIds[1] ||
    scope.foreign.entityId === scope.entityId ||
    scope.foreign.storeId === scope.storeId ||
    scope.accountIds.includes(scope.foreign.accountId)
  )
    context.addIssue({ code: "custom", message: "W608 requires one independent owned target" });
});
export type W608LiveScope = z.infer<typeof W608LiveScopeSchema>;
export const parseW608LiveScope = (raw: unknown): W608LiveScope => W608LiveScopeSchema.parse(raw);
export const W608LiveActionSchema = z.enum([
  "upload_sample",
  "finish_sample",
  "confirm_sample",
  "upload_final",
  "finish_final",
  "inspect_package",
  "observe_zip",
  "run_zip",
  "fail_next_zip",
]);
export type W608LiveAction = z.infer<typeof W608LiveActionSchema>;
export const W608LiveCommandSchema = z.strictObject({ action: W608LiveActionSchema });

export async function assertW608LiveScope(runtime: Runtime, raw: unknown) {
  const scope = parseW608LiveScope(raw),
    live = assertDeliveryLiveEnvironment(runtime.env);
  const started = new Date(scope.startedAt);
  if (
    live.runId !== scope.runId ||
    live.name !== scope.name ||
    live.prefix !== scope.prefix ||
    started > runtime.clock.now()
  )
    throw new Error("W608 runtime ownership mismatch");
  await runtime.tx.run(async (tx) => {
    const item = await tx.orderItem.findUniqueOrThrow({
      where: { id: scope.itemId },
      include: {
        drama: true,
        dramaOrder: true,
        deliveryTicket: true,
      },
    });
    const store = await tx.store.findUniqueOrThrow({ where: { id: scope.storeId } });
    const member = await tx.entityMember.findUniqueOrThrow({ where: { id: scope.memberId } });
    const actors = await tx.staff.findMany({
      where: { id: { in: [scope.uploaderId, scope.managerId] } },
    });
    const accounts = await tx.channelAccount.findMany({ where: { id: { in: scope.accountIds } } });
    const foreign = await tx.channelAccount.findUniqueOrThrow({
      where: { id: scope.foreign.accountId },
    });
    const poster = await tx.fileObject.findUniqueOrThrow({ where: { id: scope.posterFileId } });
    const plan = await tx.deliveryPlan.findUniqueOrThrow({ where: { id: scope.planId } });
    if (
      item.dramaId !== scope.dramaId ||
      item.episodeCount !== 2 ||
      item.dramaOrderId !== scope.orderId ||
      item.entityId !== scope.entityId ||
      item.storeId !== scope.storeId ||
      item.createdAt < started ||
      item.drama.title !== `W608发布短剧-${scope.runId}` ||
      item.drama.createdByStaffId !== scope.uploaderId ||
      item.drama.posterFileId !== scope.posterFileId ||
      item.dramaOrder.placedByUserId !== scope.merchantUserId ||
      item.deliveryTicket?.id !== scope.ticketId ||
      item.deliveryTicket.createdAt < started ||
      plan.dramaOrderId !== scope.orderId ||
      plan.entityId !== scope.entityId ||
      plan.storeId !== scope.storeId ||
      store.name !== `W608发布门店-${scope.runId}` ||
      store.entityId !== scope.entityId ||
      member.entityId !== scope.entityId ||
      member.merchantUserId !== scope.merchantUserId ||
      member.role !== "owner" ||
      member.status !== "active" ||
      !actors.some(
        (a) =>
          a.id === scope.uploaderId && a.staffRoleKey === "super_admin" && a.status === "active",
      ) ||
      !actors.some(
        (a) =>
          a.id === scope.managerId &&
          a.name === "演练交付" &&
          a.staffRoleKey === "delivery_manager" &&
          a.status === "active",
      ) ||
      accounts.length !== 2 ||
      accounts.some(
        (a) =>
          a.entityId !== scope.entityId || a.storeId !== scope.storeId || a.createdAt < started,
      ) ||
      accounts.find((a) => a.id === scope.accountIds[0])?.platform !== "douyin" ||
      accounts.find((a) => a.id === scope.accountIds[1])?.platform !== "wechat_channels" ||
      foreign.entityId !== scope.foreign.entityId ||
      foreign.storeId !== scope.foreign.storeId ||
      foreign.createdAt < started ||
      poster.category !== "poster" ||
      poster.bucket !== "pub" ||
      poster.objectKey !== `poster/w608/${scope.runId}.png` ||
      poster.createdAt < started
    )
      throw new Error("W608 actual target does not match the owned manifest");
  });
  return scope;
}
