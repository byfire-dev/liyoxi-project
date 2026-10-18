import { MemberItemSchema, MemberListSchema } from "@liyoxi/contract";
import { createIdentityContext, uuidv7 } from "@liyoxi/services";
import { createFactories } from "@liyoxi/services/testing";
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
  const db = await testApi.db.prisma();
  const make = createFactories({ db, clock: api.clock });
  const clerk = await signInAsMerchant(api);
  // Invitation acceptance is pending: these are explicitly lawful historical memberships.
  const member = await make.entityMember({
    id: `018fabcd${uuidv7().slice(8)}`,
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
  const second = await make.store({ entityId: created.entityId });
  return { owner, clerk, member, db, make, second, ...created };
}
async function call(
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  key: string | null = uuidv7(),
) {
  const response = await api.request(`/api/v1/m/members${path}`, {
    method: body === undefined ? "GET" : "PATCH",
    headers: {
      ...headers,
      ...(body === undefined || key === null ? {} : { "Idempotency-Key": key }),
    },
    ...(body === undefined ? {} : { json: body }),
  });
  return { response, body: (await response.json()) as { data?: unknown; error?: string } };
}
async function trace(memberId: string) {
  const db = await testApi.db.prisma();
  return {
    member: await db.entityMember.findUniqueOrThrow({ where: { id: memberId } }),
    stores: await db.storeMember.findMany({
      where: { entityMemberId: memberId },
      orderBy: { storeId: "asc" },
    }),
    audits: await db.auditLog.findMany({ where: { targetId: memberId }, orderBy: { id: "asc" } }),
    events: await db.outboxEvent.findMany({
      where: { aggregateId: memberId },
      orderBy: { id: "asc" },
    }),
    history: await db.statusTransition.findMany({ where: { subjectId: memberId } }),
  };
}

describe("m.member.list", { timeout: 120_000 }, () => {
  it("owner gets actual current-store media counts while GET leaves member facts untouched", async () => {
    const w = await world();
    for (const [storeId, adoptedCount] of [
      [w.storeId, 7],
      [w.storeId, 0],
      [w.second.id, 9],
    ] as const) {
      await w.db.storeAsset.create({
        data: {
          id: uuidv7(),
          entityId: w.entityId,
          storeId,
          type: "text",
          textBody: "公开虚构历史素材",
          uploadActorType: "merchant",
          uploadActorId: w.clerk.merchantUserId,
          uploadActorRole: "clerk",
          uploadClient: "weapp",
          processingState: "pending",
          reviewState: "unreviewed",
          adoptedCount,
          idempotencyKey: uuidv7(),
          createdAt: api.clock.now(),
          updatedAt: api.clock.now(),
        },
      });
    }
    const before = await trace(w.member.id);
    const result = await call("", w.owner.withStore(w.storeId));
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    const data = MemberListSchema.options[0].parse(result.body.data);
    expect(data.items.map((item) => item.memberId)).toEqual([w.memberId, w.member.id]);
    expect(data.items[0]).toMatchObject({
      role: "owner",
      storeScope: "all",
      stores: [],
      actions: [],
      uploadCount: 0,
      adoptedCount: 0,
    });
    expect(data.items[1]).toMatchObject({
      uploadCount: 2,
      adoptedCount: 1,
      storeScope: "listed",
      actions: ["update", "remove"],
    });
    expect(data.items[1]!.stores.map((store) => store.storeId)).toEqual([w.storeId]);
    expect(data).toHaveProperty("pendingInvitations");
    expect(data).toHaveProperty("seats");
    expect(await trace(w.member.id)).toEqual(before);
  });

  it("clerk receives exactly five fields and no owner top-level or private nested values", async () => {
    const w = await world(),
      before = await trace(w.member.id);
    const result = await call("", w.clerk.withStore(w.storeId));
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    const data = MemberListSchema.options[1].parse(result.body.data);
    expect(Object.keys(data).sort()).toEqual(["items", "viewerRole"]);
    for (const item of data.items)
      expect(Object.keys(item).sort()).toEqual([
        "displayName",
        "isSelf",
        "joinedAt",
        "memberId",
        "role",
      ]);
    expect(data.items.find((item) => item.memberId === w.member.id)).toMatchObject({
      isSelf: true,
      role: "clerk",
    });
    expect(await trace(w.member.id)).toEqual(before);
  });
});

describe("m.member.update", { timeout: 120_000 }, () => {
  it("PATCH uses real idem, writes only one occurrence and immediately revokes the removed store", async () => {
    const w = await world(),
      key = uuidv7(),
      body = { storeIds: [w.second.id] };
    const before = await trace(w.member.id);
    const first = await call(`/${w.member.id}`, w.owner.withStore(w.storeId), body, key);
    expect(first.response.status).toBe(200);
    expect(first.response.headers.get("cache-control")).toBe("no-store");
    const data = MemberItemSchema.parse(first.body.data);
    expect(data.stores.map((store) => store.storeId)).toEqual([w.second.id]);
    const after = await trace(w.member.id);
    expect(after.member.lastStoreId).toBeNull();
    expect(after.history).toEqual(before.history);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    expect(after.events).toHaveLength(before.events.length + 1);
    expect(after.events.at(-1)).toMatchObject({
      eventType: "entity_member.stores_changed",
      payload: {
        v: 1,
        entityMemberId: w.member.id,
        entityId: w.entityId,
        merchantUserId: w.clerk.merchantUserId,
        addedStoreIds: [w.second.id],
        removedStoreIds: [w.storeId],
        invitationId: null,
      },
    });
    const replay = await call(`/${w.member.id}`, w.owner.withStore(w.storeId), body, key);
    expect(replay.response.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    const conflict = await call(
      `/${w.member.id}`,
      w.owner.withStore(w.storeId),
      { storeIds: [w.storeId] },
      key,
    );
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await trace(w.member.id)).toEqual(after);
    const lost = await call("", w.clerk.withStore(w.storeId));
    expect(lost.response.status).toBe(403);
    expect(lost.body.error).toBe("NOT_A_MEMBER");
    expect((await call("", w.clerk.withStore(w.second.id))).response.status).toBe(200);
  });

  it("canonical lower-case same set is a no-op; upper/mixed IDs and malformed bodies are rejected with zero changes", async () => {
    const w = await world(),
      before = await trace(w.member.id),
      headers = w.owner.withStore(w.storeId);
    const same = await call(`/${w.member.id}`, headers, { storeIds: [w.storeId] });
    expect(same.response.status).toBe(200);
    expect(await trace(w.member.id)).toEqual(before);
    for (const id of [w.member.id.toUpperCase(), w.member.id.replace("abcd", "aBcd")]) {
      const result = await call(`/${id}`, headers, { storeIds: [w.storeId] });
      expect(result.response.status).toBe(400);
      expect(result.body.error).toBe("VALIDATION_FAILED");
    }
    for (const body of [
      { storeIds: [] },
      { storeIds: [w.storeId, w.storeId] },
      { storeIds: ["bad"] },
      { storeIds: [w.storeId], lockVersion: 0 },
    ]) {
      const result = await call(`/${w.member.id}`, headers, body);
      expect(result.response.status).toBe(400);
      expect(result.body.error).toBe("VALIDATION_FAILED");
    }
    const noKey = await call(`/${w.member.id}`, headers, { storeIds: [w.storeId] }, null);
    expect(noKey.response.status).toBe(400);
    expect(noKey.body.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(await trace(w.member.id)).toEqual(before);
  });

  it.each(["guest", "unbound", "foreign", "archived"] as const)(
    "%s cannot use either endpoint",
    async (mode) => {
      const w = await world(),
        before = await trace(w.member.id);
      let headers: Record<string, string> = {},
        error = "AUTH_REQUIRED",
        status = 401;
      if (mode === "unbound") {
        headers = (await signInAsMerchant(api)).withStore(w.storeId);
        error = "NOT_A_MEMBER";
        status = 403;
      } else if (mode === "foreign") {
        headers = w.owner.withStore((await world()).storeId);
        error = "NOT_A_MEMBER";
        status = 403;
      } else if (mode === "archived") {
        const archived = await w.make.store({
          entityId: w.entityId,
          lifecycle: "archived",
          archiveReason: "by_owner",
          archivedAt: api.clock.now(),
          archiveActorType: "merchant",
          archiveActorId: w.owner.merchantUserId,
          archiveClient: "weapp",
        });
        headers = w.owner.withStore(archived.id);
        error = "STORE_ARCHIVED";
        status = 403;
      }
      for (const body of [undefined, { storeIds: [w.storeId] }]) {
        const result = await call(body === undefined ? "" : `/${w.member.id}`, headers, body);
        expect(result.response.status).toBe(status);
        expect(result.body.error).toBe(error);
      }
      expect(await trace(w.member.id)).toEqual(before);
    },
  );

  it("missing store scope and clerk PATCH fail before business mutation", async () => {
    const w = await world(),
      before = await trace(w.member.id);
    for (const body of [undefined, { storeIds: [w.storeId] }]) {
      const result = await call(body === undefined ? "" : `/${w.member.id}`, w.owner.headers, body);
      expect(result.response.status).toBe(403);
      expect(result.body.error).toBe("NOT_A_MEMBER");
    }
    const denied = await call(`/${w.member.id}`, w.clerk.withStore(w.storeId), {
      storeIds: [w.second.id],
    });
    expect(denied.response.status).toBe(403);
    expect(denied.body.error).toBe("ROLE_FORBIDDEN");
    expect(await trace(w.member.id)).toEqual(before);
  });

  it("foreign/missing target is 404 and foreign requested store is 400, with both members untouched", async () => {
    const w = await world(),
      foreign = await world();
    const ownBefore = await trace(w.member.id),
      otherBefore = await trace(foreign.member.id);
    for (const id of [foreign.member.id, uuidv7()]) {
      const result = await call(`/${id}`, w.owner.withStore(w.storeId), { storeIds: [w.storeId] });
      expect(result.response.status).toBe(404);
      expect(result.body.error).toBe("NOT_FOUND");
    }
    const invalid = await call(`/${w.member.id}`, w.owner.withStore(w.storeId), {
      storeIds: [foreign.storeId],
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.error).toBe("VALIDATION_FAILED");
    expect(await trace(w.member.id)).toEqual(ownBefore);
    expect(await trace(foreign.member.id)).toEqual(otherBefore);
  });
});
