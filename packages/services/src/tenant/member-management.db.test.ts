import { EVENT_PAYLOAD_SCHEMAS, MemberListSchema } from "@liyoxi/contract";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { media } from "../index.js";
import { uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import {
  managementHarness,
  managementServices,
  updateIdem,
  SLOW,
} from "./__fixtures__/member-management.js";
import type { ManagementHarness, Owner } from "./__fixtures__/member-management.js";

const db = useSeededDatabase("services", { max: 1 });
let h: ManagementHarness;
beforeAll(async () => {
  h = managementHarness(await db.prisma());
}, SLOW);
const listing = async (owner: Owner) =>
  MemberListSchema.options[0].parse(await h.tenant.listMembers(owner.ctx));

describe("成员列表：真实来源与角色裁剪", { timeout: SLOW }, () => {
  it("老板第一、店员按加入时间及ID稳定排序，称呼回落及门店引用均是真实值，GET零写", async () => {
    const owner = await h.owner();
    const second = await h.make.store({ entityId: owner.entityId });
    const a = await h.clerk(owner, [owner.storeId, second.id]);
    const b = await h.clerk(owner);
    const outsider = await h.clerk(owner, [second.id]);
    const removed = await h.clerk(owner);
    await h.tenant.removeMember(owner.ctx, { memberId: removed.memberId });
    await h.prisma.entityMember.update({
      where: { id: owner.memberId },
      data: { createdAt: new Date(h.clock.now().getTime() + 1_000) },
    });
    await h.prisma.entityMember.update({ where: { id: a.memberId }, data: { displayName: null } });
    await h.prisma.merchantUser.update({
      where: { id: a.userId },
      data: { displayName: "账号称呼" },
    });
    await h.prisma.entityMember.update({ where: { id: b.memberId }, data: { displayName: null } });
    await h.prisma.merchantUser.update({ where: { id: b.userId }, data: { displayName: null } });
    await h.prisma.storeMember.update({
      where: { entityMemberId_storeId: { entityMemberId: a.memberId, storeId: second.id } },
      data: { createdAt: new Date(h.clock.now().getTime() + 9_000) },
    });
    const before = await h.state();
    const result = await listing(owner);
    expect(result.items.map((x) => x.memberId)).toEqual([
      owner.memberId,
      ...[a.memberId, b.memberId].sort(),
    ]);
    expect(result.items[0]).toMatchObject({
      role: "owner",
      storeScope: "all",
      stores: [],
      actions: [],
      isSelf: true,
    });
    const item = result.items.find((x) => x.memberId === a.memberId)!;
    expect(item).toMatchObject({
      displayName: "账号称呼",
      joinedAt: h.clock.now().toISOString(),
      isSelf: false,
      storeScope: "listed",
      actions: ["update", "remove"],
    });
    expect(item.phoneMask).toBe(
      (await h.prisma.merchantUser.findUniqueOrThrow({ where: { id: a.userId } })).phoneMask,
    );
    expect(item.stores.map((x) => x.storeId)).toEqual([owner.storeId, second.id]);
    expect(result.items.find((x) => x.memberId === b.memberId)?.displayName).toBeNull();
    expect(
      result.items.some((x) => x.memberId === outsider.memberId || x.memberId === removed.memberId),
    ).toBe(false);
    expect(await h.state()).toEqual(before);
  });

  it("老板一次批量调用实际media读口：采用条数、真实零及跨店主体隔离", async () => {
    const owner = await h.owner();
    const clerk = await h.clerk(owner);
    const zero = await h.clerk(owner);
    const second = await h.make.store({ entityId: owner.entityId });
    const foreign = await h.owner();
    await h.asset(owner, clerk.userId);
    await h.asset(owner, clerk.userId, { adoptedCount: 7 });
    await h.asset(owner, clerk.userId, { adoptedCount: 1, deletedAt: h.clock.now() });
    await h.asset({ entityId: owner.entityId, storeId: second.id }, clerk.userId, {
      adoptedCount: 7,
    });
    await h.asset(foreign, clerk.userId, { adoptedCount: 7 });
    const counts = vi.fn(media.readMemberAssetCounts);
    const service = managementServices(h.prisma, h.clock, undefined, { counts });
    const result = MemberListSchema.options[0].parse(await service.tenant.listMembers(owner.ctx));
    expect(counts).toHaveBeenCalledOnce();
    expect(counts.mock.calls[0]![1]).toEqual({
      entityId: owner.entityId,
      storeId: owner.storeId,
      merchantUserIds: [
        owner.userId,
        ...[clerk, zero].sort((a, b) => a.memberId.localeCompare(b.memberId)).map((x) => x.userId),
      ],
    });
    expect(result.items.find((x) => x.memberId === clerk.memberId)).toMatchObject({
      uploadCount: 2,
      adoptedCount: 1,
    });
    expect(result.items.find((x) => x.memberId === zero.memberId)).toMatchObject({
      uploadCount: 0,
      adoptedCount: 0,
    });
  });

  it("当前店邀请精确过期边界、分享与邀请人，主体名额包括其他店邀请但老板不占", async () => {
    const owner = await h.owner();
    const clerk = await h.clerk(owner);
    const second = await h.make.store({ entityId: owner.entityId });
    const own = await h.invitation(owner);
    const shared = await h.invitation(owner, {
      sharedAt: h.clock.now(),
      targetPhoneBidx: Buffer.alloc(32, 1),
    });
    const other = await h.invitation(owner, { inviterMemberId: clerk.memberId });
    await h.invitation(owner, { storeId: second.id });
    await h.invitation(owner, { expiresAt: h.clock.now() });
    await h.invitation(owner, {
      status: "expired",
      expiresAt: new Date(h.clock.now().getTime() - 1),
    });
    const before = await h.state();
    const result = await listing(owner);
    expect(result.pendingInvitations.map((x) => x.invitationId)).toEqual(
      [own.id, shared.id, other.id].sort().reverse(),
    );
    expect(result.pendingInvitations.find((x) => x.invitationId === shared.id)).toMatchObject({
      isPhoneRestricted: true,
      isShared: true,
      actions: ["revoke"],
    });
    expect(result.pendingInvitations.find((x) => x.invitationId === own.id)).toMatchObject({
      isPhoneRestricted: false,
      isShared: false,
    });
    expect(result.seats).toMatchObject({
      seatsUsed: 5,
      pendingInvitationCount: 4,
      includesUnsharedDraft: true,
      limitReason: "inactive",
      planName: null,
    });
    expect(await h.state()).toEqual(before);
    await h.prisma.invitation.update({ where: { id: own.id }, data: { sharedAt: h.clock.now() } });
    expect((await listing(owner)).seats.includesUnsharedDraft).toBe(false);
    const afterExpectedShare = await h.state();
    await listing(owner);
    expect(await h.state()).toEqual(afterExpectedShare);
  });

  it("沿真实billing套餐事实算有限/不限/覆盖名额与过期后的最近套餐名，不推进账本", async () => {
    const owner = await h.owner();
    await h.clerk(owner);
    const term = await h.make.subscriptionTerm({ entityId: owner.entityId, maxMembers: 1 });
    await h.prisma.billingAccount.update({
      where: { entityId: owner.entityId },
      data: { subStatus: "active", currentSubscriptionTermId: term.id },
    });
    const plan = await h.prisma.plan.findUniqueOrThrow({ where: { id: term.planId } });
    expect((await listing(owner)).seats).toMatchObject({
      memberLimit: 1,
      seatsUsed: 1,
      seatsOver: 0,
      limitReason: "plan",
      planName: plan.name,
    });
    await h.prisma.subscriptionTerm.update({ where: { id: term.id }, data: { maxMembers: null } });
    expect((await listing(owner)).seats.memberLimit).toBeNull();
    await h.prisma.entity.update({
      where: { id: owner.entityId },
      data: { memberLimitOverride: 2 },
    });
    expect((await listing(owner)).seats.memberLimit).toBe(2);
    const now = h.clock.now();
    h.clock.set(new Date(term.endsAt.getTime() + 1));
    try {
      const before = await h.state();
      expect((await listing(owner)).seats).toMatchObject({
        memberLimit: 2,
        planName: plan.name,
        limitReason: "inactive",
      });
      expect(await h.state()).toEqual(before);
    } finally {
      h.clock.set(now);
    }
  });

  it("店员仅五字段与两顶层键，不调用素材/名额/邀请或读取手机号", async () => {
    const owner = await h.owner();
    const clerk = await h.clerk(owner);
    const counts = vi.fn(async () => {
      throw new Error("店员不应读取素材");
    });
    const runner: TxRunner = {
      run: (fn, opts) =>
        h.tx.run(async (tx) => {
          const invite = vi
            .spyOn(tx.invitation, "findMany")
            .mockRejectedValue(new Error("店员不应读取邀请"));
          const phones = vi
            .spyOn(tx.merchantUser, "findMany")
            .mockRejectedValue(new Error("店员不应读取手机号"));
          const terms = vi
            .spyOn(tx.subscriptionTerm, "findMany")
            .mockRejectedValue(new Error("店员不应读取额度"));
          try {
            return await fn(tx);
          } finally {
            invite.mockRestore();
            phones.mockRestore();
            terms.mockRestore();
          }
        }, opts),
    };
    const service = managementServices(h.prisma, h.clock, runner, { counts, events: null });
    const before = await h.state();
    const result = MemberListSchema.options[1].parse(await service.tenant.listMembers(clerk.ctx));
    expect(Object.keys(result).sort()).toEqual(["items", "viewerRole"]);
    expect(result.items).toHaveLength(2);
    for (const item of result.items)
      expect(Object.keys(item).sort()).toEqual([
        "displayName",
        "isSelf",
        "joinedAt",
        "memberId",
        "role",
      ]);
    expect(result.items.find((x) => x.memberId === clerk.memberId)?.isSelf).toBe(true);
    expect(counts).not.toHaveBeenCalled();
    expect(await h.state()).toEqual(before);
  });

  it.each(["missing", "incomplete", "failure"] as const)(
    "老板计数%s明确报错，不伪造0且GET零写",
    async (kind) => {
      const owner = await h.owner();
      const failure = new Error("真实素材读源失败");
      const counts =
        kind === "missing"
          ? null
          : kind === "incomplete"
            ? async () => new Map()
            : async () => {
                throw failure;
              };
      const service = managementServices(h.prisma, h.clock, undefined, { counts });
      const before = await h.state();
      const request = service.tenant.listMembers(owner.ctx);
      if (kind === "failure") await expect(request).rejects.toBe(failure);
      else await expect(request).rejects.toMatchObject({ error: "INTERNAL" });
      expect(await h.state()).toEqual(before);
    },
  );
});

describe("范围调整：同事务完整集合、审计与幂等", { timeout: SLOW }, () => {
  it("增删交集元数据保留、审核中门店可加入、清lastStore，返回移出当前店后的真实历史计数", async () => {
    const owner = await h.owner();
    const keep = await h.make.store({ entityId: owner.entityId });
    const add = await h.make.store({ entityId: owner.entityId, qualificationStatus: "pending" });
    const clerk = await h.clerk(owner, [owner.storeId, keep.id]);
    await h.asset(owner, clerk.userId, { adoptedCount: 7 });
    const before = await h.trace(clerk.memberId);
    const result = await h.tenant.updateMember(owner.ctx, {
      memberId: clerk.memberId,
      storeIds: [add.id, keep.id],
    });
    const after = await h.trace(clerk.memberId);
    expect(after.stores.map((x) => x.storeId)).toEqual([add.id, keep.id].sort());
    expect(after.stores.find((x) => x.storeId === keep.id)).toEqual(
      before.stores.find((x) => x.storeId === keep.id),
    );
    expect(after.stores.find((x) => x.storeId === add.id)).toMatchObject({
      addedByMemberId: owner.memberId,
      createdAt: h.clock.now(),
    });
    expect(after.member.lastStoreId).toBeNull();
    expect(after.history).toEqual(before.history);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({
      stream: "activity",
      category: "member",
      action: "tenant.member.update_stores",
      before: { storeIds: [owner.storeId, keep.id].sort() },
      after: { storeIds: [add.id, keep.id].sort() },
    });
    expect(after.events).toHaveLength(1);
    expect(after.events[0]).toMatchObject({
      eventType: "entity_member.stores_changed",
      aggregateId: clerk.memberId,
    });
    expect(
      EVENT_PAYLOAD_SCHEMAS["entity_member.stores_changed"].parse(after.events[0]!.payload),
    ).toEqual({
      v: 1,
      entityMemberId: clerk.memberId,
      entityId: owner.entityId,
      merchantUserId: clerk.userId,
      addedStoreIds: [add.id],
      removedStoreIds: [owner.storeId],
      invitationId: null,
    });
    expect(result).toMatchObject({
      memberId: clerk.memberId,
      uploadCount: 1,
      adoptedCount: 1,
      actions: ["update", "remove"],
    });
    expect(result.stores.map((x) => x.storeId)).toEqual([keep.id, add.id]);
  });

  it("同主体但当前店未分配的目标仍可管理；保留新集合内的lastStore", async () => {
    const owner = await h.owner();
    const second = await h.make.store({ entityId: owner.entityId });
    const clerk = await h.clerk(owner, [second.id]);
    await h.tenant.updateMember(owner.ctx, {
      memberId: clerk.memberId,
      storeIds: [owner.storeId, second.id],
    });
    expect((await h.trace(clerk.memberId)).member.lastStoreId).toBe(second.id);
  });

  it("小写同集合含不同顺序零旁写；同键重放保首次响应，换body冲突", async () => {
    const owner = await h.owner();
    const second = await h.make.store({ entityId: owner.entityId });
    const clerk = await h.clerk(owner, [owner.storeId, second.id]);
    const before = await h.state();
    await h.tenant.updateMember(owner.ctx, {
      memberId: clerk.memberId,
      storeIds: [second.id, owner.storeId],
    });
    expect(await h.state()).toEqual(before);
    const ids = [second.id];
    const key = uuidv7();
    const firstToken = updateIdem(owner.ctx, clerk.memberId, ids, key);
    const first = await h.tenant.updateMember(
      owner.ctx,
      { memberId: clerk.memberId, storeIds: ids },
      { idem: firstToken },
    );
    const saved = await h.state();
    const replayToken = updateIdem(owner.ctx, clerk.memberId, ids, key);
    expect(
      await h.tenant.updateMember(
        owner.ctx,
        { memberId: clerk.memberId, storeIds: ids },
        { idem: replayToken },
      ),
    ).toEqual(first);
    expect(replayToken.replayed).toBe(true);
    expect(await h.state()).toEqual(saved);
    await expect(
      h.tenant.updateMember(
        owner.ctx,
        { memberId: clerk.memberId, storeIds: [owner.storeId] },
        { idem: updateIdem(owner.ctx, clerk.memberId, [owner.storeId], key) },
      ),
    ).rejects.toMatchObject({ error: "IDEMPOTENCY_KEY_REUSED" });
    expect(await h.state()).toEqual(saved);
  });

  it("同集合只清理历史上已不在集合内的lastStore，不造范围事件或迁移", async () => {
    const owner = await h.owner();
    const second = await h.make.store({ entityId: owner.entityId });
    const clerk = await h.clerk(owner);
    await h.prisma.entityMember.update({
      where: { id: clerk.memberId },
      data: { lastStoreId: second.id },
    });
    const before = await h.trace(clerk.memberId);
    await h.tenant.updateMember(owner.ctx, { memberId: clerk.memberId, storeIds: [owner.storeId] });
    const after = await h.trace(clerk.memberId);
    expect(after.member.lastStoreId).toBeNull();
    expect(after.stores).toEqual(before.stores);
    expect(after.events).toEqual(before.events);
    expect(after.audits).toEqual(before.audits);
    expect(after.history).toEqual(before.history);
  });

  it.each([
    "empty",
    "duplicate",
    "uppercase",
    "mixedcase",
    "malformed",
    "missing",
    "foreign",
    "archived",
    "deleted",
  ] as const)("请求范围%s真实失败且全相关表零写", async (kind) => {
    const owner = await h.owner();
    const clerk = await h.clerk(owner);
    let ids = [owner.storeId];
    if (kind === "empty") ids = [];
    if (kind === "duplicate") ids = [owner.storeId, owner.storeId];
    if (kind === "uppercase") ids = [owner.storeId.toUpperCase()];
    if (kind === "mixedcase") ids = [owner.storeId.replace(/[a-f]/u, (x) => x.toUpperCase())];
    if (kind === "malformed") ids = ["not-a-uuid"];
    if (kind === "missing") ids = [uuidv7()];
    if (kind === "foreign") ids = [(await h.owner()).storeId];
    if (kind === "archived" || kind === "deleted") {
      const store = await h.make.store({
        entityId: owner.entityId,
        lifecycle: "archived",
        archivedAt: h.clock.now(),
        archiveReason: kind === "archived" ? "by_owner" : "draft_deleted",
        archiveActorType: "merchant",
        archiveActorId: owner.userId,
        archiveClient: "weapp",
      });
      ids = [store.id];
    }
    const before = await h.state();
    const request = h.tenant.updateMember(owner.ctx, { memberId: clerk.memberId, storeIds: ids });
    await expect(request).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    if (kind === "empty")
      await expect(request).rejects.toMatchObject({
        details: {
          fieldErrors: [
            { path: "storeIds", message: "请至少保留一家门店；如不再合作，请移除成员" },
          ],
        },
      });
    expect(await h.state()).toEqual(before);
  });

  it.each([
    "owner",
    "removed",
    "foreign",
    "absent",
    "clerkActor",
    "archivedContext",
    "disabledAccount",
  ] as const)("目标或上下文%s守卫使用真实状态且零写", async (kind) => {
    const owner = await h.owner();
    const clerk = await h.clerk(owner);
    let id = clerk.memberId;
    let ctx = owner.ctx;
    let error = "STATE_NOT_ALLOWED";
    if (kind === "owner") id = owner.memberId;
    if (kind === "removed") await h.tenant.leaveMembership(clerk.ctx);
    if (kind === "foreign") {
      id = (await h.clerk(await h.owner())).memberId;
      error = "NOT_FOUND";
    }
    if (kind === "absent") {
      id = uuidv7();
      error = "NOT_FOUND";
    }
    if (kind === "clerkActor") {
      ctx = clerk.ctx;
      error = "ROLE_FORBIDDEN";
    }
    if (kind === "disabledAccount") {
      await h.prisma.merchantUser.update({
        where: { id: owner.userId },
        data: { status: "disabled" },
      });
      error = "NOT_A_MEMBER";
    }
    if (kind === "archivedContext") {
      await h.prisma.store.update({
        where: { id: owner.storeId },
        data: {
          lifecycle: "archived",
          archivedAt: h.clock.now(),
          archiveReason: "by_owner",
          archiveActorType: "merchant",
          archiveActorId: owner.userId,
          archiveClient: "weapp",
        },
      });
      error = "STORE_ARCHIVED";
    }
    const before = await h.state();
    if (kind === "disabledAccount")
      await expect(h.tenant.listMembers(ctx)).rejects.toMatchObject({ error });
    await expect(
      h.tenant.updateMember(ctx, { memberId: id, storeIds: [owner.storeId] }),
    ).rejects.toMatchObject({ error });
    expect(await h.state()).toEqual(before);
  });

  it.each(["counts", "eventsMissing", "afterRealEvent", "outerRollback"] as const)(
    "%s失败完整撤销范围、lastStore、审计、outbox与其他事实",
    async (kind) => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const second = await h.make.store({ entityId: owner.entityId });
      const failure = new Error("范围更新事务故障");
      const runner: TxRunner | undefined =
        kind === "outerRollback"
          ? {
              run: (fn, opts) =>
                h.tx.run(async (tx) => {
                  await fn(tx);
                  throw failure;
                }, opts),
            }
          : undefined;
      const service = managementServices(h.prisma, h.clock, runner, {
        ...(kind === "counts"
          ? {
              counts: async () => {
                throw failure;
              },
            }
          : {}),
        ...(kind === "eventsMissing" ? { events: null } : {}),
      });
      const emit = service.events.emit.bind(service.events);
      const spy =
        kind === "afterRealEvent"
          ? vi.spyOn(service.events, "emit").mockImplementation(async (tx, ctx, input) => {
              await emit(tx, ctx, input);
              throw failure;
            })
          : undefined;
      const before = await h.state();
      try {
        const request = service.tenant.updateMember(owner.ctx, {
          memberId: clerk.memberId,
          storeIds: [second.id],
        });
        if (kind === "eventsMissing")
          await expect(request).rejects.toMatchObject({ error: "INTERNAL" });
        else await expect(request).rejects.toBe(failure);
        expect(await h.state()).toEqual(before);
      } finally {
        spy?.mockRestore();
      }
    },
  );
});
