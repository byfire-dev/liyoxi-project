import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createIdentityContext, createTxRunner, lockRows, uuidv7 } from "../kernel/index.js";
import {
  assertSnapshotsEqual,
  currentSessionOpenidForTest,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";
import { acceptHarness, APPID, memberContext, SLOW } from "./__fixtures__/invitation-accept.js";
import type { AcceptHarness } from "./__fixtures__/invitation-accept.js";
import { invitationServices } from "./__fixtures__/invitations.js";
import { membershipAuthorizationsPort } from "./index.js";
import { encryptField } from "../security/index.js";

const db = useSeededDatabase("services");
let h: AcceptHarness;
beforeAll(async () => {
  h = await acceptHarness(await db.prisma());
}, SLOW);
afterEach(() => {
  vi.restoreAllMocks();
  h.wechat.setTextCheckAvailable(true);
});
const user = (id: string) => h.prisma.merchantUser.findUniqueOrThrow({ where: { id } });
const membership = (id: string) => h.prisma.entityMember.findUniqueOrThrow({ where: { id } });

describe("接受邀请：真实登录、当前成员与原事务副作用", { timeout: SLOW }, () => {
  it("定向手机号取真实登录账号盲索引，私有幂等收据不存 token 或称呼", async () => {
    const owner = await h.owner(),
      person = await h.person(null),
      card = await h.card(owner, person.phone),
      key = uuidv7();
    const result = await h.accept(person, card, { displayName: "到店帮忙" }, h, key);
    expect(result.role).toBe("clerk");
    const record = await h.prisma.idempotencyRecord.findUniqueOrThrow({
      where: {
        scope_actorKey_key: {
          scope: "m.invitation.accept",
          actorKey: `merchant:${person.userId}`,
          key,
        },
      },
    });
    expect(record.state).toBe("done");
    expect(record.result).toEqual({
      invitationId: card.invitationId,
      merchantUserId: person.userId,
      memberId: result.memberId,
      abandonedEntityId: null,
      isNew: true,
      nonce: expect.any(String),
    });
    expect(JSON.stringify(record.result)).not.toContain(card.token);
    expect(JSON.stringify(record.result)).not.toContain("到店帮忙");
  });
  it("无成员账号加入店员，原会话/微信/协议不变，迁移和取消 timer 各一次", async () => {
    const owner = await h.owner(),
      person = await h.person(),
      card = await h.card(owner);
    const consentCount = await h.prisma.agreementConsent.count();
    const session = await h.prisma.userSession.findUniqueOrThrow({
      where: { id: person.principal.sessionId },
    });
    const wechat = await h.prisma.wechatIdentity.findUniqueOrThrow({
      where: { id: person.principal.wechatIdentityId },
    });
    const quota = await h.tx.run((tx) => h.tenant.getQuotaUsage(tx, owner.entityId));
    const result = await h.accept(person, card);
    expect(result).toEqual({
      entityId: owner.entityId,
      storeId: owner.storeId,
      memberId: expect.any(String),
      role: "clerk",
      isNew: true,
      abandonedEntityId: null,
    });
    const member = await membership(result.memberId),
      trace = await h.trace(card.invitationId);
    expect(member).toMatchObject({
      status: "active",
      role: "clerk",
      merchantUserId: person.userId,
      invitationId: card.invitationId,
      invitedByMemberId: owner.memberId,
      lastStoreId: owner.storeId,
      displayName: "新店员",
    });
    expect(
      await h.prisma.storeMember.findMany({ where: { entityMemberId: member.id } }),
    ).toHaveLength(1);
    expect(trace.row).toMatchObject({
      status: "accepted",
      acceptedByUserId: person.userId,
      acceptedMemberId: member.id,
      tokenEnc: null,
      acceptedAt: h.clock.now(),
    });
    expect(trace.history.map((row) => row.event)).toEqual([
      "invitation.create",
      "invitation.accept",
    ]);
    expect(trace.audits).toHaveLength(2);
    expect(trace.events.map((row) => row.eventType)).toEqual([
      "invitation.created",
      "invitation.accepted",
    ]);
    expect(trace.timers).toHaveLength(1);
    expect(trace.timers[0]?.status).toBe("cancelled");
    expect(
      await h.prisma.statusTransition.count({
        where: { subjectId: member.id, event: "entity_member.join" },
      }),
    ).toBe(1);
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: member.id, eventType: "entity_member.joined" },
      }),
    ).toBe(1);
    expect(await h.prisma.userSession.findUnique({ where: { id: session.id } })).toEqual(session);
    expect(await h.prisma.wechatIdentity.findUnique({ where: { id: wechat.id } })).toEqual(wechat);
    expect(await h.prisma.agreementConsent.count()).toBe(consentCount);
    const afterQuota = await h.tx.run((tx) => h.tenant.getQuotaUsage(tx, owner.entityId));
    expect(afterQuota.seatsUsed).toBe(quota.seatsUsed);
    expect(afterQuota.pendingInvitationCount).toBe(quota.pendingInvitationCount - 1);
  });

  it.each([false, true])("同主体已有店员范围 added=%s：不新增成员或重复加入事件", async (added) => {
    const owner = await h.owner(),
      store = await h.make.store({ entityId: owner.entityId });
    const person = await h.clerk(owner),
      scoped = {
        ...owner,
        storeId: store.id,
        ctx: memberContext(owner.userId, owner.entityId, store.id),
      };
    const card = await h.card(added ? scoped : owner);
    const result = await h.accept(person, card);
    expect(result).toMatchObject({
      memberId: person.memberId,
      isNew: false,
      abandonedEntityId: null,
    });
    expect(await h.prisma.entityMember.count({ where: { merchantUserId: person.userId } })).toBe(1);
    expect(await h.prisma.storeMember.count({ where: { entityMemberId: person.memberId } })).toBe(
      added ? 2 : 1,
    );
    expect(await h.prisma.statusTransition.count({ where: { subjectId: person.memberId } })).toBe(
      0,
    );
    const events = await h.prisma.outboxEvent.findMany({ where: { aggregateId: person.memberId } });
    expect(events).toHaveLength(added ? 1 : 0);
    if (added)
      expect(events[0]?.payload).toEqual({
        v: 1,
        entityMemberId: person.memberId,
        entityId: owner.entityId,
        merchantUserId: person.userId,
        addedStoreIds: [store.id],
        removedStoreIds: [],
        invitationId: card.invitationId,
      });
  });

  it.each(["same", "new"] as const)(
    "%s 幂等键重放现算成员，不再次检测称呼或写业务事实",
    async (mode) => {
      const owner = await h.owner(),
        person = await h.person(null),
        card = await h.card(owner),
        key = uuidv7();
      const first = await h.accept(person, card, { displayName: "第一次称呼" }, h, key);
      const before = await h.state(),
        idemBefore = await h.prisma.idempotencyRecord.count(),
        check = vi.spyOn(h.wechat, "checkText");
      const replay = await h.accept(
        person,
        card,
        { displayName: mode === "same" ? "第一次称呼" : "新的输入" },
        h,
        mode === "same" ? key : uuidv7(),
      );
      expect(replay).toMatchObject({
        entityId: first.entityId,
        storeId: first.storeId,
        memberId: first.memberId,
        role: "clerk",
      });
      expect(check).not.toHaveBeenCalled();
      const after = await h.state();
      assertSnapshotsEqual(before, after, { ignore: [] });
      expect(await h.prisma.idempotencyRecord.count()).toBe(idemBefore + (mode === "new" ? 1 : 0));
      expect((await user(person.userId)).displayName).toBe("第一次称呼");
    },
  );

  it.each(["removed", "archived"] as const)("完成后 %s，同键与新键都不复活旧成员", async (mode) => {
    const owner = await h.owner(),
      person = await h.person(),
      card = await h.card(owner),
      key = uuidv7();
    const result = await h.accept(person, card, {}, h, key);
    if (mode === "removed") await h.tenant.removeMember(owner.ctx, { memberId: result.memberId });
    else
      await h.prisma.store.update({
        where: { id: owner.storeId },
        data: {
          lifecycle: "archived",
          archivedAt: h.clock.now(),
          archiveActorType: "merchant",
          archiveActorId: owner.userId,
          archiveClient: "weapp",
          archiveReason: "by_owner",
        },
      });
    const before = await h.state();
    for (const replayKey of [key, uuidv7()])
      await expect(h.accept(person, card, {}, h, replayKey)).rejects.toMatchObject({
        error: mode === "removed" ? "NOT_A_MEMBER" : "STORE_ARCHIVED",
      });
    assertSnapshotsEqual(before, await h.state());
  });

  it("不同账号不能重用已接受邀请，也不写其账号/会话/同意事实", async () => {
    const owner = await h.owner(),
      a = await h.person(),
      b = await h.person(),
      card = await h.card(owner);
    await h.accept(a, card);
    const before = await h.state();
    await expect(h.accept(b, card)).rejects.toMatchObject({ error: "INVITATION_USED" });
    assertSnapshotsEqual(before, await h.state());
  });

  it("新称呼按实际当前 openid 在 PG 外检测，账号原名保留、成员用新名", async () => {
    const owner = await h.owner(),
      person = await h.person("账号原名"),
      card = await h.card(owner);
    const check = vi.spyOn(h.wechat, "checkText");
    const result = await h.accept(person, card, { displayName: `  ${"😀".repeat(20)}  ` });
    expect(check).toHaveBeenCalledExactlyOnceWith({
      openid: person.openid,
      scene: "profile",
      content: "😀".repeat(20),
    });
    expect((await membership(result.memberId)).displayName).toBe("😀".repeat(20));
    expect((await user(person.userId)).displayName).toBe("账号原名");
    expect(await h.tx.run((tx) => currentSessionOpenidForTest(tx, person.principal, APPID))).toBe(
      person.openid,
    );
  });

  it.each([undefined, null, "", "   ", "😀".repeat(21)])(
    "无账号名时非法称呼 %s 不写加入事实",
    async (displayName) => {
      const owner = await h.owner(),
        person = await h.person(null),
        card = await h.card(owner),
        before = await h.state();
      await expect(
        h.accept(person, card, displayName === undefined ? {} : { displayName }),
      ).rejects.toMatchObject({
        error: "VALIDATION_FAILED",
        details: {
          fieldErrors: expect.arrayContaining([expect.objectContaining({ path: "displayName" })]),
        },
      });
      assertSnapshotsEqual(before, await h.state());
    },
  );

  it.each(["reject", "unavailable"] as const)("内容检测 %s 不写账号名/成员/邀请", async (mode) => {
    const owner = await h.owner(),
      person = await h.person(null),
      card = await h.card(owner),
      before = await h.state();
    if (mode === "reject") h.wechat.textVerdicts.push("block");
    else h.wechat.setTextCheckAvailable(false);
    await expect(h.accept(person, card, { displayName: "新称呼" })).rejects.toMatchObject({
      error: mode === "reject" ? "CONTENT_REJECTED" : "PROVIDER_UNAVAILABLE",
    });
    assertSnapshotsEqual(before, await h.state());
  });

  it.each([
    "token",
    "missing",
    "phone",
    "revoked",
    "expired",
    "elapsed",
    "inactive",
    "store",
    "inviter",
  ] as const)("目标 %s 拒绝且零业务写入", async (mode) => {
    const owner = await h.owner(),
      person = await h.person(),
      card = await h.card(owner, mode === "phone" ? "13800000001" : undefined);
    if (mode === "revoked")
      await h.tenant.revokeInvitation(owner.ctx, {
        invitationId: card.invitationId,
        reason: "by_owner",
      });
    if (mode === "elapsed" || mode === "expired") h.clock.set(new Date(card.expiresAt));
    if (mode === "expired") await h.run(card.invitationId);
    if (mode === "inactive")
      await h.prisma.entity.update({
        where: { id: owner.entityId },
        data: { lifecycle: "abandoned", closedAt: h.clock.now() },
      });
    if (mode === "store")
      await h.prisma.store.update({
        where: { id: owner.storeId },
        data: {
          lifecycle: "archived",
          archivedAt: h.clock.now(),
          archiveActorType: "merchant",
          archiveActorId: owner.userId,
          archiveClient: "weapp",
          archiveReason: "by_owner",
        },
      });
    if (mode === "inviter")
      await h.prisma.merchantUser.update({
        where: { id: owner.userId },
        data: { status: "disabled" },
      });
    const before = await h.state(),
      codes = {
        token: "INVITATION_INVALID",
        missing: "INVITATION_INVALID",
        phone: "INVITATION_NOT_FOR_YOU",
        revoked: "INVITATION_REVOKED",
        expired: "INVITATION_EXPIRED",
        elapsed: "INVITATION_EXPIRED",
        inactive: "INVITATION_REVOKED",
        store: "INVITATION_REVOKED",
        inviter: "INVITATION_REVOKED",
      };
    await expect(
      h.accept(person, {
        ...card,
        ...(mode === "token" ? { token: "a".repeat(43) } : {}),
        ...(mode === "missing" ? { invitationId: uuidv7() } : {}),
      }),
    ).rejects.toMatchObject({ error: codes[mode] });
    assertSnapshotsEqual(before, await h.state());
  });

  it.each(["revoked", "appid", "disabled", "foreign"] as const)(
    "真实会话 %s 在 claim 被拒绝",
    async (mode) => {
      const owner = await h.owner(),
        person = await h.person(),
        card = await h.card(owner);
      if (mode === "revoked")
        await h.identity.logout(person.principal, {
          requestId: uuidv7(),
          ip: null,
          userAgent: null,
        });
      if (mode === "appid")
        await h.prisma.wechatIdentity.update({
          where: { id: person.principal.wechatIdentityId },
          data: { appid: "wxlyxtest00000002" },
        });
      if (mode === "disabled")
        await h.prisma.merchantUser.update({
          where: { id: person.userId },
          data: { status: "disabled" },
        });
      if (mode === "foreign")
        person.principal = { ...person.principal, sessionId: owner.principal.sessionId };
      const before = await h.state();
      await expect(h.accept(person, card)).rejects.toMatchObject({ error: "SESSION_INVALID" });
      assertSnapshotsEqual(before, await h.state());
    },
  );

  it("同主体老板被拒；其他主体店员报告实际 currentRole", async () => {
    const owner = await h.owner(),
      other = await h.owner(),
      clerk = await h.clerk(other),
      card = await h.card(owner);
    const before = await h.state();
    await expect(h.accept(owner, card)).rejects.toMatchObject({ error: "ALREADY_OWNER" });
    await expect(h.accept(clerk, card)).rejects.toMatchObject({
      error: "PHONE_IN_OTHER_ENTITY",
      details: { currentRole: "clerk" },
    });
    assertSnapshotsEqual(before, await h.state());
  });
});

