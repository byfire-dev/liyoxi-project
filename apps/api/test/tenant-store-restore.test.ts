import { StoreCardSchema } from "@liyoxi/contract";
import { createIdentityContext, uuidv7 } from "@liyoxi/services";
import { createFactories, snapshotTables } from "@liyoxi/services/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";

const testApi = useTestApi();
let api: TestApi;
beforeAll(async () => {
  api = await testApi.start();
  await seedUserAgreements(testApi, api);
}, 180_000);
const tables = [
  "store",
  "entity_member",
  "store_member",
  "invitation",
  "invitation_request",
  "timer",
  "status_transition",
  "audit_log",
  "outbox_event",
  "idempotency_record",
];
async function post(
  storeId: string,
  headers: Record<string, string>,
  key: string | null = uuidv7(),
  json?: unknown,
) {
  const response = await api.request(`/api/v1/m/stores/${storeId}/restore`, {
    method: "POST",
    headers: { ...headers, ...(key === null ? {} : { "Idempotency-Key": key }) },
    ...(json === undefined ? {} : { json }),
  });
  return {
    response,
    body: (await response.json()) as { data?: unknown; error?: string; details?: unknown },
  };
}
async function world(keepClerk = false) {
  const owner = await signInAsMerchant(api);
  const created = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  const db = await testApi.db.prisma();
  const make = createFactories({ db, clock: api.clock });
  await db.entity.update({ where: { id: created.entityId }, data: { storeLimitOverride: 2 } });
  const second = await make.store({
    id: `018fabcd${uuidv7().slice(8)}`,
    entityId: created.entityId,
  });
  const clerk = await signInAsMerchant(api);
  // 合法历史店员关系是权限前提；停用和恢复均经过真实 HTTP producer。
  const member = await make.entityMember({
    entityId: created.entityId,
    merchantUserId: clerk.merchantUserId,
    invitedByMemberId: created.memberId,
    lastStoreId: second.id,
  });
  for (const storeId of keepClerk ? [second.id, created.storeId] : [second.id])
    await make.storeMember({
      entityMemberId: member.id,
      storeId,
      addedByMemberId: created.memberId,
    });
  const archived = await api.request(`/api/v1/m/stores/${second.id}/archive`, {
    method: "POST",
    headers: { ...owner.withStore(created.storeId), "Idempotency-Key": uuidv7() },
  });
  expect(archived.status, JSON.stringify(await archived.json())).toBe(200);
  return { owner, clerk, member, second, db, make, ...created };
}

