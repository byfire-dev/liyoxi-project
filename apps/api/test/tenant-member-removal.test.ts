// W2-10："m.member.remove"、"m.me.membership.leave" 走真实生产处理器与每请求成员鉴权。
import { MemberRemovalResultSchema } from "@liyoxi/contract";
import { createIdentityContext, uuidv7 } from "@liyoxi/services";
import { createFactories } from "@liyoxi/services/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";

const testApi = useTestApi();
let api: TestApi;
beforeAll(async () => {
  api = await testApi.start();
  await seedUserAgreements(testApi, api);
}, 180_000);

async function world() {
  const owner = await signInAsMerchant(api);
  const created = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  const clerk = await signInAsMerchant(api);
  const db = await testApi.db.prisma();
  const make = createFactories({ db, clock: api.clock });
  // 邀请接受尚未交付，只用合法历史关系作为两条退出入口的前提。
  const member = await make.entityMember({
    entityId: created.entityId,
    merchantUserId: clerk.merchantUserId,
    invitedByMemberId: created.memberId,
    lastStoreId: created.storeId,
  });
  await make.storeMember({
    entityMemberId: member.id,
    storeId: created.storeId,
    addedByMemberId: created.memberId,
  });
  return { owner, clerk, db, make, ...created, clerkMemberId: member.id };
}

const path = (memberId?: string) =>
  memberId === undefined ? "/m/me/membership/leave" : `/m/members/${memberId}/remove`;

async function post(
  endpoint: string,
  headers: Record<string, string>,
  key: string | null = uuidv7(),
) {
  const response = await api.request(`/api/v1${endpoint}`, {
    method: "POST",
    headers: { ...headers, ...(key === null ? {} : { "Idempotency-Key": key }) },
  });
  return {
    response,
    body: (await response.json()) as { error?: string; data?: unknown },
  };
}

async function trace(memberId: string) {
  const db = await testApi.db.prisma();
  const [member, stores, history, audits, events] = await Promise.all([
    db.entityMember.findUniqueOrThrow({ where: { id: memberId } }),
    db.storeMember.findMany({ where: { entityMemberId: memberId } }),
    db.statusTransition.findMany({ where: { subjectId: memberId, machine: "entity_member" } }),
    db.auditLog.findMany({ where: { targetId: memberId } }),
    db.outboxEvent.findMany({ where: { aggregateId: memberId } }),
  ]);
  return { member, stores, history, audits, events };
}

async function assertLostMembership(clerk: SignedInMerchant, storeId: string) {
  const me = await api.request("/api/v1/m/me", { headers: clerk.headers });
  expect(me.status).toBe(200);
  expect((await me.json()) as { data: unknown }).toMatchObject({ data: { memberships: [] } });
  const stores = await api.request("/api/v1/m/stores", { headers: clerk.headers });
  expect(stores.status).toBe(200);
  expect(await stores.json()).toMatchObject({ data: { viewerRole: "none" } });
  const current = await api.request("/api/v1/m/me/overview", {
    headers: clerk.withStore(storeId),
  });
  expect(current.status).toBe(403);
  expect(await current.json()).toMatchObject({ error: "NOT_A_MEMBER" });
}

