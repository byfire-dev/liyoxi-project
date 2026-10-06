// tenant 管门店与额度；其它模块只经事实端口，未注册即 none / 0 / null（m08 2.4）。
import { ChannelAccountAttentionSchema } from "@liyoxi/contract";
import type { MeOverview } from "@liyoxi/contract";
import { AppError, merchantFactsOf } from "../kernel/index.js";
import type { StoreMembership } from "../tenant/index.js";
import type { IdentityReadDeps } from "./read.types.js";

export async function overview(
  deps: Pick<IdentityReadDeps, "tenant" | "tx" | "clock" | "assembly">,
  input: { merchantUserId: string; membership: StoreMembership },
): Promise<MeOverview> {
  const { membership, merchantUserId } = input;
  const stores = await deps.tenant.listStores({ merchantUserId });
  const card = stores.items.find((store) => store.storeId === membership.storeId);
  if (card === undefined || stores.viewerRole !== membership.role)
    throw new AppError("NOT_A_MEMBER");
  const facts = await deps.tx.run((tx) =>
    merchantFactsOf(deps.assembly).read(
      tx,
      {
        entityId: membership.entityId,
        storeIds: [membership.storeId],
        viewerRole: membership.role,
        merchantUserId,
        now: deps.clock.now(),
      },
      membership.role === "clerk"
        ? ["notify"]
        : ["billing", "order", "publish", "ad", "support", "notify"],
    ),
  );
  const currentStore = {
    storeId: card.storeId,
    name: card.name,
    isPrimary: card.isPrimary,
    lifecycle: card.lifecycle,
    qualificationStatus: card.qualificationStatus,
    city: card.city,
    category: card.category,
    role: membership.role,
    assetCount: card.assetCount,
    clerkCount: card.clerkCount,
  };
  if (stores.viewerRole === "clerk")
    return {
      viewerRole: "clerk",
      currentStore,
      stores: { visibleCount: stores.items.length },
      unreadMessageCount: facts.notify.unreadMessageCount,
    };
  if (stores.viewerRole !== "owner" || !("completenessPct" in card))
    throw new AppError("NOT_A_MEMBER");
  const ownerCard = stores.items.find((store) => store.storeId === membership.storeId)!;
  const wallet = facts.billing.wallet;
  const publish = facts.publish.stores[membership.storeId]!;
  const order = facts.order.stores[membership.storeId]!;
  return {
    viewerRole: "owner",
    currentStore: {
      ...currentStore,
      completenessPct: ownerCard.completenessPct,
      review:
        ownerCard.submittedAt === null
          ? null
          : {
              submittedAt: ownerCard.submittedAt,
              expectedDecisionAt: ownerCard.expectedDecisionAt,
            },
    },
    subscription:
      wallet === null
        ? {
            status: "none",
            isRefundPending: false,
            planName: null,
            endDate: null,
            remainingDays: null,
            spendablePoints: 0,
            planAvailablePoints: 0,
            addonAvailablePoints: 0,
            planPointsExpireAt: null,
            isAddonSuspended: false,
          }
        : { ...wallet, planPointsExpireAt: wallet.planPointsExpireAt?.toISOString() ?? null },
    stores: {
      visibleCount: stores.items.length,
      storeLimit: stores.entity.storeLimit,
      reviewingStores: stores.items
        .filter((store) => store.qualificationStatus === "pending")
        .map((store) => ({ storeId: store.storeId, name: store.name })),
    },
    storeStats: {
      liveCount: order.liveCount,
      deliveringCount: order.deliveringCount,
      cartCount: order.cartCount,
    },
    entries: {
      adPendingConfirmCount: facts.ad.stores[membership.storeId]!.pendingConfirmCount,
      launchTaskTodoCount: publish.launchTaskTodoCount,
      hasLaunchTasks: publish.hasLaunchTasks,
      channelAccountCount: publish.channelAccountCount,
      channelAccountAttention:
        publish.channelAccountAttention === null
          ? null
          : ChannelAccountAttentionSchema.parse(publish.channelAccountAttention),
      ticketAwaitingConfirmCount:
        facts.support.stores[membership.storeId]!.ticketAwaitingConfirmCount,
    },
    unreadMessageCount: facts.notify.unreadMessageCount,
  };
}