describe("空草稿让位：严格四项真实历史与私有权限", { timeout: SLOW }, () => {
  it("其他历史邀请人的 DB pending 也使草稿不空，不按当前 inviter 过滤", async () => {
    const old = await h.owner(),
      target = await h.owner(),
      card = await h.card(target),
      own = await h.card(old);
    const original = (await h.trace(own.invitationId)).row;
    await h.tenant.revokeInvitation(old.ctx, {
      invitationId: own.invitationId,
      reason: "by_owner",
    });
    const former = await h.make.entityMember({
      entityId: old.entityId,
      role: "owner",
      status: "removed",
      removedAt: h.clock.now(),
      removeReason: "owner_transfer",
      removeActorType: "system",
    });
    // 已完成转交前的另一邀请人历史，满足原复合外键/唯一/CHECK，不声称执行新 producer。
    const id = uuidv7(),
      clientRequestId = uuidv7(),
      token = randomBytes(32).toString("base64url");
    await h.prisma.invitation.create({
      data: {
        ...original,
        id,
        inviterMemberId: former.id,
        clientRequestId,
        tokenHash: createHash("sha256").update(token).digest(),
        tokenEnc: encryptField(TEST_KEYRING, "invitation.token_enc", token),
      },
    });
    await h.prisma.invitationRequest.create({
      data: {
        id: uuidv7(),
        invitationId: id,
        inviterMemberId: former.id,
        entityId: old.entityId,
        storeId: old.storeId,
        clientRequestId,
        createdAt: h.clock.now(),
      },
    });
    const before = await h.state();
    await expect(h.accept(old, card)).rejects.toMatchObject({
      error: "PHONE_IN_OTHER_ENTITY",
      details: { currentRole: "owner" },
    });
    assertSnapshotsEqual(before, await h.state());
  });
  it("接受本人后来合法升为老板，旧键返回当前角色且零旁写", async () => {
    const owner = await h.owner(),
      person = await h.person(),
      card = await h.card(owner),
      key = uuidv7();
    const accepted = await h.accept(person, card, {}, h, key);
    // 当前尚无转交 producer；只构造符合唯一/归属/CHECK 的已完成转交历史。
    await h.tx.run(async (tx) => {
      await lockRows(tx, "entity", [owner.entityId]);
      await lockRows(tx, "entity_member", [owner.memberId, accepted.memberId].sort());
      await tx.entityMember.update({
        where: { id: owner.memberId },
        data: {
          status: "removed",
          removedAt: h.clock.now(),
          removeReason: "owner_transfer",
          removeActorType: "merchant",
          removeActorId: owner.userId,
          removeClient: "weapp",
          lastStoreId: null,
        },
      });
      await tx.entityMember.update({ where: { id: accepted.memberId }, data: { role: "owner" } });
    });
    const before = await h.state(),
      idemBefore = await h.idemState();
    expect(await h.accept(person, card, {}, h, key)).toMatchObject({
      memberId: accepted.memberId,
      role: "owner",
      entityId: owner.entityId,
    });
    assertSnapshotsEqual(before, await h.state());
    assertSnapshotsEqual(idemBefore, await h.idemState());
  });

  it("真正空草稿让位，全部活跃店归档、老板移除和精准 portal 吊销同事务", async () => {
    const old = await h.owner(),
      target = await h.owner(),
      extra = await h.make.store({ entityId: old.entityId });
    const archived = await h.make.store({
      entityId: old.entityId,
      lifecycle: "archived",
      archivedAt: h.clock.now(),
      archiveActorType: "merchant",
      archiveActorId: old.userId,
      archiveClient: "weapp",
      archiveReason: "by_owner",
    });
    const grant = await h.portal(old),
      unrelated = await h.portal(target),
      card = await h.card(target);
    const beforeArchived = await h.prisma.store.findUnique({ where: { id: archived.id } });
    const login = await h.prisma.userSession.findUnique({ where: { id: old.principal.sessionId } });
    const result = await h.accept(old, card);
    expect(result).toMatchObject({
      entityId: target.entityId,
      role: "clerk",
      abandonedEntityId: old.entityId,
      isNew: true,
    });
    expect(
      (await h.prisma.entity.findUniqueOrThrow({ where: { id: old.entityId } })).lifecycle,
    ).toBe("abandoned");
    expect(await membership(old.memberId)).toMatchObject({
      status: "removed",
      removeReason: "draft_abandoned",
      removeActorType: "system",
      lastStoreId: null,
      removedAt: h.clock.now(),
    });
    for (const id of [old.storeId, extra.id])
      expect(await h.prisma.store.findUnique({ where: { id } })).toMatchObject({
        lifecycle: "archived",
        archiveReason: "entity_abandoned",
        archiveActorType: "system",
      });
    expect(await h.prisma.store.findUnique({ where: { id: archived.id } })).toEqual(beforeArchived);
    expect(await h.prisma.storeMember.count({ where: { entityId: old.entityId } })).toBe(0);
    expect(await h.prisma.portalSession.findUnique({ where: { id: grant.id } })).toMatchObject({
      revokedAt: h.clock.now(),
      revokeReason: "membership_changed",
    });
    expect(await h.prisma.portalSession.findUnique({ where: { id: unrelated.id } })).toEqual(
      unrelated,
    );
    expect(
      await h.prisma.userSession.findUnique({ where: { id: old.principal.sessionId } }),
    ).toEqual(login);
    const events = await h.prisma.outboxEvent.findMany({ where: { entityId: old.entityId } });
    expect(events.filter((event) => event.eventType === "entity.abandoned")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "entity_member.removed")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "store.archived")).toHaveLength(2);
  });

  it.each([
    "verification",
    "inactive",
    "member",
    "order_pending",
    "order_cancelled",
    "order_refunded",
    "term_cancelled",
    "term_ended",
    "pending",
    "elapsed",
    "shared",
    "other_store",
  ] as const)("%s 实际历史使草稿不空，拒绝且整笔无变化", async (mode) => {
    const old = await h.owner(),
      target = await h.owner(),
      card = await h.card(target);
    if (mode === "verification")
      await h.prisma.entity.update({
        where: { id: old.entityId },
        data: { verificationStatus: "pending" },
      });
    if (mode === "inactive")
      await h.prisma.entity.update({
        where: { id: old.entityId },
        data: { lifecycle: "abandoned", closedAt: h.clock.now() },
      });
    if (mode === "member") await h.clerk(old);
    if (mode.startsWith("order_"))
      await h.make.billingOrder({
        entityId: old.entityId,
        status:
          mode === "order_pending"
            ? "pending_payment"
            : mode === "order_cancelled"
              ? "cancelled"
              : "refunded",
        amountFen: 0,
      });
    if (mode.startsWith("term_"))
      await h.make.subscriptionTerm({
        entityId: old.entityId,
        status: mode === "term_cancelled" ? "cancelled" : "ended",
      });
    if (["pending", "elapsed", "shared", "other_store"].includes(mode)) {
      const source =
        mode === "other_store"
          ? { ...old, storeId: (await h.make.store({ entityId: old.entityId })).id }
          : old;
      const own = await h.card({
        ...source,
        ctx: memberContext(old.userId, old.entityId, source.storeId),
      });
      if (mode === "shared")
        await h.tenant.markInvitationShared(old.ctx, { invitationId: own.invitationId });
      if (mode === "elapsed") {
        await h.prisma.invitation.update({
          where: { id: own.invitationId },
          data: { expiresAt: new Date(h.clock.now().getTime() + 1) },
        });
        h.clock.advance(2);
      }
    }
    const before = await h.state();
    await expect(h.accept(old, card)).rejects.toMatchObject({
      error: "PHONE_IN_OTHER_ENTITY",
      details: { currentRole: "owner" },
    });
    assertSnapshotsEqual(before, await h.state());
  });

  it.each(["event", "timer", "portal", "outer"] as const)(
    "真实 %s 后失败回滚让位、加入、邀请及 portal 全部事实",
    async (point) => {
      const old = await h.owner(),
        target = await h.owner(),
        card = await h.card(target);
      await h.portal(old);
      const before = await h.state(),
        idemCount = await h.prisma.idempotencyRecord.count(),
        failure = new Error(`accept rollback ${point}`);
      let on = h;
      if (point === "event") {
        const emit = h.events.emit.bind(h.events);
        vi.spyOn(h.events, "emit").mockImplementation(async (...args) => {
          const result = await emit(...args);
          if (args[2].type === "invitation.accepted") throw failure;
          return result;
        });
      }
      if (point === "timer") {
        const cancel = h.timers.cancel.bind(h.timers);
        vi.spyOn(h.timers, "cancel").mockImplementation(async (...args) => {
          await cancel(...args);
          throw failure;
        });
      }
      if (point === "portal") {
        const port = h.assembly.port(membershipAuthorizationsPort);
        const revoke = port.revokePortalGrants.bind(port);
        vi.spyOn(port, "revokePortalGrants").mockImplementation(async (...args) => {
          await revoke(...args);
          throw failure;
        });
      }
      if (point === "outer") {
        const real = createTxRunner({ prisma: h.prisma, appEnv: "test" });
        on = {
          ...h,
          ...h.side(h.prisma, {
            run: (fn, options) =>
              real.run(async (tx) => {
                const result = await fn(tx);
                if (
                  (await tx.invitation.findUnique({ where: { id: card.invitationId } }))?.status ===
                  "accepted"
                )
                  throw failure;
                return result;
              }, options),
          }),
        };
      }
      await expect(h.accept(old, card, {}, on)).rejects.toBe(failure);
      assertSnapshotsEqual(before, await h.state());
      expect(await h.prisma.idempotencyRecord.count()).toBe(idemCount + 1);
    },
  );

  it.each(["merchant", "system"] as const)(
    "伪造 %s 上下文/args 不能签发 entity.abandon 权限",
    async (actor) => {
      const old = await h.owner(),
        before = await h.state();
      const ctx =
        actor === "merchant"
          ? old.ctx
          : createIdentityContext({
              actor: { type: "system", job: "tenant.accept_invitation" },
              entityId: old.entityId,
              requestId: uuidv7(),
            });
      await expect(
        h.tx.run(async (tx) => {
          await lockRows(tx, "entity", [old.entityId]);
          await h.flow.transition(tx, ctx, {
            machine: "entity",
            stateField: "lifecycle",
            id: old.entityId,
            entityId: old.entityId,
            event: "entity.abandon",
            ref: "02:524",
            args: { system: true, ownerId: old.memberId, empty: true },
            emit: { type: "entity.abandoned", payload: { v: 1, entityId: old.entityId } },
          });
        }),
      ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED", details: { reason: "guard" } });
      assertSnapshotsEqual(before, await h.state());
    },
  );

  it("公开接受不能嵌套事务，也不能缺 required 幂等或真实会话装配", async () => {
    const target = await h.owner(),
      person = await h.person(),
      card = await h.card(target),
      before = await h.state();
    await expect(h.tx.run(() => h.accept(person, card))).rejects.toMatchObject({
      kind: "external_call_in_transaction",
    });
    await expect(
      h.tenant.acceptInvitation(person.ctx, card, { principal: person.principal }),
    ).rejects.toThrow("required");
    await expect(
      h.accept(person, card, {}, { ...h, ...invitationServices(h.prisma, h.clock) }),
    ).rejects.toMatchObject({ error: "INTERNAL" });
    assertSnapshotsEqual(before, await h.state());
  });

  it.each(["join", "accept"] as const)("伪造 args 不能直调 %s 迁移", async (mode) => {
    const owner = await h.owner(),
      person = await h.clerk(owner),
      card = await h.card(owner);
    const before = await h.state();
    await expect(
      h.tx.run(async (tx) => {
        await lockRows(tx, "entity", [owner.entityId]);
        await lockRows(tx, "invitation", [card.invitationId]);
        await lockRows(tx, "entity_member", [person.memberId]);
        if (mode === "join")
          return h.flow.transition(tx, person.ctx, {
            machine: "entity_member",
            stateField: "status",
            id: person.memberId,
            entityId: owner.entityId,
            storeId: owner.storeId,
            event: "entity_member.join",
            ref: "02:691",
            created: true,
            args: { system: true, invitationId: card.invitationId, principal: person.principal },
            emit: {
              type: "entity_member.joined",
              payload: {
                v: 1,
                entityMemberId: person.memberId,
                entityId: owner.entityId,
                merchantUserId: person.userId,
                invitationId: card.invitationId,
                storeIds: [owner.storeId],
              },
            },
          });
        return h.flow.transition(tx, person.ctx, {
          machine: "invitation",
          stateField: "status",
          id: card.invitationId,
          entityId: owner.entityId,
          storeId: owner.storeId,
          event: "invitation.accept",
          ref: "02:787",
          args: { system: true, memberId: person.memberId, principal: person.principal },
          set: {
            accepted_at: h.clock.now(),
            accepted_by_user_id: person.userId,
            accepted_member_id: person.memberId,
            token_enc: null,
          },
          emit: {
            type: "invitation.accepted",
            payload: {
              v: 1,
              invitationId: card.invitationId,
              entityId: owner.entityId,
              storeId: owner.storeId,
              acceptedByUserId: person.userId,
            },
          },
        });
      }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED", details: { reason: "guard" } });
    assertSnapshotsEqual(before, await h.state());
  });
});
