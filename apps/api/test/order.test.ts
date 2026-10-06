// W1-15a："m.order.quote"、"m.order.create" 的真实鉴权、事务与 C50 重放。
import { beforeAll, describe, expect, it } from "vitest";
import { createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, prepareOrderFixture } from "@liyoxi/services/testing";
import type { FakeStorage } from "@liyoxi/services/testing";
import { OrderCreateResultSchema, OrderQuoteSchema } from "@liyoxi/contract";
import type { OrderCreateResult, OrderQuote } from "@liyoxi/contract";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";

const h = useTestApi();
let api: TestApi;
let owner: SignedInMerchant;
let clerk: SignedInMerchant;
let scope: { entityId: string; storeId: string; memberId: string };
let fixture: Awaited<ReturnType<typeof prepareOrderFixture>>;
let peer = 0;
const post = (path: string, json: unknown, who = owner, key: string | null = uuidv7()) =>
  api.request(`/api/v1${path}`, {
    method: "POST",
    json,
    headers: {
      ...who.withStore(scope.storeId),
      ...(key === null ? {} : { "Idempotency-Key": key }),
    },
    peer: `198.19.115.${++peer % 250}`,
  });
async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
const residual = () =>
  api.runtime.tx.run(async (tx) => ({
    orders: await tx.dramaOrder.count({ where: { entityId: scope.entityId } }),
    items: await tx.orderItem.count({ where: { entityId: scope.entityId } }),
    holds: await tx.pointHold.count({ where: { entityId: scope.entityId, refType: "order_item" } }),
    consents: await tx.agreementConsent.count({
      where: { entityId: scope.entityId, scene: "order_submit" },
    }),
  }));

beforeAll(async () => {
  api = await h.start();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(h, api);
  owner = await signInAsMerchant(api);
  scope = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  fixture = await prepareOrderFixture(await h.db.prisma(), api.runtime, api.clock, {
    ...scope,
    merchantUserId: owner.merchantUserId,
  });
  clerk = await signInAsMerchant(api);
  await api.runtime.tx.run(async (tx) => {
    const make = createFactories({ db: tx, clock: api.clock });
    const member = await make.entityMember({
      entityId: scope.entityId,
      merchantUserId: clerk.merchantUserId,
    });
    await make.storeMember({
      entityMemberId: member.id,
      storeId: scope.storeId,
      addedByMemberId: scope.memberId,
    });
  });
}, 180_000);

describe("订剧报价与提交的生产接口", { timeout: 60_000 }, () => {
  it("m.order.quote：真实身份返回完整报价、签名海报，业务与协议没有写入", async () => {
    const before = await residual();
    const quote = await data<OrderQuote>(
      await post(
        "/m/orders/quote",
        {
          dramaIds: [fixture.dramaId],
          channelAccountIds: [fixture.channelAccountId],
          isTopModel: false,
        },
        owner,
        null,
      ),
    );
    expect(OrderQuoteSchema.safeParse(quote).success).toBe(true);
    expect(quote.blockers).toEqual([]);
    expect(quote.items[0]!.drama.posterUrl?.url).toEqual(expect.any(String));
    expect(quote.expect).toEqual(fixture.input.expect);
    expect(quote.channelAccounts).toContainEqual(
      expect.objectContaining({
        channelAccountId: fixture.channelAccountId,
        isSelectable: true,
      }),
    );
    expect(await residual()).toEqual(before);
  });

  it("m.order.create：首响应签海报；同键重放为null且不再签发或增加副作用", async () => {
    const key = uuidv7();
    const firstResponse = await post("/m/orders", fixture.input, owner, key);
    expect(firstResponse.headers.get("Cache-Control")).toBe("no-store");
    const first = await data<OrderCreateResult>(firstResponse);
    expect(OrderCreateResultSchema.safeParse(first).success).toBe(true);
    expect(first.replayed).toBe(false);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]!.posterUrl?.url).toEqual(expect.any(String));
    expect(first.totalChargePoints).toBe(fixture.input.expect.totalChargePoints);
    const after = await residual();
    expect(after).toEqual({ orders: 1, items: 1, holds: 1, consents: 1 });
    const storage = api.runtime.providers.storage as FakeStorage;
    const reads = storage.callsOf("presignGet").length;
    const replayResponse = await post("/m/orders", fixture.input, owner, key);
    expect(replayResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(replayResponse.headers.get("Idempotent-Replayed")).toBe("true");
    const replay = await data<OrderCreateResult>(replayResponse);
    expect(OrderCreateResultSchema.safeParse(replay).success).toBe(true);
    expect(replay).toMatchObject({ orderId: first.orderId, replayed: true });
    expect(replay.items.map((item) => item.posterUrl)).toEqual([null]);
    expect(storage.callsOf("presignGet")).toHaveLength(reads);
    expect(await residual()).toEqual(after);
    const saved = await api.runtime.tx.run((tx) =>
      tx.idempotencyRecord.findUniqueOrThrow({
        where: {
          scope_actorKey_key: {
            scope: "m.order.create",
            actorKey: `merchant:${owner.merchantUserId}`,
            key,
          },
        },
      }),
    );
    expect(saved.result).toMatchObject({ items: [{ posterUrl: null }] });
    expect(JSON.stringify(saved.result)).not.toContain(first.items[0]!.posterUrl!.url);
  });

  it("缺幂等键与不一致整单报价在边界拒绝，不写订单、冻结或协议", async () => {
    const before = await residual();
    const missingKey = await post("/m/orders", fixture.input, owner, null);
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({ error: "IDEMPOTENCY_KEY_REQUIRED" });
    const invalid = await post("/m/orders", {
      ...fixture.input,
      expect: {
        ...fixture.input.expect,
        totalChargePoints: fixture.input.expect.totalChargePoints + 1,
      },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "VALIDATION_FAILED" });
    expect(await residual()).toEqual(before);
  });

  it("真实店员对报价和提交都得到403，业务表无新增", async () => {
    const before = await residual();
    for (const [path, body] of [
      [
        "/m/orders/quote",
        {
          dramaIds: [fixture.dramaId],
          channelAccountIds: [fixture.channelAccountId],
          isTopModel: false,
        },
      ],
      ["/m/orders", fixture.input],
    ] as const) {
      const response = await post(path, body, clerk);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "ROLE_FORBIDDEN" });
    }
    expect(await residual()).toEqual(before);
  });
});
