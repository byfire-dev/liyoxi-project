import { beforeAll, describe, expect, it, vi } from "vitest";

import { createIdentityContext, isAppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, TxRunner } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import {
  memberContext,
  removalHarness,
  removalIdem,
  removalServices,
  SLOW,
} from "./__fixtures__/member-removal.js";
import type { Clerk, Owner, RemovalHarness } from "./__fixtures__/member-removal.js";

const db = useSeededDatabase("services");
let h: RemovalHarness;
beforeAll(async () => {
  h = removalHarness(await db.prisma());
}, SLOW);

async function refusal(attempt: Promise<unknown>, code: string) {
  const error = await attempt.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(isAppError(error) && error.error).toBe(code);
}

const MODES = ["remove", "leave"] as const;
function perform(mode: (typeof MODES)[number], owner: Owner, clerk: Clerk) {
  return mode === "remove"
    ? h.tenant.removeMember(owner.ctx, { memberId: clerk.memberId })
    : h.tenant.leaveMembership(clerk.ctx);
}

describe("成员移除：真实用例、原 flow 与同事务副作用", () => {
  it.each(MODES)(
    "%s 只迁移一次，清全部门店关系并立即失去真实 membership",
    async (mode) => {
      const owner = await h.owner();
      const second = await h.make.store({ entityId: owner.entityId });
      const clerk = await h.clerk(owner, [owner.storeId, second.id]);
      const other = await h.clerk(owner);
      const beforeOther = await h.trace(other.memberId);
      const beforeOwner = await h.trace(owner.memberId);
      const ctx = mode === "remove" ? owner.ctx : clerk.ctx;
      const event = `entity_member.${mode}`;
      const reason = mode === "remove" ? "by_owner" : "self";
      const now = h.clock.now();
      expect((await h.tx.run((tx) => h.tenant.getQuotaUsage(tx, owner.entityId))).seatsUsed).toBe(
        2,
      );
      expect(await h.tenant.activeMembership(h.prisma, clerk.userId)).not.toBeNull();
      expect(
        await h.tenant.resolveMembership(h.prisma, {
          merchantUserId: clerk.userId,
          storeId: second.id,
        }),
      ).not.toBeNull();

      expect(await perform(mode, owner, clerk)).toEqual({
        memberId: clerk.memberId,
        status: "removed",
        removedAt: now.toISOString(),
      });
      const trace = await h.trace(clerk.memberId);
      expect(trace.member).toMatchObject({
        status: "removed",
        role: "clerk",
        removedAt: now,
        removeReason: reason,
        removeActorType: "merchant",
        removeActorId: ctx.actor.id,
        removeClient: "weapp",
        lastStoreId: null,
      });
      expect(trace.stores).toEqual([]);
      expect((await h.tx.run((tx) => h.tenant.getQuotaUsage(tx, owner.entityId))).seatsUsed).toBe(
        1,
      );
      expect(trace.history).toHaveLength(1);
      expect(trace.history[0]).toMatchObject({
        machine: "entity_member",
        stateField: "status",
        subjectId: clerk.memberId,
        entityId: owner.entityId,
        fromState: "active",
        toState: "removed",
        event,
        actorType: "merchant",
        actorId: ctx.actor.id,
        client: "weapp",
        reasonCode: reason,
      });
      expect(trace.audits).toHaveLength(1);
      expect(trace.audits[0]).toMatchObject({
        stream: "activity",
        action: `tenant.${event}`,
        actorType: "merchant",
        actorId: ctx.actor.id,
        client: "weapp",
        targetId: clerk.memberId,
      });
      expect(trace.events).toHaveLength(1);
      expect(trace.events[0]).toMatchObject({
        eventType: "entity_member.removed",
        aggregateType: "entity_member",
        aggregateId: clerk.memberId,
        entityId: owner.entityId,
      });
      expect(trace.events[0]?.payload).toEqual({
        v: 1,
        entityMemberId: clerk.memberId,
        entityId: owner.entityId,
        merchantUserId: clerk.userId,
        role: "clerk",
        removeReason: reason,
        fromState: "active",
        toState: "removed",
        transition: event,
      });
      expect(await h.tenant.activeMembership(h.prisma, clerk.userId)).toBeNull();
      expect(await h.tenant.membershipBriefs(h.prisma, clerk.userId)).toEqual([]);
      expect(await h.tenant.listStores({ merchantUserId: clerk.userId })).toEqual({
        viewerRole: "none",
        entity: null,
        items: [],
      });
      for (const storeId of [owner.storeId, second.id])
        expect(
          await h.tenant.resolveMembership(h.prisma, { merchantUserId: clerk.userId, storeId }),
        ).toBeNull();
      await refusal(
        h.tenant.rememberCurrentStore({ merchantUserId: clerk.userId, storeId: second.id }),
        "NOT_FOUND",
      );
      expect(await h.trace(other.memberId)).toEqual(beforeOther);
      expect(await h.trace(owner.memberId)).toEqual(beforeOwner);
      expect(
        await h.tenant.resolveMembership(h.prisma, {
          merchantUserId: other.userId,
          storeId: owner.storeId,
        }),
      ).not.toBeNull();
    },
    SLOW,
  );

  it.each(MODES)(
    "%s 不删除上传素材、不撤销登录/老板 portal、不增改同意",
    async (mode) => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const now = h.clock.now();
      // 合法历史前提；本片不宣称执行了素材上传或 portal 登录。
      const asset = await h.prisma.storeAsset.create({
        data: {
          id: uuidv7(),
          entityId: owner.entityId,
          storeId: owner.storeId,
          type: "text",
          textBody: "保留店员上传的门店素材",
          uploadActorType: "merchant",
          uploadActorId: clerk.userId,
          uploadActorRole: "clerk",
          uploadClient: "weapp",
          processingState: "pending",
          reviewState: "unreviewed",
          idempotencyKey: uuidv7(),
          createdAt: now,
          updatedAt: now,
        },
      });
      const identity = await h.prisma.wechatIdentity.create({
        data: {
          id: uuidv7(),
          merchantUserId: clerk.userId,
          appid: "wx_member_removal_fixture",
          openid: uuidv7(),
          createdAt: now,
          updatedAt: now,
          lastActiveAt: now,
          lastLoginAt: now,
        },
      });
      const session = await h.prisma.userSession.create({
        data: {
          id: uuidv7(),
          merchantUserId: clerk.userId,
          wechatIdentityId: identity.id,
          tokenHash: new Uint8Array(32).fill(17),
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
          lastIp: "203.0.113.17",
          idleExpiresAt: new Date(now.getTime() + 30 * 86_400_000),
          absoluteExpiresAt: new Date(now.getTime() + 90 * 86_400_000),
        },
      });
      const portal = await h.prisma.portalSession.create({
        data: {
          id: uuidv7(),
          tokenHash: new Uint8Array(32).fill(mode === "remove" ? 21 : 22),
          portalTicketId: uuidv7(),
          approvedByUserId: owner.userId,
          entityId: owner.entityId,
          storeId: owner.storeId,
          grantScope: "store",
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + 7_200_000),
          ip: "203.0.113.18",
          userAgent: "fixture",
        },
      });
      const consent = await h.make.agreementConsent({
        scene: "member_join",
        role: "clerk",
        merchantUserId: clerk.userId,
        entityId: owner.entityId,
        storeId: owner.storeId,
      });
      const beforeConsents = await h.prisma.agreementConsent.findMany({
        where: { merchantUserId: clerk.userId },
      });
      expect(beforeConsents).toContainEqual(consent);
      await perform(mode, owner, clerk);
      expect(await h.prisma.storeAsset.findUnique({ where: { id: asset.id } })).toEqual(asset);
      expect(await h.prisma.userSession.findUnique({ where: { id: session.id } })).toEqual(session);
      expect(await h.prisma.wechatIdentity.findUnique({ where: { id: identity.id } })).toEqual(
        identity,
      );
      expect(await h.prisma.portalSession.findUnique({ where: { id: portal.id } })).toEqual(portal);
      expect(
        await h.prisma.agreementConsent.findMany({ where: { merchantUserId: clerk.userId } }),
      ).toEqual(beforeConsents);
    },
    SLOW,
  );

  it.each(["peer", "self", "owner"] as const)(
    "店员不能移除 %s，角色快照不能伪装老板",
    async (targetKind) => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const peer = await h.clerk(owner);
      const memberId =
        targetKind === "peer"
          ? peer.memberId
          : targetKind === "self"
            ? clerk.memberId
            : owner.memberId;
      const before = await h.trace(memberId);
      const spoof = createIdentityContext({
        ...clerk.ctx,
        actor: { ...clerk.ctx.actor, role: "owner" },
      });
      await refusal(h.tenant.removeMember(spoof, { memberId }), "ROLE_FORBIDDEN");
      expect(await h.trace(memberId)).toEqual(before);
    },
    SLOW,
  );

  it(
    "老板不能退出或移除老板，保持原关系/历史/事件",
    async () => {
      const owner = await h.owner();
      const before = await h.trace(owner.memberId);
      await refusal(h.tenant.leaveMembership(owner.ctx), "OWNER_CANNOT_LEAVE");
      await refusal(
        h.tenant.removeMember(owner.ctx, { memberId: owner.memberId }),
        "STATE_NOT_ALLOWED",
      );
      expect(await h.trace(owner.memberId)).toEqual(before);
    },
    SLOW,
  );

  it(
    "老板停用门店上下文禁 member.manage，leave 仍拒老板退出",
    async () => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const archived = await h.make.store({
        entityId: owner.entityId,
        lifecycle: "archived",
        archiveReason: "by_owner",
        archivedAt: h.clock.now(),
        archiveActorType: "merchant",
        archiveActorId: owner.userId,
        archiveClient: "weapp",
      });
      const ctx = memberContext(owner.userId, owner.entityId, archived.id);
      const before = await h.trace(clerk.memberId);
      await refusal(h.tenant.removeMember(ctx, { memberId: clerk.memberId }), "STORE_ARCHIVED");
      await refusal(h.tenant.leaveMembership(ctx), "OWNER_CANNOT_LEAVE");
      expect(await h.trace(clerk.memberId)).toEqual(before);
    },
    SLOW,
  );

  it.each(["missing", "foreign"] as const)(
    "目标 %s 隐藏为 NOT_FOUND，跨主体不落写",
    async (kind) => {
      const owner = await h.owner();
      const foreignOwner = await h.owner();
      const foreign = await h.clerk(foreignOwner);
      const before = await h.trace(foreign.memberId);
      await refusal(
        h.tenant.removeMember(owner.ctx, {
          memberId: kind === "missing" ? uuidv7() : foreign.memberId,
        }),
        "NOT_FOUND",
      );
      expect(await h.trace(foreign.memberId)).toEqual(before);
    },
    SLOW,
  );

  it.each(MODES)(
    "%s 后重新调用不重写终态时间或原因",
    async (mode) => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      await perform(mode, owner, clerk);
      const before = await h.trace(clerk.memberId);
      h.clock.advance(86_400_000);
      await refusal(
        h.tenant.removeMember(owner.ctx, { memberId: clerk.memberId }),
        "STATE_NOT_ALLOWED",
      );
      await refusal(h.tenant.leaveMembership(clerk.ctx), "NOT_A_MEMBER");
      expect(await h.trace(clerk.memberId)).toEqual(before);
    },
    SLOW,
  );

  it.each(["noEntity", "noStore", "foreignStore", "foreignEntity", "portal", "nonMember"] as const)(
    "上下文 %s 不能沿用有效账号越权",
    async (kind) => {
      const owner = await h.owner();
      const other = await h.owner();
      const clerk = await h.clerk(owner);
      const ctx = createIdentityContext({
        ...owner.ctx,
        entityId:
          kind === "noEntity" ? null : kind === "foreignEntity" ? other.entityId : owner.entityId,
        storeId:
          kind === "noEntity" || kind === "noStore"
            ? null
            : kind === "foreignStore"
              ? other.storeId
              : owner.storeId,
        actor: {
          type: "merchant",
          id: kind === "nonMember" ? (await h.make.merchantUser()).id : owner.userId,
          client: kind === "portal" ? "portal" : "weapp",
        },
      });
      const before = await h.trace(clerk.memberId);
      await refusal(h.tenant.removeMember(ctx, { memberId: clerk.memberId }), "NOT_A_MEMBER");
      expect(await h.trace(clerk.memberId)).toEqual(before);
    },
    SLOW,
  );

  it.each(["staff", "system"] as const)(
    "%s 不能直接调用商家移除入口",
    async (type) => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const ctx = createIdentityContext({
        actor:
          type === "staff"
            ? { type, id: (await h.make.staff()).id, client: "admin" }
            : { type, job: "lyxtest.remove" },
        entityId: owner.entityId,
        storeId: owner.storeId,
      });
      const before = await h.trace(clerk.memberId);
      await refusal(h.tenant.removeMember(ctx, { memberId: clerk.memberId }), "ROLE_FORBIDDEN");
      await refusal(h.tenant.leaveMembership(ctx), "ROLE_FORBIDDEN");
      expect(await h.trace(clerk.memberId)).toEqual(before);
    },
    SLOW,
  );

  it(
    "没有当前门店范围的店员不能退出；其他分配仍保留",
    async () => {
      const owner = await h.owner();
      const second = await h.make.store({ entityId: owner.entityId });
      const clerk = await h.clerk(owner, [second.id]);
      const before = await h.trace(clerk.memberId);
      await refusal(
        h.tenant.leaveMembership(memberContext(clerk.userId, owner.entityId, owner.storeId)),
        "NOT_A_MEMBER",
      );
      expect(await h.trace(clerk.memberId)).toEqual(before);
    },
    SLOW,
  );
});

