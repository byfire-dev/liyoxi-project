import { StoreArchiveResultSchema } from "@liyoxi/contract";
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
async function world() {
  const owner = await signInAsMerchant(api);
  const created = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  const prisma = await testApi.db.prisma();
  const make = createFactories({ db: prisma, clock: api.clock });
  const second = await make.store({ entityId: created.entityId });
  const clerk = await signInAsMerchant(api);
  // 接受邀请尚未接纳；合法历史成员关系只作为本片权限前提。
  const member = await make.entityMember({
    entityId: created.entityId,
    merchantUserId: clerk.merchantUserId,
    invitedByMemberId: created.memberId,
    lastStoreId: second.id,
  });
  await make.storeMember({
    entityMemberId: member.id,
    storeId: second.id,
    addedByMemberId: created.memberId,
  });
  return { owner, clerk, member, second, make, prisma, ...created };
}
async function post(id: string, headers: Record<string, string>, key: string | null = uuidv7()) {
  const response = await api.request(`/api/v1/m/stores/${id}/archive`, {
    method: "POST",
    headers: { ...headers, ...(key ? { "Idempotency-Key": key } : {}) },
  });
  return {
    response,
    body: (await response.json()) as { data?: unknown; error?: string; details?: unknown },
  };
}
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
];

describe("m.store.archive", { timeout: 120_000 }, () => {
  it("老板真实入口返回完整卡与清理数量，店员立即失权，会话与老板归档访问保持", async () => {
    const w = await world();
    const historyBefore = await w.prisma.statusTransition.count({
      where: { entityId: w.entityId },
    });
    const result = await post(w.second.id, w.owner.withStore(w.storeId));
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    const data = StoreArchiveResultSchema.parse(result.body.data);
    expect(data).toMatchObject({
      store: {
        storeId: w.second.id,
        lifecycle: "archived",
        archiveReason: "by_owner",
        actions: ["restore"],
      },
      removedMemberCount: 1,
      revokedInvitationCount: 0,
    });
    expect(
      (await w.prisma.entityMember.findUniqueOrThrow({ where: { id: w.member.id } })).removeReason,
    ).toBe("store_archived");
    expect(await w.prisma.storeMember.count({ where: { storeId: w.second.id } })).toBe(0);
    expect(await w.prisma.statusTransition.count({ where: { entityId: w.entityId } })).toBe(
      historyBefore + 2,
    );
    const me = await api.request("/api/v1/m/me", { headers: w.clerk.headers });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ data: { memberships: [] } });
    const denied = await api.request("/api/v1/m/me/overview", {
      headers: w.clerk.withStore(w.second.id),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "NOT_A_MEMBER" });
    const stores = await api.request("/api/v1/m/stores", { headers: w.owner.headers });
    expect(stores.status).toBe(200);
    expect(await stores.json()).toMatchObject({
      data: { viewerRole: "owner", items: expect.arrayContaining([{ ...data.store }]) },
    });
    const archivedWrite = await post(w.storeId, w.owner.withStore(w.second.id));
    expect(archivedWrite.response.status).toBe(403);
    expect(archivedWrite.body.error).toBe("STORE_ARCHIVED");
  });

  it("required 同键重放保持首次结果/业务零旁写，其他请求体冲突沿内核", async () => {
    const w = await world(),
      key = uuidv7();
    const first = await post(w.second.id, w.owner.withStore(w.storeId), key);
    expect(first.response.status).toBe(200);
    const before = await snapshotTables(w.prisma, tables);
    const again = await post(w.second.id, w.owner.withStore(w.storeId), key);
    expect(again.response.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await snapshotTables(w.prisma, tables)).toEqual(before);
    const conflict = await post(w.storeId, w.owner.withStore(w.storeId), key);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await snapshotTables(w.prisma, tables)).toEqual(before);
    const other = await post(w.second.id, w.owner.withStore(w.storeId));
    expect(other.response.status).toBe(409);
    expect(other.body.error).toBe("STATE_NOT_ALLOWED");
  });

  it.each([
    "guest",
    "unbound",
    "clerk",
    "foreign",
    "missing",
    "no_store",
    "no_idem",
    "bad_id",
  ] as const)("%s 在原鉴权/契约边界拒绝且业务零写", async (mode) => {
    const w = await world();
    const outsider = await signInAsMerchant(api);
    const other = mode === "foreign" ? await world() : null;
    const headers =
      mode === "guest"
        ? {}
        : mode === "unbound"
          ? outsider.withStore(w.storeId)
          : mode === "clerk"
            ? w.clerk.withStore(w.second.id)
            : mode === "no_store"
              ? w.owner.headers
              : w.owner.withStore(w.storeId);
    const id =
      mode === "foreign"
        ? other!.second.id
        : mode === "missing"
          ? uuidv7()
          : mode === "bad_id"
            ? "bad"
            : w.second.id;
    const before = await snapshotTables(w.prisma, tables);
    const result = await post(id, headers, mode === "no_idem" ? null : uuidv7());
    expect(result.response.status).toBe(
      {
        guest: 401,
        unbound: 403,
        clerk: 403,
        foreign: 404,
        missing: 404,
        no_store: 403,
        no_idem: 400,
        bad_id: 400,
      }[mode],
    );
    expect(result.body.error).toBe(
      {
        guest: "AUTH_REQUIRED",
        unbound: "NOT_A_MEMBER",
        clerk: "ROLE_FORBIDDEN",
        foreign: "NOT_FOUND",
        missing: "NOT_FOUND",
        no_store: "NOT_A_MEMBER",
        no_idem: "IDEMPOTENCY_KEY_REQUIRED",
        bad_id: "VALIDATION_FAILED",
      }[mode],
    );
    expect(await snapshotTables(w.prisma, tables)).toEqual(before);
  });

  it("最后一家拒绝；未认证首店给真实 blocker，不因存在空闲第二店绕过", async () => {
    const w = await world();
    const blocked = await post(w.storeId, w.owner.withStore(w.storeId));
    expect(blocked.response.status).toBe(409);
    expect(blocked.body).toMatchObject({
      error: "STORE_HAS_OPEN_WORK",
      details: { blockers: [{ kind: "unverified_primary_store", count: 1 }] },
    });
    expect((await post(w.second.id, w.owner.withStore(w.storeId))).response.status).toBe(200);
    const before = await snapshotTables(w.prisma, tables);
    const last = await post(w.storeId, w.owner.withStore(w.storeId));
    expect(last.response.status).toBe(409);
    expect(last.body.error).toBe("LAST_ACTIVE_STORE");
    expect(await snapshotTables(w.prisma, tables)).toEqual(before);
  });
});
