import { beforeAll, expect, it } from "vitest";
import {
  MessageListResultSchema,
  MessageSummarySchema,
  MessageBatchReadResultSchema,
  NotifySettingListResultSchema,
  routeCatalog,
} from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import {
  createFactories,
  createNotifyMessageFixture,
  changeNotifyMessageAccessFixture,
  createNotifyQuotaFixture,
  updateNotifySlotFixture,
} from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi, TestRequestInit } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";

const handle = useTestApi();
let api: TestApi;
let owner: SignedInMerchant;
let storeId: string;
let entityId: string;
beforeAll(async () => {
  api = await handle.start();
  await seedUserAgreements(handle, api);
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  owner = await signInAsMerchant(api);
  const scope = await api.runtime.tx.run(async (tx) => {
    const make = createFactories({ db: tx, clock: api.clock });
    const entity = await make.entity({ createdByUserId: owner.merchantUserId });
    const store = await make.store({ entityId: entity.id });
    await make.entityMember({
      entityId: entity.id,
      merchantUserId: owner.merchantUserId,
      role: "owner",
    });
    return { entityId: entity.id, storeId: store.id };
  });
  ({ entityId, storeId } = scope);
}, 120_000);
const message = (
  input: Parameters<typeof createNotifyMessageFixture>[2] = {
    merchantUserId: owner.merchantUserId,
  },
) => api.runtime.tx.run((tx) => createNotifyMessageFixture(tx, api.clock, input));
const responseData = async <T>(
  response: Response,
  schema: { parse(input: unknown): T },
): Promise<T> => schema.parse(((await response.json()) as { data: unknown }).data);

function request(
  operationId:
    | "m.message.list"
    | "m.message.summary"
    | "m.message.read"
    | "m.message.batchRead"
    | "m.notifySetting.list",
  path: string,
  init: TestRequestInit = {},
): Promise<Response> {
  const route = routeCatalog.find((item) => item.operationId === operationId);
  if (!route) throw new Error(`契约未登记 ${operationId}`);
  expect((init.method ?? "GET").toUpperCase(), operationId).toBe(route.method);
  // 查询串不属于路径段；原始 path（含查询串）原样交给真实 API 校验。
  const actual = new URL(path, "http://localhost").pathname.split("/");
  const expected = `/api/v1${route.path}`.split("/");
  expect(actual, operationId).toHaveLength(expected.length);
  expected.forEach((segment, index) => {
    if (/^\{[^}]+\}$/.test(segment)) expect(actual[index], operationId).not.toBe("");
    else expect(actual[index], operationId).toBe(segment);
  });
  return api.request(path, init);
}

