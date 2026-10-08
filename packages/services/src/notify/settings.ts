import { NotifySettingListResultSchema } from "@liyoxi/contract";
import type { NotifySettingListResult } from "@liyoxi/contract";
import { paramsAt } from "../config/index.js";
import type { Config } from "../config/index.js";
import { AppError, isUuid } from "../kernel/index.js";
import type { MessageActor } from "./messages.scope.js";
import { messageScope } from "./messages.scope.js";
import type { Clock, Tx, TxRunner } from "../kernel/index.js";
import { WX_TEMPLATE_SLOT_SEEDS } from "./seed-data.js";

export interface NotifyMessagesDeps {
  tx: TxRunner;
  clock: Clock;
  config: Config;
  purchaseMode(
    tx: Tx,
    entityId: string,
    at: Date,
  ): Promise<"in_app" | "offline_contract" | "hidden">;
}

export interface NotifySettingActor extends MessageActor {
  sessionId: string;
  wechatIdentityId: string | null;
}

/** 只读设置。额度限定当前会话身份，不遍历本账号其他 openid；未配置不造可请求模板。 */
export function createNotifySettings(
  deps: NotifyMessagesDeps,
): (actor: NotifySettingActor) => Promise<NotifySettingListResult> {
  return (actor) =>
    deps.tx.run(async (tx) => {
      const now = deps.clock.now();
      if (
        !isUuid(actor.sessionId) ||
        !isUuid(actor.merchantUserId) ||
        (actor.wechatIdentityId !== null && !isUuid(actor.wechatIdentityId))
      )
        throw new AppError("SESSION_INVALID");
      const session = await tx.userSession.findFirst({
        where: {
          id: actor.sessionId,
          merchantUserId: actor.merchantUserId,
          revokedAt: null,
          merchantUser: { status: "active" },
          idleExpiresAt: { gt: now },
          absoluteExpiresAt: { gt: now },
        },
        select: { wechatIdentityId: true },
      });
      if (!session || session.wechatIdentityId !== actor.wechatIdentityId)
        throw new AppError("SESSION_INVALID");
      let entityId: string | null = null;
      // 设置接口没有强制门店上下文；无效/已退出的门店按账号级设置返回。
      if (actor.storeId !== null && isUuid(actor.storeId)) {
        try {
          entityId = (await messageScope(tx, actor, false)).entityId;
        } catch (error) {
          if (!(error instanceof AppError) || error.error !== "NOT_A_MEMBER") throw error;
        }
      }
      const enabled = await deps.config.flags.isEnabled("notify.wx.enabled", {
        ...(entityId === null ? {} : { entityId }),
      });
      const mode = entityId === null ? "in_app" : await deps.purchaseMode(tx, entityId, now);
      const values = await paramsAt(
        tx,
        ["notify.wx.ask_cooldown_days", "notify.wx.max_per_ask"],
        now,
      );
      const slots = await tx.wxTemplateSlot.findMany({
        select: { slotKey: true, title: true, status: true, providerTemplateId: true },
      });
      const scenes = await tx.notifyScene.findMany({
        where: {
          audience: "merchant",
          sceneEnabled: true,
          extEnabled: true,
          wxTemplateSlotKey: { not: null },
        },
        orderBy: { sceneKey: "asc" },
        select: { name: true, wxTemplateSlotKey: true },
      });
      const quotas =
        actor.wechatIdentityId === null
          ? []
          : await tx.wxSubscribeQuota.findMany({
              where: {
                wechatIdentityId: actor.wechatIdentityId,
                merchantUserId: actor.merchantUserId,
                merchantUser: { status: "active" },
                wechatIdentity: {
                  merchantUserId: actor.merchantUserId,
                  userSessions: {
                    some: {
                      id: actor.sessionId,
                      merchantUserId: actor.merchantUserId,
                      revokedAt: null,
                      idleExpiresAt: { gt: now },
                      absoluteExpiresAt: { gt: now },
                    },
                  },
                },
              },
              select: {
                wxTemplateSlotKey: true,
                state: true,
                estRemaining: true,
                lastAcceptAt: true,
              },
            });
      const items = WX_TEMPLATE_SLOT_SEEDS.filter(
        ({ slotKey }) =>
          mode !== "hidden" || (slotKey !== "svc_expiry" && slotKey !== "quota_change"),
      ).map((seed) => {
        const slot = slots.find((row) => row.slotKey === seed.slotKey);
        const quota = quotas.find((row) => row.wxTemplateSlotKey === seed.slotKey);
        const available = enabled && slot?.status === "active" && slot.providerTemplateId !== null;
        return {
          slotKey: seed.slotKey,
          title: slot?.title ?? seed.title,
          sceneNames: scenes
            .filter((scene) => scene.wxTemplateSlotKey === seed.slotKey)
            .map((scene) => scene.name),
          tmplId: available ? slot.providerTemplateId : null,
          state: !available
            ? "unavailable"
            : quota?.state === "banned"
              ? "banned"
              : quota?.state === "rejected"
                ? "rejected"
                : (quota?.estRemaining ?? 0) > 0
                  ? "on"
                  : "off",
          estRemaining: quota?.estRemaining ?? 0,
          lastAcceptAt: quota?.lastAcceptAt?.toISOString() ?? null,
        };
      });
      return NotifySettingListResultSchema.parse({
        items,
        cooldownDays: values["notify.wx.ask_cooldown_days"],
        maxPerAsk: values["notify.wx.max_per_ask"],
      });
    });
}
