import { createHash } from "node:crypto";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import { snapshotTables } from "../../testing/index.js";
import { nextOpenid, nextPhone, TEST_APPID } from "./harness.js";
import type { Harness } from "./harness.js";
import { openSession } from "../sessions.js";

export const DAY = 86_400_000;
export const DORMANT_TABLES = [
  "merchant_user",
  "wechat_identity",
  "user_session",
  "agreement_consent",
  "entity",
  "entity_member",
  "store",
  "store_member",
  "invitation",
  "portal_session",
  "status_transition",
  "outbox_event",
  "audit_log",
  "auth_event",
];
export const dormantState = (h: Harness) => snapshotTables(h.prisma, DORMANT_TABLES);

/** 合法历史账号/身份，无当前版本同意；新登录须真实写入处置后的签名快照。 */
export async function dormantWorld(h: Harness, role: "clerk" | "owner", verified = false) {
  const phone = nextPhone(),
    openid = nextOpenid(),
    now = h.clock.now();
  const user = await h.make.merchantUser({
    phone,
    displayName: "账号称呼",
    lastActiveAt: new Date(now.getTime() - 181 * DAY),
  });
  const oldIdentity = await h.prisma.wechatIdentity.create({
    data: {
      id: uuidv7(),
      merchantUserId: user.id,
      appid: TEST_APPID,
      openid,
      silentLoginEnabled: true,
      lastLoginAt: now,
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  const oldSession = await h.tx.run((tx) =>
    openSession(tx, now, {
      merchantUserId: user.id,
      wechatIdentityId: oldIdentity.id,
      ip: "203.0.113.10",
      deviceInfo: null,
    }),
  );
  const owner = role === "owner" ? user : await h.make.merchantUser();
  const entity = await h.make.entity({
    createdByUserId: owner.id,
    ...(verified ? { verificationStatus: "verified" } : {}),
  });
  const store = await h.make.store({ entityId: entity.id, isPrimary: true });
  await h.make.billingAccount({ entityId: entity.id });
  const ownerMember = await h.make.entityMember({
    entityId: entity.id,
    merchantUserId: owner.id,
    role: "owner",
    lastStoreId: store.id,
    displayName: "老板关系称呼",
  });
  const member =
    role === "owner"
      ? ownerMember
      : await h.make.entityMember({
          entityId: entity.id,
          merchantUserId: user.id,
          role: "clerk",
          lastStoreId: store.id,
          displayName: "店员关系称呼",
        });
  if (role === "clerk")
    await h.make.storeMember({
      entityId: entity.id,
      entityMemberId: member.id,
      storeId: store.id,
      addedByMemberId: ownerMember.id,
    });
  return {
    phone,
    openid,
    user,
    oldIdentity,
    oldSession,
    entity,
    store,
    member,
    ownerCtx: createIdentityContext({
      actor: { type: "merchant", id: owner.id, client: "weapp" },
      entityId: entity.id,
      storeId: store.id,
    }),
  };
}
export type DormantWorld = Awaited<ReturnType<typeof dormantWorld>>;

export async function portalGrant(h: Harness, w: DormantWorld, userId = w.user.id) {
  const id = uuidv7(),
    now = h.clock.now();
  return h.prisma.portalSession.create({
    data: {
      id,
      tokenHash: createHash("sha256").update(id).digest(),
      portalTicketId: uuidv7(),
      entityId: w.entity.id,
      storeId: w.store.id,
      approvedByUserId: userId,
      grantScope: "store",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
      ip: "203.0.113.11",
      userAgent: "lyxtest dormant grant",
    },
  });
}
