import { randomUUID } from "node:crypto";
import { InvitationCardSchema, InvitationPreviewSchema } from "@liyoxi/contract";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createTenant } from "./index.js";
import { uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { decryptField, phoneBidx } from "../security/index.js";
import { TEST_KEYRING, useSeededDatabase } from "../testing/index.js";
import {
  invitationHarness,
  invitationServices,
  invitationIdem,
  memberContext,
  SLOW,
} from "./__fixtures__/invitations.js";
import type { InvitationHarness } from "./__fixtures__/invitations.js";

const db = useSeededDatabase("services", { max: 1 });
let h: InvitationHarness;
beforeAll(async () => {
  h = invitationHarness(await db.prisma());
}, SLOW);

describe("邀请卡片：真实自然绑定与事务事实", { timeout: SLOW }, () => {
  it("新建真实迁移/审计/事件/timer，密文可还原32字节令牌，响应无盲索引", async () => {
    const owner = await h.owner(),
      key = randomUUID();
    await h.prisma.merchantUser.update({
      where: { id: owner.userId },
      data: { displayName: null },
    });
    const card = InvitationCardSchema.parse(
      await h.card(owner, {
        clientRequestId: key,
        remarkName: "张测试",
        targetPhone: "13800000000",
      }),
    );
    const t = await h.trace(card.invitationId);
    expect(card).toMatchObject({
      isReused: false,
      role: "clerk",
      isPhoneRestricted: true,
      inviterName: "门店老板",
      seats: { seatsUsed: 1, pendingInvitationCount: 1, includesUnsharedDraft: true },
    });
    expect(Buffer.from(card.token, "base64url")).toHaveLength(32);
    expect(decryptField(TEST_KEYRING, "invitation.token_enc", t.row.tokenEnc!)).toBe(card.token);
    expect(Buffer.from(t.row.targetPhoneBidx!)).toEqual(phoneBidx(TEST_KEYRING, "13800000000"));
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).toMatchObject({
      clientRequestId: key,
      invitationId: card.invitationId,
      inviterMemberId: owner.memberId,
      entityId: owner.entityId,
      storeId: owner.storeId,
    });
    expect(t.history).toHaveLength(1);
    expect(t.history[0]).toMatchObject({
      fromState: null,
      toState: "pending",
      event: "invitation.create",
    });
    expect(t.audits).toHaveLength(1);
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({
      eventType: "invitation.created",
      payload: {
        v: 1,
        invitationId: card.invitationId,
        expiresAt: card.expiresAt,
        fromState: null,
        toState: "pending",
        transition: "invitation.create",
      },
    });
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]).toMatchObject({
      status: "scheduled",
      dedupeKey: `invitation.expire:invitation:${card.invitationId}`,
    });
    const encoded = JSON.stringify({ card, events: t.events, audits: t.audits });
    expect(encoded).not.toContain("13800000000");
    expect(JSON.stringify(card)).not.toMatch(/tokenEnc|tokenHash|targetPhoneBidx|merchantUserId/);
  });

  it("A/B绑定同卡，share后B同键永久重放原token/期限且零写，C才新建", async () => {
    const owner = await h.owner(),
      a = uuidv7(),
      b = uuidv7();
    const first = await h.card(owner, { clientRequestId: a });
    h.clock.advance(1_000);
    const reused = await h.card(owner, { clientRequestId: b, remarkName: "李测试" });
    expect(reused).toMatchObject({
      invitationId: first.invitationId,
      token: first.token,
      isReused: true,
    });
    expect(reused.expiresAt).not.toBe(first.expiresAt);
    const shared = await h.tenant.markInvitationShared(owner.ctx, {
      invitationId: first.invitationId,
    });
    const before = await h.state();
    h.clock.advance(2_000);
    const replay = await h.card(owner, { clientRequestId: b, remarkName: "不会写入" });
    expect(replay).toEqual({ ...reused, seats: { ...reused.seats, includesUnsharedDraft: false } });
    expect(await h.state()).toEqual(before);
    expect((await h.trace(first.invitationId)).row.sharedAt?.toISOString()).toBe(shared.sharedAt);
    const third = await h.card(owner);
    expect(third.invitationId).not.toBe(first.invitationId);
    const old = await h.trace(first.invitationId);
    expect(old.requests).toHaveLength(2);
    expect(old.history).toHaveLength(1);
    expect(old.events).toHaveLength(1);
    expect(old.audits).toHaveLength(2);
  });

  it("同键库pending即使时间已过仍回原Card；lookup只派生expired且不写库", async () => {
    const owner = await h.owner(),
      key = uuidv7();
    const first = await h.card(owner, { clientRequestId: key });
    h.clock.set(new Date(new Date(first.expiresAt).getTime() + 1));
    const before = await h.state();
    const replay = await h.card(owner, { clientRequestId: key });
    expect(replay).toMatchObject({
      invitationId: first.invitationId,
      token: first.token,
      expiresAt: first.expiresAt,
      isReused: false,
    });
    const preview = InvitationPreviewSchema.parse(await h.tenant.lookupInvitation(first.token));
    expect(preview.status).toBe("expired");
    expect(Object.keys(preview)).toHaveLength(9);
    expect(await h.state()).toEqual(before);
    expect((await h.trace(first.invitationId)).row.status).toBe("pending");
    await expect(h.tenant.lookupInvitation("x".repeat(43))).rejects.toMatchObject({
      error: "INVITATION_INVALID",
    });
  });

  it("复用缺省保留、null清空；无字段变更不增审计/历史/事件，过期新意图不复用", async () => {
    const owner = await h.owner();
    const first = await h.card(owner, { remarkName: "备注", targetPhone: "13800000000" });
    const before = await h.trace(first.invitationId);
    const same = await h.card(owner);
    expect(same).toMatchObject({
      invitationId: first.invitationId,
      remarkName: "备注",
      isPhoneRestricted: true,
    });
    expect((await h.trace(first.invitationId)).audits).toEqual(before.audits);
    const clear = await h.card(owner, { remarkName: null, targetPhone: null });
    expect(clear).toMatchObject({
      invitationId: first.invitationId,
      remarkName: null,
      isPhoneRestricted: false,
    });
    const after = await h.trace(first.invitationId);
    expect(after.audits).toHaveLength(2);
    expect(after.history).toEqual(before.history);
    expect(after.events).toEqual(before.events);
    h.clock.set(new Date(clear.expiresAt));
    expect((await h.card(owner)).invitationId).not.toBe(first.invitationId);
  });

  it.each(["accepted", "revoked", "expired"] as const)(
    "永久绑定的%s终态拒绝新建和续期",
    async (status) => {
      const owner = await h.owner(),
        key = uuidv7();
      const card = await h.card(owner, { clientRequestId: key });
      if (status === "revoked")
        await h.tenant.revokeInvitation(owner.ctx, {
          invitationId: card.invitationId,
          reason: "by_owner",
        });
      else if (status === "expired") {
        h.clock.set(new Date(card.expiresAt));
        expect(await h.run(card.invitationId)).toBe("fired");
      } else {
        // 接受入口未交付：只建立满足原 CHECK 的既有历史终态，映射不改。
        const clerk = await h.clerk(owner);
        await h.prisma.invitation.update({
          where: { id: card.invitationId },
          data: {
            status,
            acceptedAt: h.clock.now(),
            acceptedByUserId: clerk.userId,
            acceptedMemberId: clerk.memberId,
            tokenEnc: null,
          },
        });
      }
      const before = await h.state();
      await expect(h.card(owner, { clientRequestId: key })).rejects.toMatchObject({
        error: "STATE_NOT_ALLOWED",
      });
      expect(await h.state()).toEqual(before);
      expect((await h.tenant.lookupInvitation(card.token)).status).toBe(status);
    },
  );

  it("同创建键跨门店隐藏，非owner/失效账号/归属不符拒绝且零写", async () => {
    const owner = await h.owner(),
      key = uuidv7();
    const card = await h.card(owner, { clientRequestId: key });
    const second = await h.make.store({ entityId: owner.entityId });
    const clerk = await h.clerk(owner),
      other = await h.owner();
    const before = await h.state();
    await expect(
      h.card(
        { ctx: memberContext(owner.userId, owner.entityId, second.id) },
        { clientRequestId: key },
      ),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    await expect(h.card(clerk)).rejects.toMatchObject({ error: "ROLE_FORBIDDEN" });
    await expect(
      h.tenant.markInvitationShared(other.ctx, { invitationId: card.invitationId }),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    await expect(
      h.card({ ctx: memberContext(owner.userId, other.entityId, owner.storeId) }),
    ).rejects.toMatchObject({ error: "NOT_A_MEMBER" });
    await h.prisma.merchantUser.update({
      where: { id: owner.userId },
      data: { status: "disabled" },
    });
    await expect(h.card(owner)).rejects.toMatchObject({ error: "NOT_A_MEMBER" });
    expect(await h.state()).toEqual(before);
  });

  it("required分享幂等只写一次，撤回同Tx取消timer/清token且只一份迁移", async () => {
    const owner = await h.owner(),
      card = await h.card(owner),
      sharedKey = uuidv7();
    const shared = () =>
      h.tenant.markInvitationShared(
        owner.ctx,
        { invitationId: card.invitationId },
        { idem: invitationIdem(owner.ctx, card.invitationId, "markShared", null, sharedKey) },
      );
    const first = await shared(),
      before = await h.trace(card.invitationId);
    expect(await shared()).toEqual(first);
    await expect(
      h.tenant.revokeInvitation(owner.ctx, {
        invitationId: card.invitationId,
        reason: "unshared_leave",
      }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(await h.trace(card.invitationId)).toEqual(before);
    const body = { reason: "by_owner" as const },
      key = uuidv7();
    const revoke = () =>
      h.tenant.revokeInvitation(
        owner.ctx,
        { invitationId: card.invitationId, ...body },
        { idem: invitationIdem(owner.ctx, card.invitationId, "revoke", body, key) },
      );
    const result = await revoke(),
      after = await h.trace(card.invitationId);
    expect(await revoke()).toEqual(result);
    expect(await h.trace(card.invitationId)).toEqual(after);
    expect(after.row).toMatchObject({
      status: "revoked",
      tokenEnc: null,
      revokeReason: "by_owner",
      revokeActorId: owner.userId,
    });
    expect(after.history).toHaveLength(2);
    expect(after.events).toHaveLength(2);
    expect(after.events[1]?.eventType).toBe("invitation.revoked");
    expect(after.timers.every((timer) => timer.status === "cancelled")).toBe(true);
    expect(
      await h.tenant.markInvitationShared(owner.ctx, { invitationId: card.invitationId }),
    ).toEqual(first);
  });

  it("检测拒绝/不可用无写；绑定重试不检测，配置缺失仅新入口明确失败", async () => {
    const owner = await h.owner(),
      before = await h.state();
    h.wechat.textVerdicts.push("block");
    await expect(h.card(owner, { remarkName: "检测拒绝" })).rejects.toMatchObject({
      error: "CONTENT_REJECTED",
      details: { fields: ["remarkName"] },
    });
    h.wechat.setTextCheckAvailable(false);
    await expect(h.card(owner, { remarkName: "检测失败" })).rejects.toMatchObject({
      error: "PROVIDER_UNAVAILABLE",
    });
    expect(await h.state()).toEqual(before);
    h.wechat.setTextCheckAvailable(true);
    const key = uuidv7(),
      card = await h.card(owner, { clientRequestId: key, remarkName: "允许" });
    const calls = h.wechat.callsOf("checkText").length;
    h.wechat.setTextCheckAvailable(false);
    expect((await h.card(owner, { clientRequestId: key, remarkName: "无需检测" })).token).toBe(
      card.token,
    );
    expect(h.wechat.callsOf("checkText")).toHaveLength(calls);
    h.wechat.setTextCheckAvailable(true);
    const bare = createTenant({ tx: h.tx, clock: h.clock, flow: h.flow, assembly: h.assembly });
    await expect(bare.lookupInvitation(card.token)).rejects.toMatchObject({ error: "INTERNAL" });
    expect(await bare.activeMembership(h.prisma, owner.userId)).not.toBeNull();
  });

  it("真实活动参数require_phone/TTL，成员名额含有效邀请；复用不二次占用", async () => {
    const owner = await h.owner();
    await h.param("invitation.require_phone", true);
    await h.param("invitation.ttl_hours", 2);
    await h.prisma.entity.update({
      where: { id: owner.entityId },
      data: { memberLimitOverride: 1, storeLimitOverride: 1 },
    });
    await h.make.store({ entityId: owner.entityId });
    await expect(h.card(owner)).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    const card = await h.card(owner, { targetPhone: "13800000000" });
    expect(new Date(card.expiresAt).getTime() - h.clock.now().getTime()).toBe(7_200_000);
    expect((await h.card(owner)).invitationId).toBe(card.invitationId);
    await expect(h.card(owner, { targetPhone: null })).rejects.toMatchObject({
      error: "VALIDATION_FAILED",
    });
    await h.tenant.markInvitationShared(owner.ctx, { invitationId: card.invitationId });
    const before = await h.state();
    await expect(h.card(owner, { targetPhone: "13800000000" })).rejects.toMatchObject({
      error: "SEAT_LIMIT_REACHED",
    });
    expect(await h.state()).toEqual(before);
    await h.param("invitation.require_phone", false);
    await h.param("invitation.ttl_hours", 24);
  });

  it("每日上限按上海日界现算，撤回不计、到期仍计、跨日放行", async () => {
    h.clock.set(new Date("2026-06-01T12:00:00Z"));
    await h.param("invitation.daily_cap", 1);
    await h.param("invitation.ttl_hours", 1);
    const earlier = await h.owner(),
      elapsed = await h.card(earlier);
    h.clock.set(new Date(elapsed.expiresAt));
    expect(await h.run(elapsed.invitationId)).toBe("fired");
    await expect(h.card(earlier)).rejects.toMatchObject({ error: "INVITATION_DAILY_LIMIT" });
    await h.param("invitation.ttl_hours", 24);
    const owner = await h.owner();
    await h.prisma.entity.update({
      where: { id: owner.entityId },
      data: { memberLimitOverride: 50 },
    });
    h.clock.set(new Date("2026-06-01T15:59:59Z"));
    await h.param("invitation.daily_cap", 1);
    const first = await h.card(owner);
    await h.tenant.markInvitationShared(owner.ctx, { invitationId: first.invitationId });
    await expect(h.card(owner)).rejects.toMatchObject({ error: "INVITATION_DAILY_LIMIT" });
    await h.tenant.revokeInvitation(owner.ctx, {
      invitationId: first.invitationId,
      reason: "by_owner",
    });
    const replacement = await h.card(owner);
    await h.tenant.markInvitationShared(owner.ctx, { invitationId: replacement.invitationId });
    h.clock.advance(1_000);
    const tomorrow = await h.card(owner);
    expect(tomorrow.invitationId).not.toBe(replacement.invitationId);
    await h.param("invitation.daily_cap", 20);
  });

  it.each(["create", "revoke"] as const)("%s真实事件后失败整笔回滚", async (mode) => {
    const owner = await h.owner(),
      card = mode === "revoke" ? await h.card(owner) : null;
    const before = await h.state();
    const original = h.events.emit.bind(h.events);
    const failure = vi.spyOn(h.events, "emit").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("真实事件后故障");
    });
    try {
      await expect(
        mode === "create"
          ? h.card(owner)
          : h.tenant.revokeInvitation(owner.ctx, {
              invitationId: card!.invitationId,
              reason: "by_owner",
            }),
      ).rejects.toThrow("真实事件后故障");
      expect(await h.state()).toEqual(before);
    } finally {
      failure.mockRestore();
    }
  });

  it("三段settle外层rollback保映射/卡片/timer/历史全无", async () => {
    const owner = await h.owner(),
      before = await h.state();
    let calls = 0;
    const runner: TxRunner = {
      run: (fn, options) =>
        h.tx.run(async (tx) => {
          const result = await fn(tx);
          if (++calls === 2) throw new Error("settle外层回滚");
          return result;
        }, options),
    };
    const side = invitationServices(h.prisma, h.clock, runner);
    await expect(
      side.tenant.createInvitation(owner.ctx, { clientRequestId: uuidv7() }),
    ).rejects.toThrow("settle外层回滚");
    expect(await h.state()).toEqual(before);
  });

  it("无内部预锁witness不能绕过公开flow直接撤回", async () => {
    const owner = await h.owner(),
      card = await h.card(owner),
      before = await h.state();
    await expect(
      h.tx.run((tx) =>
        h.flow.transition(tx, owner.ctx, {
          machine: "invitation",
          stateField: "status",
          id: card.invitationId,
          event: "invitation.revoke",
          entityId: owner.entityId,
          storeId: owner.storeId,
        }),
      ),
    ).rejects.toThrow();
    expect(await h.state()).toEqual(before);
  });
});
