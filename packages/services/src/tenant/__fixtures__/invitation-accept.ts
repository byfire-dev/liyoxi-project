import { createHash } from "node:crypto";
import type { PrismaClient } from "@liyoxi/db";
import { createConfig } from "../../config/index.js";
import { createDocs } from "../../docs/index.js";
import {
  AppError,
  createIdempotencyContext,
  createTxRunner,
  guardProviderCall,
  uuidv7,
} from "../../kernel/index.js";
import type { TxRunner } from "../../kernel/index.js";
import {
  assertCurrentSessionForTest,
  createIdentityForTest,
  currentSessionOpenidForTest,
  snapshotTables,
  TEST_KEYRING,
} from "../../testing/index.js";
import type { InvitationDeps } from "../index.js";
import { invitationHarness, invitationServices, memberContext, SLOW } from "./invitations.js";

export { memberContext, SLOW };
export const APPID = "wxlyxtest00000001";
const META = {
  requestId: "req_accept_login",
  ip: "203.0.113.28",
  userAgent: "lyxtest-accept",
  clientVersion: null,
};
export const TABLES = [
  "merchant_user",
  "wechat_identity",
  "user_session",
  "agreement_consent",
  "auth_event",
  "entity",
  "entity_member",
  "store",
  "store_member",
  "portal_session",
  "billing_account",
  "billing_order",
  "subscription_term",
  "payment_txn",
  "invitation",
  "invitation_request",
  "timer",
  "audit_log",
  "status_transition",
  "outbox_event",
];
let sequence = 0;

