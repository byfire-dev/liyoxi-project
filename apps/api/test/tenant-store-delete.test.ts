import { mStoreAssetCreate, StoreDeleteResultSchema } from "@liyoxi/contract";
import { createIdentityContext, uuidv7 } from "@liyoxi/services";
import { createFactories, signInAsStaff, snapshotTables } from "@liyoxi/services/testing";
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
  "store_asset",
  "store_asset_file",
  "store_asset_insight",
  "store_asset_usage",
  "media_job",
];
async function post(
  storeId: string,
  headers: Record<string, string>,
  key: string | null = uuidv7(),
  json?: unknown,
) {
  const response = await api.request(`/api/v1/m/stores/${storeId}/delete`, {
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
  const db = await testApi.db.prisma(),
    make = createFactories({ db, clock: api.clock });
  // 第二家未提交草稿是合法历史前提；本片只验证实际删除入口。
  const target = await make.store({
    id: `018fabcd${uuidv7().slice(8)}`,
    entityId: created.entityId,
  });
  const clerk = await signInAsMerchant(api);
  const member = await make.entityMember({
    entityId: created.entityId,
    merchantUserId: clerk.merchantUserId,
    invitedByMemberId: created.memberId,
    lastStoreId: target.id,
  });
  for (const storeId of keepClerk ? [target.id, created.storeId] : [target.id])
    await make.storeMember({
      entityMemberId: member.id,
      storeId,
      addedByMemberId: created.memberId,
    });
  return { owner, clerk, member, target, db, make, ...created };
}

describe("m.store.delete 真实 HTTP", { timeout: 120_000 }, () => {
  it.each([false, true])(
    "完整真实装配删除，保留其他店范围=%s，两个原事件各一次",
    async (keepClerk) => {
      const w = await world(keepClerk);
      const audits = await w.db.auditLog.count({ where: { targetId: w.target.id } });
      const ownerBefore = await w.db.entityMember.findUniqueOrThrow({ where: { id: w.memberId } });
      const result = await post(w.target.id, w.owner.withStore(w.storeId));
      expect(result.response.status, JSON.stringify(result.body)).toBe(200);
      expect(result.response.headers.get("cache-control")).toBe("no-store");
      const dto = StoreDeleteResultSchema.parse(result.body.data);
      expect(result.body.data).toEqual(dto);
      expect(Object.keys(dto).sort()).toEqual(["deletedAt", "storeId"]);
      expect(dto.storeId).toBe(w.target.id);
      const target = await w.db.store.findUniqueOrThrow({ where: { id: w.target.id } });
      expect(target).toMatchObject({
        lifecycle: "archived",
        archiveReason: "draft_deleted",
        archiveActorType: "merchant",
        archiveActorId: w.owner.merchantUserId,
        archiveClient: "weapp",
      });
      expect(target.archivedAt?.toISOString()).toBe(dto.deletedAt);
      expect(await w.db.storeMember.count({ where: { storeId: w.target.id } })).toBe(0);
      expect(
        await w.db.entityMember.findUniqueOrThrow({ where: { id: w.member.id } }),
      ).toMatchObject({
        status: keepClerk ? "active" : "removed",
        lastStoreId: null,
        removeReason: keepClerk ? null : "store_archived",
      });
      expect(
        await w.db.storeMember.count({
          where: { entityMemberId: w.member.id, storeId: w.storeId },
        }),
      ).toBe(keepClerk ? 1 : 0);
      expect(await w.db.entityMember.findUniqueOrThrow({ where: { id: w.memberId } })).toEqual(
        ownerBefore,
      );
      expect((await w.db.store.findUniqueOrThrow({ where: { id: w.storeId } })).lifecycle).toBe(
        "active",
      );
      expect(
        await w.db.statusTransition.count({
          where: { subjectId: w.target.id, event: "store.draft_delete" },
        }),
      ).toBe(1);
      expect(await w.db.auditLog.count({ where: { targetId: w.target.id } })).toBe(audits + 1);
      for (const eventType of ["store.archived", "store.draft_deleted"])
        expect(
          await w.db.outboxEvent.findMany({ where: { aggregateId: w.target.id, eventType } }),
        ).toMatchObject([{ payload: { v: 1, storeId: w.target.id, entityId: w.entityId } }]);
      const me = await api.request("/api/v1/m/me", { headers: w.clerk.headers });
      expect(me.status).toBe(200);
      if (!keepClerk) expect(await me.json()).toMatchObject({ data: { memberships: [] } });
      const denied = await post(w.target.id, w.clerk.withStore(w.target.id));
      expect(denied.response.status).toBe(403);
      expect(denied.body.error).toBe("NOT_A_MEMBER");
      for (const action of ["archive", "restore"]) {
        const response = await api.request(`/api/v1/m/stores/${w.target.id}/${action}`, {
          method: "POST",
          headers: { ...w.owner.withStore(w.storeId), "Idempotency-Key": uuidv7() },
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: "NOT_FOUND" });
      }
    },
  );

  it("有效非目标上下文同键空 body 原样重放，路径与 body 改变均冲突且零旁写", async () => {
    const w = await world(),
      key = uuidv7();
    const first = await post(w.target.id, w.owner.withStore(w.storeId), key);
    expect(first.response.status).toBe(200);
    const before = await snapshotTables(w.db, tables);
    const replay = await post(
      w.target.id,
      { ...w.owner.withStore(w.storeId), "Content-Type": "application/json" },
      key,
    );
    expect(replay.response.status).toBe(200);
    expect(replay.response.headers.get("Idempotent-Replayed")).toBe("true");
    expect(replay.body).toEqual(first.body);
    for (const [target, body] of [
      [w.storeId, undefined],
      [w.target.id, { force: true }],
    ] as const) {
      const conflict = await post(target, w.owner.withStore(w.storeId), key, body);
      expect(conflict.response.status).toBe(409);
      expect(conflict.body.error).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    const missing = await post(w.target.id, w.owner.withStore(w.storeId));
    expect(missing.response.status).toBe(404);
    expect(missing.body.error).toBe("NOT_FOUND");
    expect(await snapshotTables(w.db, tables)).toEqual(before);
  });

  it("目标作上下文删除后立即失权；原键不绕过鉴权，换有效店仍是请求冲突", async () => {
    const w = await world(),
      key = uuidv7();
    expect((await post(w.target.id, w.owner.withStore(w.target.id), key)).response.status).toBe(
      200,
    );
    const before = await snapshotTables(w.db, tables);
    const lost = await post(w.target.id, w.owner.withStore(w.target.id), key);
    expect(lost.response.status).toBe(403);
    expect(lost.body.error).toBe("NOT_A_MEMBER");
    const changed = await post(w.target.id, w.owner.withStore(w.storeId), key);
    expect(changed.response.status).toBe(409);
    expect(changed.body.error).toBe("IDEMPOTENCY_KEY_REUSED");
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
    "archived",
    "draft_deleted",
  ] as const)("%s 按正式鉴权、路径及状态拒绝且业务零写", async (mode) => {
    const w = await world(true);
    const outsider = mode === "unbound" ? await signInAsMerchant(api) : null;
    const extra =
      mode === "foreign"
        ? await w.make.store()
        : ["archived", "draft_deleted"].includes(mode)
          ? await w.make.store({
              entityId: w.entityId,
              lifecycle: "archived",
              archivedAt: api.clock.now(),
              archiveReason: mode === "draft_deleted" ? "draft_deleted" : "by_owner",
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
            ? w.target.id.toUpperCase()
            : w.target.id);
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
      archived: [409, "STATE_NOT_ALLOWED"],
      draft_deleted: [404, "NOT_FOUND"],
    }[mode];
    expect(result.response.status).toBe(status);
    expect(result.body.error).toBe(error);
    expect(await snapshotTables(w.db, tables)).toEqual(before);
  });

  it("最后一家门店拒绝，保留原 lastActive 优先级与完整零写", async () => {
    const w = await world();
    const archived = await api.request(`/api/v1/m/stores/${w.target.id}/archive`, {
      method: "POST",
      headers: { ...w.owner.withStore(w.storeId), "Idempotency-Key": uuidv7() },
    });
    expect(archived.status, await archived.clone().text()).toBe(200);
    const before = await snapshotTables(w.db, tables);
    const result = await post(w.storeId, w.owner.withStore(w.storeId));
    expect(result.response.status).toBe(409);
    expect(result.body.error).toBe("LAST_ACTIVE_STORE");
    expect(await snapshotTables(w.db, tables)).toEqual(before);
  });

  it("真实原创素材使完整组合根拒删，失败不缓存；实际软删除后原键可重试成功", async () => {
    const w = await world(),
      key = uuidv7();
    const uploaded = await api.request("/api/v1/m/store-assets", {
      method: "POST",
      headers: { ...w.owner.withStore(w.target.id), "Idempotency-Key": uuidv7() },
      json: { type: "text", textBody: "待删除草稿门店的真实原创素材" },
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    const asset = mStoreAssetCreate.responses[200].content[
      "application/json"
    ].schema.shape.data.parse(((await uploaded.json()) as { data: unknown }).data);
    expect(asset.replayed).toBe(false);
    const before = await snapshotTables(w.db, tables);
    const rejected = await post(w.target.id, w.owner.withStore(w.storeId), key);
    expect(rejected.response.status).toBe(409);
    expect(rejected.body).toMatchObject({
      error: "STORE_NOT_DRAFT",
      details: { reasons: ["has_business_data"] },
    });
    expect(rejected.body.details).toEqual({ reasons: ["has_business_data"] });
    expect(await snapshotTables(w.db, tables)).toEqual(before);
    expect(await w.db.idempotencyRecord.count({ where: { scope: "m.store.delete", key } })).toBe(0);
    const admin = await signInAsStaff(w.db, { roleKey: "super_admin", now: api.clock.now() });
    const removed = await api.request(`/api/v1/admin/store-assets/${asset.storeAssetId}/delete`, {
      method: "POST",
      headers: { ...admin.headers, "Idempotency-Key": uuidv7() },
      json: { reasonText: "真实软删除后重试门店草稿删除" },
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const assetBefore = await w.db.storeAsset.findUniqueOrThrow({
      where: { id: asset.storeAssetId },
    });
    expect(assetBefore.deletedAt).not.toBeNull();
    const retry = await post(w.target.id, w.owner.withStore(w.storeId), key);
    expect(retry.response.status, JSON.stringify(retry.body)).toBe(200);
    expect(StoreDeleteResultSchema.parse(retry.body.data).storeId).toBe(w.target.id);
    expect(await w.db.storeAsset.findUniqueOrThrow({ where: { id: asset.storeAssetId } })).toEqual(
      assetBefore,
    );
  });
});