it("m.message.list / m.message.summary：真实非空安全DTO、user鉴权、门店可选、无效头403与cursor400", async () => {
  const row = await message();
  await message({ merchantUserId: owner.merchantUserId, entityId, storeId });
  const unauthorized = await api.request("/api/v1/m/messages");
  expect(unauthorized.status).toBe(401);
  const response = await request("m.message.list", "/api/v1/m/messages?limit=1", {
    headers: owner.headers,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await responseData(response, MessageListResultSchema);
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({
    messageId: row.id,
    isRead: false,
    readAt: null,
    link: { route: "messages.list", params: {} },
  });
  expect(Object.keys(body.items[0]!).sort()).toEqual(
    [
      "messageId",
      "category",
      "title",
      "body",
      "ctaText",
      "link",
      "storeId",
      "isRead",
      "readAt",
      "createdAt",
      "createdDate",
    ].sort(),
  );
  const summary = await request("m.message.summary", "/api/v1/m/messages/summary", {
    headers: owner.withStore(storeId),
  });
  expect(summary.status).toBe(200);
  expect(await responseData(summary, MessageSummarySchema)).toMatchObject({
    total: 2,
    byStore: [{ storeId, unreadCount: 2 }],
  });
  expect(
    (await api.request("/api/v1/m/messages", { headers: owner.withStore("invalid") })).status,
  ).toBe(403);
  expect(
    (await api.request("/api/v1/m/messages?cursor=bad", { headers: owner.headers })).status,
  ).toBe(400);
});

it("m.message.read：无JSONbody、required幂等与并发原读时刻；越权/未知404", async () => {
  const row = await message();
  const foreign = await api.runtime.tx.run(async (tx) => {
    const stranger = await createFactories({ db: tx, clock: api.clock }).merchantUser();
    return createNotifyMessageFixture(tx, api.clock, { merchantUserId: stranger.id });
  });
  const key = uuidv7();
  const input = { method: "POST", headers: { ...owner.headers, "Idempotency-Key": key } };
  const path = `/api/v1/m/messages/${row.id}/read`;
  expect((await api.request(path, { method: "POST", headers: owner.headers })).status).toBe(400);
  const first = await request("m.message.read", path, input);
  expect(first.status).toBe(200);
  const body = await first.json();
  api.clock.advance(1000);
  expect(await (await api.request(path, input)).json()).toEqual(body);
  expect(
    (
      await api.request(`/api/v1/m/messages/${uuidv7()}/read`, {
        method: "POST",
        headers: { ...owner.headers, "Idempotency-Key": uuidv7() },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await api.request(`/api/v1/m/messages/${foreign.id}/read`, {
        method: "POST",
        headers: { ...owner.headers, "Idempotency-Key": uuidv7() },
      })
    ).status,
  ).toBe(404);
  expect(
    await api.runtime.tx.run((tx) =>
      tx.merchantMessage.findUniqueOrThrow({ where: { id: foreign.id }, select: { readAt: true } }),
    ),
  ).toEqual({ readAt: null });
});

it("m.message.batchRead：真实上界、tab、required幂等重放，新消息仍未读", async () => {
  const upper = await message({ merchantUserId: owner.merchantUserId, category: "review" });
  const newer = await message({ merchantUserId: owner.merchantUserId, category: "review" });
  const input = {
    method: "POST",
    headers: { ...owner.headers, "Idempotency-Key": uuidv7() },
    json: { upToMessageId: upper.id, tab: "review" },
  };
  const first = await request("m.message.batchRead", "/api/v1/m/messages/read", input);
  expect(first.status).toBe(200);
  const body = await responseData(first, MessageBatchReadResultSchema);
  expect(body.markedCount).toBe(1);
  await message();
  const replay = await api.request("/api/v1/m/messages/read", input);
  expect(replay.status).toBe(200);
  expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
  expect(await responseData(replay, MessageBatchReadResultSchema)).toEqual(body);
  const listed = await responseData(
    await api.request("/api/v1/m/messages?tab=review", { headers: owner.headers }),
    MessageListResultSchema,
  );
  expect(listed.items.find((item) => item.messageId === newer.id)?.isRead).toBe(false);
});

it("m.notifySetting.list：当前真实登录会话额度与12槽位，invalid门店降级而不写授权", async () => {
  await api.runtime.tx.run(async (tx) => {
    const session = await tx.userSession.findFirstOrThrow({
      where: { merchantUserId: owner.merchantUserId, revokedAt: null },
    });
    await updateNotifySlotFixture(tx, "pay_result", {
      status: "active",
      providerTemplateId: "fictional-w217-pay-result",
      fields: [],
    });
    await createNotifyQuotaFixture(tx, api.clock, {
      merchantUserId: owner.merchantUserId,
      wechatIdentityId: session.wechatIdentityId!,
      slotKey: "pay_result",
      remaining: 1,
      lastAcceptAt: api.clock.now(),
    });
  });
  const response = await request("m.notifySetting.list", "/api/v1/m/notify-settings", {
    headers: owner.withStore("bad"),
  });
  expect(response.status).toBe(200);
  const data = await responseData(response, NotifySettingListResultSchema);
  expect(data.items).toHaveLength(12);
  expect(data).toMatchObject({ cooldownDays: 7, maxPerAsk: 3 });
  expect(
    data.items.find((item: { slotKey: string }) => item.slotKey === "pay_result"),
  ).toMatchObject({ state: "on", estRemaining: 1, tmplId: "fictional-w217-pay-result" });
});

async function scopedMessageActor(clerk = false) {
  const signed = await signInAsMerchant(api);
  const scope = await api.runtime.tx.run(async (tx) => {
    const make = createFactories({ db: tx, clock: api.clock });
    const entity = await make.entity({ createdByUserId: signed.merchantUserId });
    const store = await make.store({ entityId: entity.id });
    const userId = clerk ? (await make.merchantUser()).id : signed.merchantUserId;
    const primary = await make.entityMember({
      entityId: entity.id,
      merchantUserId: userId,
      role: "owner",
    });
    if (clerk) {
      const member = await make.entityMember({
        entityId: entity.id,
        merchantUserId: signed.merchantUserId,
      });
      await make.storeMember({
        entityMemberId: member.id,
        entityId: entity.id,
        storeId: store.id,
        addedByMemberId: primary.id,
      });
    }
    return { entityId: entity.id, storeId: store.id };
  });
  return { signed, ...scope };
}

for (const change of ["remove_membership", "archive_store"] as const)
  for (const operation of ["read", "batchRead"] as const)
    it(`真实HTTP同键${operation}在${change}后403，旧成功不替代当前门店授权`, async () => {
      const who = await scopedMessageActor(change === "remove_membership");
      const row = await message({
        merchantUserId: who.signed.merchantUserId,
        entityId: who.entityId,
        storeId: who.storeId,
      });
      const key = uuidv7();
      const path =
        operation === "read" ? `/api/v1/m/messages/${row.id}/read` : "/api/v1/m/messages/read";
      const request = (sameKey = key) =>
        api.request(path, {
          method: "POST",
          headers: { ...who.signed.withStore(who.storeId), "Idempotency-Key": sameKey },
          ...(operation === "batchRead" ? { json: { upToMessageId: row.id, tab: "all" } } : {}),
        });
      expect((await request()).status).toBe(200);
      const initial = await api.runtime.tx.run((tx) =>
        tx.merchantMessage.findUniqueOrThrow({ where: { id: row.id }, select: { readAt: true } }),
      );
      await api.runtime.tx.run((tx) =>
        changeNotifyMessageAccessFixture(tx, api.clock, {
          merchantUserId: who.signed.merchantUserId,
          entityId: who.entityId,
          storeId: who.storeId,
          change,
        }),
      );
      expect((await request(uuidv7())).status).toBe(403);
      const replay = await request();
      expect(replay.status).toBe(403);
      expect(await replay.json()).toMatchObject({ error: "NOT_A_MEMBER" });
      expect(
        await api.runtime.tx.run((tx) =>
          tx.merchantMessage.findUniqueOrThrow({ where: { id: row.id }, select: { readAt: true } }),
        ),
      ).toEqual(initial);
    });

it("真实HTTP老板降店员后ownerOnly单读重放404，批读重放当前summary且保留首次已读时刻", async () => {
  const who = await scopedMessageActor();
  const limited = await message({
    merchantUserId: who.signed.merchantUserId,
    entityId: who.entityId,
    isOwnerOnly: true,
    category: "plan_points",
  });
  const upper = await message({
    merchantUserId: who.signed.merchantUserId,
    entityId: who.entityId,
    storeId: who.storeId,
  });
  const pendingLimited = await message({
    merchantUserId: who.signed.merchantUserId,
    entityId: who.entityId,
    isOwnerOnly: true,
    category: "plan_points",
  });
  const readInput = {
    method: "POST",
    headers: { ...who.signed.withStore(who.storeId), "Idempotency-Key": uuidv7() },
  };
  const path = `/api/v1/m/messages/${limited.id}/read`;
  const first = await api.request(path, readInput);
  expect(first.status).toBe(200);
  const firstBody = await first.json();
  const batchInput = {
    method: "POST",
    headers: { ...who.signed.withStore(who.storeId), "Idempotency-Key": uuidv7() },
    json: { upToMessageId: upper.id, tab: "all" },
  };
  const marked = await responseData(
    await api.request("/api/v1/m/messages/read", batchInput),
    MessageBatchReadResultSchema,
  );
  expect(marked).toMatchObject({ markedCount: 1, summary: { total: 1 } });
  expect(marked.summary.byTab.find((item) => item.tab === "plan_points")?.unreadCount).toBe(1);
  await api.runtime.tx.run((tx) =>
    changeNotifyMessageAccessFixture(tx, api.clock, {
      merchantUserId: who.signed.merchantUserId,
      entityId: who.entityId,
      storeId: who.storeId,
      change: "downgrade_owner",
    }),
  );
  api.clock.advance(1000);
  const newer = await message({
    merchantUserId: who.signed.merchantUserId,
    entityId: who.entityId,
    storeId: who.storeId,
  });
  expect((await api.request(path, readInput)).status).toBe(404);
  const replay = await api.request("/api/v1/m/messages/read", batchInput);
  expect(replay.status).toBe(200);
  expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
  const replayBody = await responseData(replay, MessageBatchReadResultSchema);
  expect(replayBody.markedCount).toBe(marked.markedCount);
  const summary = await responseData(
    await api.request("/api/v1/m/messages/summary", { headers: who.signed.withStore(who.storeId) }),
    MessageSummarySchema,
  );
  expect(replayBody.summary).toEqual(summary);
  expect(replayBody.summary.byTab.find((item) => item.tab === "plan_points")?.unreadCount).toBe(0);
  expect(replayBody.summary.byStore).toEqual([{ storeId: who.storeId, unreadCount: 1 }]);
  const stored = await api.runtime.tx.run((tx) =>
    tx.merchantMessage.findUniqueOrThrow({ where: { id: limited.id }, select: { readAt: true } }),
  );
  expect(stored.readAt?.toISOString()).toBe(
    (firstBody as { data: { readAt: string } }).data.readAt,
  );
  for (const row of [newer, pendingLimited])
    expect(
      await api.runtime.tx.run((tx) =>
        tx.merchantMessage.findUniqueOrThrow({ where: { id: row.id }, select: { readAt: true } }),
      ),
    ).toEqual({ readAt: null });
});
