// W2-17 真实库的虚构通知/会话数据，仅测试入口；不安装 producer，不执行外部发送。
import type { Prisma } from "@liyoxi/db";
import type { MessageDeepLinkSchema, z } from "@liyoxi/contract";
import { uuidv7 } from "../kernel/index.js";
import type { Clock } from "../kernel/index.js";
import type { FactoryDb } from "./data/index.js";

export async function createNotifyMessageFixture(
  db: FactoryDb,
  clock: Clock,
  input: {
    merchantUserId: string;
    entityId?: string | null;
    storeId?: string | null;
    isOwnerOnly?: boolean;
    category?: string;
    id?: string;
    readAt?: Date | null;
    link?: z.infer<typeof MessageDeepLinkSchema>;
  },
) {
  const now = clock.now();
  const entityId = input.entityId ?? null;
  const storeId = input.storeId ?? null;
  const notification = await db.notification.create({
    data: {
      id: uuidv7(),
      notifySceneKey: "m.member_changed",
      dedupeKey: `fixture:${uuidv7()}`,
      node: "N0",
      merchantUserId: input.merchantUserId,
      entityId,
      storeId,
      vars: {},
      copyMode: entityId === null ? null : "in_app",
      createdAt: now,
    },
  });
  return db.merchantMessage.create({
    data: {
      id: input.id ?? uuidv7(),
      notificationId: notification.id,
      merchantUserId: input.merchantUserId,
      entityId,
      storeId,
      isOwnerOnly: input.isOwnerOnly ?? false,
      category: input.category ?? "store",
      title: "虚构门店消息",
      body: "测试环境的虚构通知正文",
      ctaText: "查看",
      link: input.link ?? { route: "messages.list", params: {} },
      readAt: input.readAt ?? null,
      createdAt: now,
      updatedAt: now,
    },
  });
}

export async function createNotifySessionFixture(
  db: FactoryDb,
  clock: Clock,
  merchantUserId: string,
) {
  const now = clock.now();
  const identity = await db.wechatIdentity.create({
    data: {
      id: uuidv7(),
      merchantUserId,
      appid: "fictional-w217",
      openid: `fictional:${uuidv7()}`,
      silentLoginEnabled: true,
      lastLoginAt: now,
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  const session = await db.userSession.create({
    data: {
      id: uuidv7(),
      merchantUserId,
      wechatIdentityId: identity.id,
      tokenHash: new Uint8Array(32),
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      lastIp: "192.0.2.17",
      idleExpiresAt: new Date(now.getTime() + 30 * 86_400_000),
      absoluteExpiresAt: new Date(now.getTime() + 90 * 86_400_000),
    },
  });
  return { identity, session };
}

export async function createNotifyQuotaFixture(
  db: FactoryDb,
  clock: Clock,
  input: {
    merchantUserId: string;
    wechatIdentityId: string;
    slotKey: string;
    state?: string;
    remaining?: number;
    lastAcceptAt?: Date | null;
  },
) {
  return db.wxSubscribeQuota.create({
    data: {
      merchantUserId: input.merchantUserId,
      wechatIdentityId: input.wechatIdentityId,
      wxTemplateSlotKey: input.slotKey,
      state: input.state ?? "ok",
      estRemaining: input.remaining ?? 0,
      lastAcceptAt: input.lastAcceptAt ?? null,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
  });
}

export async function updateNotifySlotFixture(
  db: FactoryDb,
  slotKey: string,
  data: Prisma.WxTemplateSlotUpdateInput,
) {
  return db.wxTemplateSlot.update({ where: { slotKey }, data });
}
