import { StoreCardSchema } from "@liyoxi/contract";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppError, createIdentityContext, uuidv7 } from "../kernel/index.js";
import { snapshotTables, useSeededDatabase } from "../testing/index.js";
import { createTenant } from "./index.js";
import { BODY, SLOW, storeHarness, storeIdem } from "./__fixtures__/store-create.js";
import type { StoreHarness } from "./__fixtures__/store-create.js";

const db = useSeededDatabase("services", { label: "storecreate", max: 1 });
let h: StoreHarness;
beforeAll(async () => {
  h = await storeHarness(await db.prisma());
}, SLOW);
afterEach(async () => {
  h.validated.mockClear();
  h.initialized.mockClear();
  await h.restoreLimit();
});

describe("分店创建真实本域命令与typed端口边界", { timeout: SLOW }, () => {
  it("首店仍独立创建；新分店有完整卡片和唯一创建历史，资格保持未提交", async () => {
    const w = await h.owner();
    const before = await snapshotTables(h.prisma, ["entity", "entity_member", "store_member"]);
    const first = await h.prisma.store.findUniqueOrThrow({ where: { id: w.storeId } });
    expect(first.isPrimary).toBe(true);
    const result = await h.create(w);
    expect(StoreCardSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      name: BODY.name,
      isPrimary: false,
      lifecycle: "active",
      qualificationStatus: "unsubmitted",
      isLastSelected: false,
      submittedAt: null,
      verifiedAt: null,
    });
    expect((await h.tenant.listStores({ merchantUserId: w.userId })).items).toContainEqual(result);
    expect(
      await h.prisma.storeProfile.findUniqueOrThrow({ where: { storeId: result.storeId } }),
    ).toMatchObject({
      entityId: w.entityId,
      copiedFromStoreId: null,
      copyOptions: [],
      addressDetail: BODY.addressDetail,
      industryCode: BODY.industryCode,
      categoryCode: BODY.categoryCode,
    });
    expect(await h.prisma.store.findUniqueOrThrow({ where: { id: w.storeId } })).toEqual(first);
    expect(await snapshotTables(h.prisma, ["entity", "entity_member", "store_member"])).toEqual(
      before,
    );
    expect(
      await h.prisma.statusTransition.findMany({ where: { subjectId: result.storeId } }),
    ).toMatchObject([
      { event: "store.create", fromState: null, toState: "active", actorId: w.userId },
    ]);
    expect(await h.prisma.auditLog.count({ where: { targetId: result.storeId } })).toBe(1);
    expect(
      await h.prisma.outboxEvent.findMany({ where: { aggregateId: result.storeId } }),
    ).toMatchObject([
      {
        eventType: "store.created",
        payload: { isFirstStore: false, storeId: result.storeId, entityId: w.entityId },
      },
    ]);
    expect(h.validated).toHaveBeenCalledTimes(1);
    expect(h.initialized).toHaveBeenCalledTimes(1);
  });

  it("required 成功重放原卡、零外检及业务旁写；相同键body与上下文变更冲突", async () => {
    const w = await h.owner(),
      key = uuidv7();
    const card = await h.create(w, BODY, h.tenant, key),
      before = await h.state();
    expect(await h.create(w, BODY, h.tenant, key)).toEqual(card);
    expect(h.validated).toHaveBeenCalledTimes(1);
    expect(h.initialized).toHaveBeenCalledTimes(1);
    await expect(
      h.create(w, { ...BODY, addressDetail: "另一地址" }, h.tenant, key),
    ).rejects.toMatchObject({ error: "IDEMPOTENCY_KEY_REUSED" });
    await expect(
      h.create(
        w,
        BODY,
        h.tenant,
        key,
        createIdentityContext({
          ...w.ctx,
          storeId: card.storeId,
        }),
      ),
    ).rejects.toMatchObject({ error: "IDEMPOTENCY_KEY_REUSED" });
    expect(await h.state()).toEqual(before);
  });

  it.each(["override", "default", "plan"] as const)("%s 当前真实额度允许最后一格", async (mode) => {
    const w = await h.owner();
    await h.prisma.entity.update({
      where: { id: w.entityId },
      data: { storeLimitOverride: mode === "override" ? 2 : null },
    });
    if (mode === "default") await h.limit(2);
    if (mode === "plan") await h.make.subscriptionTerm({ entityId: w.entityId, maxStores: 2 });
    const before = await h.tx.run((tx) => h.tenant.getQuotaUsage(tx, w.entityId));
    expect(before).toMatchObject({
      storesUsed: 1,
      storeLimit: 2,
      limitReason: mode === "plan" ? "plan" : "inactive",
    });
    const card = await h.create(w);
    expect(card.lifecycle).toBe("active");
    expect(await h.tx.run((tx) => h.tenant.getQuotaUsage(tx, w.entityId))).toMatchObject({
      storesUsed: 2,
      storesOver: 0,
    });
    const state = await h.state();
    await expect(h.create(w)).rejects.toMatchObject({
      error: "STORE_LIMIT_REACHED",
      details: { storesUsed: 2, storeLimit: 2, limitReason: mode === "plan" ? "plan" : "inactive" },
    });
    expect(await h.state()).toEqual(state);
  });

  it("外检期间额度变化必须由settle重读，同键失败后可重试", async () => {
    const w = await h.owner(),
      key = uuidv7();
    const service = h.side(h.prisma, undefined, {
      validateBasics: async () => {
        await h.prisma.entity.update({
          where: { id: w.entityId },
          data: { storeLimitOverride: 1 },
        });
      },
    });
    await expect(h.create(w, BODY, service.tenant, key)).rejects.toMatchObject({
      error: "STORE_LIMIT_REACHED",
    });
    expect(await h.prisma.store.count({ where: { entityId: w.entityId } })).toBe(1);
    await h.prisma.entity.update({ where: { id: w.entityId }, data: { storeLimitOverride: 2 } });
    expect(await h.create(w, BODY, h.tenant, key)).toMatchObject({ lifecycle: "active" });
  });

  it.each(["clerk", "removed", "disabled", "foreign", "no_context"] as const)(
    "%s 当前真实权限拒绝，零外检/初始化",
    async (mode) => {
      const w = await h.owner();
      let ctx = w.ctx,
        principal = w.principal;
      if (mode === "clerk") {
        const clerk = await h.clerk(w);
        ctx = clerk.ctx;
        principal = clerk.principal;
      }
      if (mode === "removed")
        await h.prisma.entityMember.update({
          where: { id: w.memberId },
          data: {
            status: "removed",
            removedAt: h.clock.now(),
            removeReason: "by_owner",
            removeActorType: "merchant",
            removeActorId: w.userId,
            removeClient: "weapp",
            lastStoreId: null,
          },
        });
      if (mode === "disabled")
        await h.prisma.merchantUser.update({
          where: { id: w.userId },
          data: { status: "disabled" },
        });
      if (mode === "foreign") {
        const other = await h.owner();
        ctx = createIdentityContext({ ...w.ctx, entityId: other.entityId, storeId: other.storeId });
      }
      if (mode === "no_context") ctx = createIdentityContext({ actor: w.ctx.actor });
      const before = await h.state();
      await expect(
        h.tenant.createStore(ctx, BODY, { principal, idem: storeIdem(ctx, BODY) }),
      ).rejects.toMatchObject({
        error: mode === "clerk" ? "ROLE_FORBIDDEN" : "NOT_A_MEMBER",
      });
      expect(h.validated).not.toHaveBeenCalled();
      expect(h.initialized).not.toHaveBeenCalled();
      expect(await h.state()).toEqual(before);
    },
  );

  it.each(["idle", "absolute", "revoked"] as const)(
    "%s 会话事实不因已成功幂等而复活",
    async (kind) => {
      const w = await h.owner(),
        key = uuidv7(),
        start = h.clock.now();
      await h.create(w, BODY, h.tenant, key);
      const session = await h.prisma.userSession.findUniqueOrThrow({
        where: { id: w.principal.sessionId },
      });
      if (kind === "revoked")
        await h.identity.logout(w.principal, {
          requestId: uuidv7(),
          ip: "203.0.113.59",
          userAgent: "公开退出",
          clientVersion: null,
        });
      else {
        const at = kind === "idle" ? session.idleExpiresAt : session.absoluteExpiresAt;
        if (kind === "absolute")
          await h.prisma.userSession.update({
            where: { id: session.id },
            data: { idleExpiresAt: new Date(at.getTime() + 1) },
          });
        h.clock.set(at);
      }
      try {
        const before = await h.state(),
          checked = h.validated.mock.calls.length;
        await expect(h.create(w, BODY, h.tenant, key)).rejects.toMatchObject({
          error: "SESSION_INVALID",
        });
        expect(h.validated).toHaveBeenCalledTimes(checked);
        expect(await h.state()).toEqual(before);
      } finally {
        h.clock.set(start);
      }
    },
  );

  it.each(["foreign", "missing", "draft_deleted", "by_owner"] as const)(
    "复制来源%s只沿真实同主体事实",
    async (mode) => {
      const w = await h.owner(),
        other = await h.owner();
      const source =
        mode === "foreign"
          ? other.storeId
          : mode === "missing"
            ? uuidv7()
            : (
                await h.make.store({
                  entityId: w.entityId,
                  ...(mode === "draft_deleted" || mode === "by_owner"
                    ? {
                        lifecycle: "archived",
                        archivedAt: h.clock.now(),
                        archiveReason: mode,
                        archiveActorType: "merchant",
                        archiveActorId: w.userId,
                        archiveClient: "weapp",
                      }
                    : {}),
                })
              ).id;
      const input = { ...BODY, copyFromStoreId: source, copyOptions: ["basic"] as ["basic"] };
      const before = await h.state();
      if (mode === "by_owner") {
        const card = await h.create(w, input);
        expect(
          await h.prisma.storeProfile.findUniqueOrThrow({ where: { storeId: card.storeId } }),
        ).toMatchObject({ copiedFromStoreId: source, copyOptions: ["basic"] });
      } else {
        await expect(h.create(w, input)).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
        expect(await h.state()).toEqual(before);
      }
    },
  );

  it.each(["external", "after_initialize", "final_session"] as const)(
    "%s 失败保整笔业务回滚与原错误",
    async (stage) => {
      const w = await h.owner(),
        before = await h.state(),
        start = h.clock.now();
      const session = await h.prisma.userSession.findUniqueOrThrow({
        where: { id: w.principal.sessionId },
      });
      const side = h.side(
        h.prisma,
        undefined,
        stage === "external"
          ? {
              validateBasics: async () => {
                throw new AppError("PROVIDER_UNAVAILABLE");
              },
            }
          : {
              initialize: async (...args) => {
                await h.ports.initialize(...args);
                if (stage === "after_initialize") throw new AppError("FILE_NOT_USABLE");
                h.clock.set(session.idleExpiresAt);
              },
            },
      );
      try {
        await expect(h.create(w, BODY, side.tenant)).rejects.toMatchObject({
          error:
            stage === "external"
              ? "PROVIDER_UNAVAILABLE"
              : stage === "after_initialize"
                ? "FILE_NOT_USABLE"
                : "SESSION_INVALID",
        });
        expect(await h.state()).toEqual(before);
      } finally {
        h.clock.set(start);
      }
    },
  );

  it("调用者与外检参数修改不改变写入快照，typed初始化收到真实目标与固定初值", async () => {
    const w = await h.owner(),
      input = { ...BODY },
      key = uuidv7();
    const side = h.side(h.prisma, undefined, {
      validateBasics: async (_ctx, _principal, external) => {
        external.name = "外部参数污染";
        input.name = "调用者参数污染";
      },
    });
    const card = await h.create(w, input, side.tenant, key);
    expect(card.name).toBe(BODY.name);
    expect(h.initialized.mock.calls[0]![3]).toEqual({
      contextStoreId: w.storeId,
      targetStoreId: card.storeId,
      copyFromStoreId: null,
      copyOptions: [],
      initial: {
        addressDetail: BODY.addressDetail,
        industryCode: BODY.industryCode,
        categoryCode: BODY.categoryCode,
      },
    });
  });

  it("伪造flow创建和授权布尔不能替代私有sameTx凭据", async () => {
    const w = await h.owner(),
      before = await h.state(),
      id = uuidv7();
    await expect(
      h.tx.run(async (tx) => {
        await tx.store.create({
          data: {
            id,
            entityId: w.entityId,
            name: BODY.name,
            isPrimary: false,
            createdAt: h.clock.now(),
            updatedAt: h.clock.now(),
          },
        });
        await h.flow.transition(tx, w.ctx, {
          machine: "store",
          stateField: "lifecycle",
          id,
          entityId: w.entityId,
          storeId: id,
          event: "store.create",
          created: true,
          args: { locksHeld: true, authorized: true },
          emit: {
            type: "store.created",
            payload: { v: 1, storeId: id, entityId: w.entityId, isFirstStore: false },
          },
        });
      }),
    ).rejects.toThrow();
    expect(await h.state()).toEqual(before);
  });

  it("缺required幂等或缺新端口在业务写入前失败，旧构造不影响其他用例", async () => {
    const w = await h.owner(),
      before = await h.state();
    await expect(h.tenant.createStore(w.ctx, BODY, { principal: w.principal })).rejects.toThrow(
      TypeError,
    );
    const old = createTenant(h);
    await expect(h.create(w, BODY, old)).rejects.toMatchObject({ error: "INTERNAL" });
    expect(
      await old.resolveMembership(h.prisma, { merchantUserId: w.userId, storeId: w.storeId }),
    ).toMatchObject({ role: "owner" });
    expect(h.validated).not.toHaveBeenCalled();
    expect(await h.state()).toEqual(before);
  });
});