describe("成员退出 HTTP", { timeout: 120_000 }, () => {
  it.each(["remove", "leave"] as const)(
    "%s：成功落库并立即失去原门店权限，用户会话仍可用",
    async (mode) => {
      const w = await world();
      const second = await w.make.store({ entityId: w.entityId });
      await w.make.storeMember({
        entityMemberId: w.clerkMemberId,
        storeId: second.id,
        addedByMemberId: w.memberId,
      });
      const before = await trace(w.clerkMemberId);
      const actor = mode === "remove" ? w.owner : w.clerk;
      const result = await post(
        path(mode === "remove" ? w.clerkMemberId : undefined),
        actor.withStore(w.storeId),
      );
      expect(result.response.status, JSON.stringify(result.body)).toBe(200);
      expect(result.response.headers.get("cache-control")).toBe("no-store");
      const data = MemberRemovalResultSchema.parse(result.body.data);
      expect(data).toEqual({
        memberId: w.clerkMemberId,
        status: "removed",
        removedAt: api.clock.now().toISOString(),
      });
      expect(Object.keys(data).sort()).toEqual(["memberId", "removedAt", "status"]);
      const after = await trace(w.clerkMemberId);
      expect(after.member).toMatchObject({
        status: "removed",
        removedAt: api.clock.now(),
        removeActorType: "merchant",
        removeActorId: actor.merchantUserId,
        removeClient: "weapp",
        removeReason: mode === "remove" ? "by_owner" : "self",
        lastStoreId: null,
      });
      expect(after.stores).toEqual([]);
      expect(after.history).toHaveLength(before.history.length + 1);
      expect(after.audits).toHaveLength(before.audits.length + 1);
      expect(after.events).toHaveLength(before.events.length + 1);
      expect(after.events.at(-1)).toMatchObject({
        eventType: "entity_member.removed",
        actorType: "merchant",
        actorId: actor.merchantUserId,
        client: "weapp",
        payload: {
          v: 1,
          entityMemberId: w.clerkMemberId,
          entityId: w.entityId,
          merchantUserId: w.clerk.merchantUserId,
          role: "clerk",
          removeReason: mode === "remove" ? "by_owner" : "self",
        },
      });
      expect(
        (await w.db.entityMember.findUniqueOrThrow({ where: { id: w.memberId } })).status,
      ).toBe("active");
      await assertLostMembership(w.clerk, w.storeId);
      const secondDenied = await api.request("/api/v1/m/me/overview", {
        headers: w.clerk.withStore(second.id),
      });
      expect(secondDenied.status).toBe(403);
      expect(await secondDenied.json()).toMatchObject({ error: "NOT_A_MEMBER" });
    },
  );

  it("m.member.remove：老板同键重放保持原响应，异键再次移除返回状态冲突", async () => {
    const w = await world();
    const key = uuidv7();
    const first = await post(path(w.clerkMemberId), w.owner.withStore(w.storeId), key);
    expect(first.response.status).toBe(200);
    const saved = await trace(w.clerkMemberId);
    api.clock.advance(60_000);
    const replay = await post(path(w.clerkMemberId), w.owner.withStore(w.storeId), key);
    expect(replay.response.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    expect(await trace(w.clerkMemberId)).toEqual(saved);
    const repeated = await post(path(w.clerkMemberId), w.owner.withStore(w.storeId));
    expect(repeated.response.status).toBe(409);
    expect(repeated.body.error).toBe("STATE_NOT_ALLOWED");
    expect(await trace(w.clerkMemberId)).toEqual(saved);
  });

  it("m.me.membership.leave：成功后同键和异键均先过原成员中间件，不授予失权重放", async () => {
    const w = await world();
    const key = uuidv7();
    const first = await post(path(), w.clerk.withStore(w.storeId), key);
    expect(first.response.status).toBe(200);
    const saved = await trace(w.clerkMemberId);
    for (const next of [key, uuidv7()]) {
      const denied = await post(path(), w.clerk.withStore(w.storeId), next);
      expect(denied.response.status).toBe(403);
      expect(denied.body.error).toBe("NOT_A_MEMBER");
      expect(await trace(w.clerkMemberId)).toEqual(saved);
    }
  });

  it("同主体同一老板、同一幂等键改目标返回冲突，不碰另一个店员", async () => {
    const w = await world();
    const otherUser = await signInAsMerchant(api);
    const other = await w.make.entityMember({
      entityId: w.entityId,
      merchantUserId: otherUser.merchantUserId,
    });
    await w.make.storeMember({
      entityMemberId: other.id,
      storeId: w.storeId,
      addedByMemberId: w.memberId,
    });
    const key = uuidv7();
    expect(
      (await post(path(w.clerkMemberId), w.owner.withStore(w.storeId), key)).response.status,
    ).toBe(200);
    const before = await trace(other.id);
    const conflict = await post(path(other.id), w.owner.withStore(w.storeId), key);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await trace(other.id)).toEqual(before);
  });

  it("老板不能退出或被普通移除，店员不能使用老板移除入口", async () => {
    const w = await world();
    const before = await trace(w.memberId);
    const leave = await post(path(), w.owner.withStore(w.storeId));
    expect(leave.response.status).toBe(409);
    expect(leave.body.error).toBe("OWNER_CANNOT_LEAVE");
    const remove = await post(path(w.memberId), w.owner.withStore(w.storeId));
    expect(remove.response.status).toBe(409);
    expect(remove.body.error).toBe("STATE_NOT_ALLOWED");
    const clerk = await post(path(w.clerkMemberId), w.clerk.withStore(w.storeId));
    expect(clerk.response.status).toBe(403);
    expect(clerk.body.error).toBe("ROLE_FORBIDDEN");
    expect(await trace(w.memberId)).toEqual(before);
    expect((await trace(w.clerkMemberId)).member.status).toBe("active");
  });

  it("跨主体目标与不存在目标统一 404，外部门店头不给本主体权限", async () => {
    const w = await world();
    const foreign = await world();
    const before = await trace(foreign.clerkMemberId);
    for (const memberId of [foreign.clerkMemberId, uuidv7()]) {
      const denied = await post(path(memberId), w.owner.withStore(w.storeId));
      expect(denied.response.status).toBe(404);
      expect(denied.body.error).toBe("NOT_FOUND");
    }
    const scope = await post(path(w.clerkMemberId), w.owner.withStore(foreign.storeId));
    expect(scope.response.status).toBe(403);
    expect(scope.body.error).toBe("NOT_A_MEMBER");
    expect(await trace(foreign.clerkMemberId)).toEqual(before);
    expect((await trace(w.clerkMemberId)).member.status).toBe("active");
  });

  it.each(["remove", "leave"] as const)("%s：缺凭据或过期凭据不能进入用例", async (mode) => {
    const w = await world();
    const before = await trace(w.clerkMemberId);
    for (const [headers, error] of [
      [{}, "AUTH_REQUIRED"],
      [{ authorization: "Bearer expired", "x-store-id": w.storeId }, "SESSION_INVALID"],
    ] as const) {
      const denied = await post(path(mode === "remove" ? w.clerkMemberId : undefined), headers);
      expect(denied.response.status).toBe(401);
      expect(denied.body.error).toBe(error);
    }
    expect(await trace(w.clerkMemberId)).toEqual(before);
  });

  it.each(["remove", "leave"] as const)("%s：缺门店头或缺幂等键零业务写入", async (mode) => {
    const w = await world();
    const actor = mode === "remove" ? w.owner : w.clerk;
    const endpoint = path(mode === "remove" ? w.clerkMemberId : undefined);
    const before = await trace(w.clerkMemberId);
    const noStore = await post(endpoint, actor.headers);
    expect(noStore.response.status).toBe(403);
    expect(noStore.body.error).toBe("NOT_A_MEMBER");
    const noKey = await post(endpoint, actor.withStore(w.storeId), null);
    expect(noKey.response.status).toBe(400);
    expect(noKey.body.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(await trace(w.clerkMemberId)).toEqual(before);
  });

  it("m.member.remove：无效成员 UUID 由契约校验拒绝", async () => {
    const w = await world();
    const before = await trace(w.clerkMemberId);
    const invalid = await post(path("bad-member-id"), w.owner.withStore(w.storeId));
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.error).toBe("VALIDATION_FAILED");
    expect(await trace(w.clerkMemberId)).toEqual(before);
  });
});