describe("m.store.restore", { timeout: 120_000 }, () => {
  it.each(["active", "archived_target"] as const)(
    "%s 上下文无 body 恢复，完整老板卡与旧店员失权事实保持",
    async (context) => {
      const w = await world();
      const before = await snapshotTables(w.db, ["entity_member", "store_member"]);
      const audits = await w.db.auditLog.count({ where: { targetId: w.second.id } });
      const result = await post(
        w.second.id,
        w.owner.withStore(context === "active" ? w.storeId : w.second.id),
      );
      expect(result.response.status, JSON.stringify(result.body)).toBe(200);
      expect(result.response.headers.get("cache-control")).toBe("no-store");
      const card = StoreCardSchema.parse(result.body.data);
      expect(result.body.data).toEqual(card);
      expect(card).toMatchObject({
        storeId: w.second.id,
        name: w.second.name,
        isPrimary: false,
        lifecycle: "active",
        archiveReason: null,
        archivedAt: null,
        qualificationStatus: "unsubmitted",
        clerkCount: 0,
        pendingInvitationCount: 0,
        actions: ["archive", "delete"],
      });
      expect(await w.db.store.findUniqueOrThrow({ where: { id: w.second.id } })).toMatchObject({
        lifecycle: "active",
        archivedAt: null,
        archiveActorType: null,
        archiveActorId: null,
        archiveClient: null,
        archiveReason: null,
      });
      expect(await snapshotTables(w.db, ["entity_member", "store_member"])).toEqual(before);
      expect(
        await w.db.entityMember.findUniqueOrThrow({ where: { id: w.member.id } }),
      ).toMatchObject({
        status: "removed",
        removeReason: "store_archived",
        lastStoreId: null,
      });
      expect(await w.db.storeMember.count({ where: { storeId: w.second.id } })).toBe(0);
      expect(
        await w.db.statusTransition.count({
          where: { subjectId: w.second.id, event: "store.restore" },
        }),
      ).toBe(1);
      expect(await w.db.auditLog.count({ where: { targetId: w.second.id } })).toBe(audits + 1);
      expect(
        await w.db.outboxEvent.findMany({
          where: { aggregateId: w.second.id, eventType: "store.restored" },
        }),
      ).toMatchObject([{ payload: { v: 1, storeId: w.second.id, entityId: w.entityId } }]);
      const me = await api.request("/api/v1/m/me", { headers: w.clerk.headers });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ data: { memberships: [] } });
      const removedClerk = await post(w.second.id, w.clerk.withStore(w.second.id));
      expect(removedClerk.response.status).toBe(403);
      expect(removedClerk.body.error).toBe("NOT_A_MEMBER");
      const denied = await api.request("/api/v1/m/me/overview", {
        headers: w.clerk.withStore(w.second.id),
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ error: "NOT_A_MEMBER" });
    },
  );

  it("required 同键空 body 重放无业务旁写；路径、XStore 和 body 改动均冲突", async () => {
    const w = await world(),
      key = uuidv7();
    const first = await post(w.second.id, w.owner.withStore(w.storeId), key);
    expect(first.response.status).toBe(200);
    const before = await snapshotTables(w.db, tables);
    const replay = await post(
      w.second.id,
      {
        ...w.owner.withStore(w.storeId),
        "Content-Type": "application/json",
      },
      key,
    );
    expect(replay.response.status).toBe(200);
    expect(replay.response.headers.get("Idempotent-Replayed")).toBe("true");
    expect(replay.body).toEqual(first.body);
    for (const [target, headers, body] of [
      [w.storeId, w.owner.withStore(w.storeId), undefined],
      [w.second.id, w.owner.withStore(w.second.id), undefined],
      [w.second.id, w.owner.withStore(w.storeId), { force: true }],
    ] as const) {
      const result = await post(target, headers, key, body);
      expect(result.response.status).toBe(409);
      expect(result.body.error).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    expect(await snapshotTables(w.db, tables)).toEqual(before);
    const other = await post(w.second.id, w.owner.withStore(w.storeId));
    expect(other.response.status).toBe(409);
    expect(other.body.error).toBe("STATE_NOT_ALLOWED");
    expect(await snapshotTables(w.db, tables)).toEqual(before);
  });

  it.each([
    "guest",
    "unbound",
    "clerk",
    "foreign",
    "missing",
    "no_store",
    "no_idem",
    "bad_idem",
    "bad_id",
    "uppercase_id",
    "active_target",
    "draft_deleted",
  ] as const)("%s 沿正式鉴权和状态边界拒绝且业务零写", async (mode) => {
    const w = await world(mode === "clerk");
    const outsider = mode === "unbound" ? await signInAsMerchant(api) : null;
    const extra =
      mode === "foreign"
        ? await w.make.store()
        : mode === "draft_deleted"
          ? await w.make.store({
              entityId: w.entityId,
              lifecycle: "archived",
              archivedAt: api.clock.now(),
              archiveReason: "draft_deleted",
              archiveActorType: "merchant",
              archiveActorId: w.owner.merchantUserId,
              archiveClient: "weapp",
            })
          : null;
    const headers =
      mode === "guest"
        ? {}
        : mode === "unbound"
          ? outsider!.withStore(w.storeId)
          : mode === "clerk"
            ? w.clerk.withStore(w.storeId)
            : mode === "no_store"
              ? w.owner.headers
              : w.owner.withStore(w.storeId);
    const target =
      extra?.id ??
      (mode === "missing"
        ? uuidv7()
        : mode === "bad_id"
          ? "bad"
          : mode === "uppercase_id"
            ? w.second.id.toUpperCase()
            : mode === "active_target"
              ? w.storeId
              : w.second.id);
    const before = await snapshotTables(w.db, tables);
    const result = await post(
      target,
      headers,
      mode === "no_idem" ? null : mode === "bad_idem" ? "!" : uuidv7(),
    );
    const [status, error] = {
      guest: [401, "AUTH_REQUIRED"],
      unbound: [403, "NOT_A_MEMBER"],
      clerk: [403, "ROLE_FORBIDDEN"],
      foreign: [404, "NOT_FOUND"],
      missing: [404, "NOT_FOUND"],
      no_store: [403, "NOT_A_MEMBER"],
      no_idem: [400, "IDEMPOTENCY_KEY_REQUIRED"],
      bad_idem: [400, "IDEMPOTENCY_KEY_REQUIRED"],
      bad_id: [400, "VALIDATION_FAILED"],
      uppercase_id: [400, "VALIDATION_FAILED"],
      active_target: [409, "STATE_NOT_ALLOWED"],
      draft_deleted: [404, "NOT_FOUND"],
    }[mode];
    expect(result.response.status).toBe(status);
    expect(result.body.error).toBe(error);
    expect(await snapshotTables(w.db, tables)).toEqual(before);
  });

  it("真实额度失败只给正式三键，失败不缓存；额度恢复后同键可以成功", async () => {
    const w = await world(),
      key = uuidv7();
    await w.db.entity.update({ where: { id: w.entityId }, data: { storeLimitOverride: 1 } });
    const before = await snapshotTables(w.db, tables);
    const limited = await post(w.second.id, w.owner.withStore(w.storeId), key);
    expect(limited.response.status).toBe(409);
    expect(limited.body.error).toBe("STORE_LIMIT_REACHED");
    expect(limited.body.details).toEqual({ storesUsed: 1, storeLimit: 1, limitReason: "inactive" });
    expect(await snapshotTables(w.db, tables)).toEqual(before);
    await w.db.entity.update({ where: { id: w.entityId }, data: { storeLimitOverride: 2 } });
    const restored = await post(w.second.id, w.owner.withStore(w.storeId), key);
    expect(restored.response.status).toBe(200);
    expect(StoreCardSchema.parse(restored.body.data).lifecycle).toBe("active");
  });
});