export async function acceptHarness(prisma: PrismaClient) {
  const base = invitationHarness(prisma);
  const { clock, make, wechat } = base;
  const versions = await Promise.all(
    ["user", "privacy"].map(
      async (agreementKey) =>
        (await prisma.agreementVersion.findFirst({ where: { agreementKey, status: "active" } })) ??
        make.agreementVersion({ agreementKey }),
    ),
  );
  function side(
    client = prisma,
    runner?: TxRunner,
    overrides: Partial<InvitationDeps> = {},
    identityAppid = APPID,
  ) {
    const sessionTx = runner ?? createTxRunner({ prisma: client, appEnv: "test" });
    // 组合只经过正式 testing 入口，真实会话与微信身份仍由 identity 拥有者校验。
    const service = invitationServices(client, clock, sessionTx, {
      accept: {
        assertSession: (tx, principal, now) =>
          assertCurrentSessionForTest(tx, principal, now, APPID),
        async checkName(principal, content) {
          const openid = await sessionTx.run((tx) =>
            currentSessionOpenidForTest(tx, principal, APPID),
          );
          guardProviderCall({ provider: "wechat", method: "checkText" });
          const result = await wechat.checkText({ openid, scene: "profile", content });
          if (!result.ok) throw new AppError("PROVIDER_UNAVAILABLE");
          if (result.value.verdict !== "pass")
            throw new AppError("CONTENT_REJECTED", { details: { fields: ["displayName"] } });
        },
      },
      ...overrides,
    });
    const identity = createIdentityForTest({
      ...service,
      docs: createDocs({ tx: service.tx, clock }),
      config: createConfig({ db: client, clock, redis: null }),
      keyring: () => TEST_KEYRING,
      wechat,
      appid: identityAppid,
    });
    return { ...service, identity, wechat };
  }
  const service = side();
  async function person(displayName: string | null = "新店员", appid = APPID) {
    const identity =
      appid === APPID ? service.identity : side(prisma, undefined, {}, appid).identity;
    const n = ++sequence,
      phone = `139${String(91_000_000 + n).padStart(8, "0")}`;
    const openid = `lyxtest_accept_${n}`,
      loginCode = `accept-login-${n}`,
      phoneCode = `accept-phone-${n}`;
    wechat.sessions.set(loginCode, { openid });
    wechat.phones.set(phoneCode, phone);
    const result = await identity.phoneLogin(META, {
      loginCode,
      phoneCode,
      consents: versions.map((version) => ({
        agreementKey: version.agreementKey,
        agreementVersionId: version.id,
      })),
    });
    const checked = await identity.authenticate(result.token, { ip: META.ip });
    if (!checked.ok) throw new Error("真实登录没有形成有效会话");
    // 显示名是合法既有账号事实，不代替接受邀请的检测/写入路径。
    if (displayName !== null)
      await prisma.merchantUser.update({
        where: { id: checked.principal.merchantUserId },
        data: { displayName },
      });
    return {
      userId: checked.principal.merchantUserId,
      principal: checked.principal,
      ctx: memberContext(checked.principal.merchantUserId),
      token: result.token,
      phone,
      openid,
    };
  }
  async function owner() {
    const user = await person("门店老板");
    const created = await service.tenant.createEntity(user.ctx);
    return {
      ...user,
      ...created,
      ctx: memberContext(user.userId, created.entityId, created.storeId),
    };
  }
  async function clerk(parent: Awaited<ReturnType<typeof owner>>, stores = [parent.storeId]) {
    const user = await person();
    // 只有已有成员前史用工厂；本片每个新接受都调用真实 public usecase。
    const member = await make.entityMember({
      entityId: parent.entityId,
      merchantUserId: user.userId,
      role: "clerk",
      lastStoreId: stores[0] ?? null,
      invitedByMemberId: parent.memberId,
    });
    for (const storeId of stores)
      await make.storeMember({
        entityId: parent.entityId,
        entityMemberId: member.id,
        storeId,
        addedByMemberId: parent.memberId,
      });
    return {
      ...user,
      memberId: member.id,
      entityId: parent.entityId,
      storeId: stores[0] ?? parent.storeId,
      ctx: memberContext(user.userId, parent.entityId, stores[0] ?? parent.storeId),
    };
  }
  async function card(parent: Awaited<ReturnType<typeof owner>>, targetPhone?: string) {
    return service.tenant.createInvitation(
      parent.ctx,
      { clientRequestId: uuidv7(), ...(targetPhone === undefined ? {} : { targetPhone }) },
      { principal: parent.principal },
    );
  }
  async function accept(
    user: Awaited<ReturnType<typeof person>>,
    invitation: { invitationId: string; token: string },
    input: { displayName?: string | null } = {},
    on = service,
    key = uuidv7(),
  ) {
    const body = { token: invitation.token, ...input };
    return on.tenant.acceptInvitation(
      user.ctx,
      { invitationId: invitation.invitationId, ...body },
      {
        principal: user.principal,
        idem: createIdempotencyContext({
          mode: "required",
          scope: "m.invitation.accept",
          actor: user.ctx.actor,
          key,
          request: {
            method: "POST",
            pathParams: { invitationId: invitation.invitationId },
            body,
            storeId: null,
          },
        }),
      },
    );
  }
  async function portal(
    parent: Awaited<ReturnType<typeof owner>>,
    approvedByUserId = parent.userId,
  ) {
    const id = uuidv7();
    return prisma.portalSession.create({
      data: {
        id,
        tokenHash: createHash("sha256").update(id).digest(),
        portalTicketId: uuidv7(),
        entityId: parent.entityId,
        storeId: parent.storeId,
        approvedByUserId,
        grantScope: "store",
        createdAt: clock.now(),
        updatedAt: clock.now(),
        expiresAt: new Date(clock.now().getTime() + 3_600_000),
        ip: META.ip,
        userAgent: META.userAgent,
      },
    });
  }
  return {
    ...base,
    ...service,
    person,
    owner,
    clerk,
    card,
    accept,
    side,
    portal,
    // required 三段式的未知失败可保留技术占用；业务回滚与技术记录分别完整断言。
    state: () => snapshotTables(prisma, TABLES),
    idemState: () => snapshotTables(prisma, ["idempotency_record"]),
  };
}
export type AcceptHarness = Awaited<ReturnType<typeof acceptHarness>>;
export type Person = Awaited<ReturnType<AcceptHarness["person"]>>;
export type Owner = Awaited<ReturnType<AcceptHarness["owner"]>>;