describe("成员移除：原 required 幂等与失败原子性", () => {
  it.each(MODES)(
    "%s 同键真实重放沿用首次结果，不再迁移",
    async (mode) => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const ctx = mode === "remove" ? owner.ctx : clerk.ctx;
      const key = uuidv7();
      const idem = () => removalIdem(ctx, { mode, key, memberId: clerk.memberId });
      const invoke = (token: ReturnType<typeof idem>) =>
        mode === "remove"
          ? h.tenant.removeMember(ctx, { memberId: clerk.memberId }, { idem: token })
          : h.tenant.leaveMembership(ctx, { idem: token });
      const first = idem();
      const result = await invoke(first);
      const before = await h.trace(clerk.memberId);
      h.clock.advance(3_600_000);
      const second = idem();
      expect(await invoke(second)).toEqual(result);
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(await h.trace(clerk.memberId)).toEqual(before);
      expect(await h.prisma.idempotencyRecord.count({ where: { key, scope: first.scope } })).toBe(
        1,
      );
    },
    SLOW,
  );

  it.each(["target", "store"] as const)(
    "同键改变 %s 得 IDEMPOTENCY_KEY_REUSED，第二目标不受影响",
    async (kind) => {
      const owner = await h.owner();
      const first = await h.clerk(owner);
      const second = await h.clerk(owner);
      const store = await h.make.store({ entityId: owner.entityId });
      const key = uuidv7();
      await h.tenant.removeMember(
        owner.ctx,
        { memberId: first.memberId },
        {
          idem: removalIdem(owner.ctx, { mode: "remove", key, memberId: first.memberId }),
        },
      );
      const before = await h.trace(second.memberId);
      const ctx =
        kind === "store" ? memberContext(owner.userId, owner.entityId, store.id) : owner.ctx;
      const memberId = kind === "target" ? second.memberId : first.memberId;
      await refusal(
        h.tenant.removeMember(
          ctx,
          { memberId },
          {
            idem: removalIdem(ctx, { mode: "remove", key, memberId }),
          },
        ),
        "IDEMPOTENCY_KEY_REUSED",
      );
      expect(await h.trace(second.memberId)).toEqual(before);
    },
    SLOW,
  );

  it.each(MODES)(
    "%s 在真实事件 INSERT 后抛错，成员/历史/审计/outbox/幂等一起回滚",
    async (mode) => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const ctx = mode === "remove" ? owner.ctx : clerk.ctx;
      const before = await h.trace(clerk.memberId);
      const failure = new Error("after real event insert");
      const emit = h.events.emit;
      let observed = false;
      const spy = vi.spyOn(h.events, "emit").mockImplementation(async (tx, eventCtx, input) => {
        const result = await emit(tx, eventCtx, input);
        if (input.type === "entity_member.removed") {
          observed = (await tx.outboxEvent.count({ where: { aggregateId: clerk.memberId } })) === 1;
          throw failure;
        }
        return result;
      });
      const key = uuidv7();
      try {
        const idem = removalIdem(ctx, { mode, key, memberId: clerk.memberId });
        const attempt =
          mode === "remove"
            ? h.tenant.removeMember(ctx, { memberId: clerk.memberId }, { idem })
            : h.tenant.leaveMembership(ctx, { idem });
        await expect(attempt).rejects.toBe(failure);
        expect(observed).toBe(true);
      } finally {
        spy.mockRestore();
      }
      expect(await h.trace(clerk.memberId)).toEqual(before);
      expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
      expect(await perform(mode, owner, clerk)).toMatchObject({ status: "removed" });
    },
    SLOW,
  );

  it.each(MODES)(
    "%s 返回后同 Tx 外层失败，已完成的删除与原幂等也回滚",
    async (mode) => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const before = await h.trace(clerk.memberId);
      const failure = new Error("caller rollback");
      let sawCompleted = false;
      const runner: TxRunner = {
        run: (fn, options) =>
          h.tx.run(async (tx) => {
            const result = await fn(tx);
            sawCompleted =
              (await tx.storeMember.count({ where: { entityMemberId: clerk.memberId } })) === 0 &&
              (await tx.entityMember.findUniqueOrThrow({ where: { id: clerk.memberId } }))
                .status === "removed";
            expect(result).toMatchObject({ memberId: clerk.memberId, status: "removed" });
            throw failure;
          }, options),
      };
      const services = removalServices(h.prisma, h.clock, runner);
      const ctx = mode === "remove" ? owner.ctx : clerk.ctx;
      const key = uuidv7();
      const idem = removalIdem(ctx, { mode, key, memberId: clerk.memberId });
      const attempt =
        mode === "remove"
          ? services.tenant.removeMember(ctx, { memberId: clerk.memberId }, { idem })
          : services.tenant.leaveMembership(ctx, { idem });
      await expect(attempt).rejects.toBe(failure);
      expect(sawCompleted).toBe(true);
      expect(await h.trace(clerk.memberId)).toEqual(before);
      expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
    },
    SLOW,
  );

  it.each(["remove", "leave"] as const)(
    "绕过 public 用例直接 flow.%s 被拒，不能漏掉清理",
    async (mode) => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const before = await h.trace(clerk.memberId);
      const ctx: IdentityContext = mode === "remove" ? owner.ctx : clerk.ctx;
      await expect(
        h.tx.run(async (tx) => {
          await lockRows(tx, "entity", [owner.entityId]);
          await lockRows(tx, "entity_member", [owner.memberId, clerk.memberId].sort());
          return h.flow.transition(tx, ctx, {
            machine: "entity_member",
            stateField: "status",
            id: clerk.memberId,
            entityId: owner.entityId,
            storeId: owner.storeId,
            event: `entity_member.${mode}`,
            set: {
              removed_at: h.clock.now(),
              remove_reason: mode === "remove" ? "by_owner" : "self",
              remove_actor_type: "merchant",
              remove_actor_id: ctx.actor.id,
              remove_client: "weapp",
            },
            emit: {
              type: "entity_member.removed",
              payload: {
                v: 1,
                entityMemberId: clerk.memberId,
                entityId: owner.entityId,
                merchantUserId: clerk.userId,
                role: "clerk",
                removeReason: mode === "remove" ? "by_owner" : "self",
              },
            },
          });
        }),
      ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED", details: { reason: "guard" } });
      expect(await h.trace(clerk.memberId)).toEqual(before);
    },
    SLOW,
  );
});
