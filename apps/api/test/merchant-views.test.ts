// W1-04②："m.bootstrap.get"、"m.me.overview.get"（其它四条在 merchant-auth.test.ts）。
import {
  BootstrapSchema,
  errorResponses,
  MeOverviewSchema,
  merchantRoute,
  okResponse,
  z,
} from "@liyoxi/contract";
import { createIdentityContext, uuidv7 } from "@liyoxi/services";
import { createFactories } from "@liyoxi/services/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { idemOf } from "../src/http/idempotency.js";
import { respondByRole } from "../src/http/respond-by-role.js";
import { merchantServicesOf } from "../src/merchant/services.js";
import { defineHandler } from "../src/routing/define.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";

const testApi = useTestApi();
let api: TestApi;
let owner: SignedInMerchant;
let clerk: SignedInMerchant;
let entityId: string;
let storeId: string;
let memberId: string;
beforeAll(async () => {
  api = await testApi.start();
  await seedUserAgreements(testApi, api);
  owner = await signInAsMerchant(api);
  const created = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  ({ entityId, storeId, memberId } = created);
  clerk = await signInAsMerchant(api);
  const make = createFactories({ db: await testApi.db.prisma(), clock: api.clock });
  const member = await make.entityMember({
    entityId,
    merchantUserId: clerk.merchantUserId,
    lastStoreId: storeId,
  });
  await make.storeMember({ entityMemberId: member.id, storeId, addedByMemberId: memberId });
}, 180_000);
async function get(path: string, headers: Record<string, string> = {}) {
  const response = await api.request(`/api/v1${path}`, { headers });
  return { response, body: (await response.json()) as { error?: string; data: unknown } };
}
describe("引导与我的", () => {
  it("匿名、无效凭据个人块 null；登录后个人块完整，M1 默认有效", async () => {
    const variants: Record<string, string>[] = [{}, { authorization: "Bearer expired" }];
    for (const headers of variants) {
      const { response, body } = await get("/m/bootstrap", headers);
      expect(response.status).toBe(200);
      const data = BootstrapSchema.parse(body.data);
      expect([data.pendingConsents, data.subscribePlan, data.context]).toEqual([null, null, null]);
      expect(data.degraded).toEqual([]);
    }
    const { response, body } = await get("/m/bootstrap", clerk.headers);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = BootstrapSchema.parse(body.data);
    expect(data.context).toEqual({ storeId });
    expect(data.subscribePlan).toEqual([]);
    expect(data.pendingConsents).toEqual([]);
    expect(data.uploadLimits.imageMaxMb).toBe(5);
    expect(data.subscribeCooldownDays).toBe(7);
    expect(data.subscribeMaxPerAsk).toBe(3);
  });
  it("无权门店头不回 403、不把外部主体交给开关白名单；已校验成员关系会参与求值", async () => {
    const db = await testApi.db.prisma();
    await db.featureFlag.upsert({
      where: { key: "release.notice_faq" },
      update: { rules: [{ when: { entityIds: [entityId] }, value: true }] },
      create: {
        createdAt: api.clock.now(),
        updatedAt: api.clock.now(),
        key: "release.notice_faq",
        valueType: "bool",
        defaultValue: false,
        exposedTo: "client",
        rules: [{ when: { entityIds: [entityId] }, value: true }],
      },
    });
    await api.runtime.config.cache.bump("flag");
    const allowed = await get("/m/bootstrap", clerk.withStore(storeId));
    expect(BootstrapSchema.parse(allowed.body.data).flags["release.notice_faq"]).toBe(true);
    for (const inaccessible of [uuidv7(), "bad-id"]) {
      const { response, body } = await get("/m/bootstrap", clerk.withStore(inaccessible));
      expect(response.status).toBe(200);
      // 无效/无权的门店不贡献主体上下文。
      expect(BootstrapSchema.parse(body.data).flags["release.notice_faq"]).toBe(false);
      expect(BootstrapSchema.parse(body.data).context).toEqual({ storeId });
    }
  });
  it("版本块实际取数失败只降级 versions，用户协议仍然返回", async () => {
    const spy = vi
      .spyOn(api.runtime.config.dicts, "versions")
      .mockRejectedValueOnce(new Error("字典故障"));
    try {
      const { response, body } = await get("/m/bootstrap", clerk.headers);
      expect(response.status).toBe(200);
      const data = BootstrapSchema.parse(body.data);
      expect(data.degraded).toEqual(["versions"]);
      expect(data.pendingConsents).toEqual([]);
      expect(data.context).toEqual({ storeId });
    } finally {
      spy.mockRestore();
    }
  });
  it("引导版本只包含小程序可见字典，使用全协议集合指纹", async () => {
    const versions = vi
      .spyOn(api.runtime.config.dicts, "versions")
      .mockResolvedValueOnce({ visible: 7, staff_only: 9 });
    const list = vi.spyOn(api.runtime.config.dicts, "list").mockImplementation(async (typeKey) => ({
      typeKey,
      name: typeKey,
      structure: "flat",
      versionNo: 1,
      isMerchantVisible: typeKey === "visible",
      items: [],
    }));
    try {
      const data = BootstrapSchema.parse((await get("/m/bootstrap")).body.data);
      expect(data.versions.dict).toEqual({ visible: 7 });
      const stamps = await api.runtime.tx.run((tx) =>
        merchantServicesOf(api.runtime).docs.consentStamps(tx),
      );
      expect(data.versions.agreement).toBe(stamps.all);
      expect(data.degraded).toEqual([]);
    } finally {
      versions.mockRestore();
      list.mockRestore();
    }
  });
  it("老板聚合实门店、额度与默认事实；店员没有积分、概览、档案完整度或审核块", async () => {
    const boss = await get("/m/me/overview", owner.withStore(storeId));
    expect(boss.response.status).toBe(200);
    expect(boss.response.headers.get("cache-control")).toBe("no-store");
    const data = MeOverviewSchema.parse(boss.body.data);
    expect(data.viewerRole).toBe("owner");
    if (data.viewerRole !== "owner") throw new Error("老板形状错误");
    expect(data.currentStore.storeId).toBe(storeId);
    expect(data.currentStore.clerkCount).toBe(1);
    expect(data.stores).toMatchObject({ visibleCount: 1, storeLimit: 1, reviewingStores: [] });
    expect(data.subscription).toMatchObject({ status: "none", spendablePoints: 0 });
    expect(data.storeStats).toEqual({ liveCount: 0, deliveringCount: 0, cartCount: 0 });
    const employee = await get("/m/me/overview", clerk.withStore(storeId));
    expect(employee.response.status).toBe(200);
    const view = MeOverviewSchema.parse(employee.body.data);
    expect(view.viewerRole).toBe("clerk");
    expect(Object.keys(view).sort()).toEqual([
      "currentStore",
      "stores",
      "unreadMessageCount",
      "viewerRole",
    ]);
    expect(view.currentStore).not.toHaveProperty("completenessPct");
    expect(view.currentStore).not.toHaveProperty("review");
    expect(view.stores).toEqual({ visibleCount: 1 });
    expect((await get("/m/me/overview", clerk.headers)).response.status).toBe(403);
  });
  it("GET 聚合不修改最后门店或协议指纹", async () => {
    const db = await testApi.db.prisma();
    const before = await db.entityMember.findUniqueOrThrow({ where: { id: memberId } });
    const user = await db.merchantUser.findUniqueOrThrow({ where: { id: owner.merchantUserId } });
    await get("/m/bootstrap", owner.withStore(storeId));
    await get("/m/me/overview", owner.withStore(storeId));
    expect((await db.entityMember.findUniqueOrThrow({ where: { id: memberId } })).lastStoreId).toBe(
      before.lastStoreId,
    );
    expect(
      (await db.merchantUser.findUniqueOrThrow({ where: { id: owner.merchantUserId } }))
        .consentStamp,
    ).toBe(user.consentStamp);
  });
});

it(
  "老板写入 raw 幂等结果；同一观察者改成店员后，同键重放再次裁剪且不执行业务",
  { timeout: 120_000 },
  async () => {
    const ownerSchema = z.object({
      viewerRole: z.literal("owner"),
      name: z.string(),
      balance: z.int(),
    });
    const clerkSchema = z.object({ viewerRole: z.literal("clerk"), name: z.string() });
    type View = z.infer<typeof ownerSchema> | z.infer<typeof clerkSchema>;
    const route = merchantRoute({
      method: "post",
      path: "/m/lyxtest-clerk/replay",
      operationId: "m.lyxtestClerk.replay",
      "x-auth": "user",
      "x-clerk-view": "trimmed",
      "x-idempotent": "required",
      responses: {
        ...okResponse(z.union([ownerSchema, clerkSchema])),
        ...errorResponses(400, 403),
      },
    });
    let executions = 0;
    const app = await testApi.start({
      handlers: [
        defineHandler(route, async (c) => {
          const result = await c.var.runtime.tx.run(
            async () => {
              executions += 1;
              return {
                viewerRole: "owner" as const,
                name: "春熙店",
                balance: 123,
                rawOnly: "saved",
              };
            },
            { idem: idemOf(c) },
          );
          return respondByRole<View>(c, { owner: ownerSchema, clerk: clerkSchema }, result);
        }),
      ],
      middlewares: [
        {
          slot: "auth",
          factory: () => async (c, next) => {
            const role = c.req.header("X-Test-Role") === "clerk" ? "clerk" : "owner";
            c.set(
              "identity",
              createIdentityContext({
                actor: { type: "merchant", id: owner.merchantUserId, client: "weapp", role },
                entityId,
                storeId,
              }),
            );
            c.set("membership", { memberId, entityId, storeId, role, storeMode: "active" });
            await next();
          },
        },
      ],
    });
    const key = uuidv7();
    const headers = { "idempotency-key": key, "x-store-id": storeId };
    const first = await app.request(route.path, {
      method: "POST",
      headers: { ...headers, "x-test-role": "owner" },
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { data: View }).data).toEqual({
      viewerRole: "owner",
      name: "春熙店",
      balance: 123,
    });
    const replay = await app.request(route.path, {
      method: "POST",
      headers: { ...headers, "x-test-role": "clerk" },
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(((await replay.json()) as { data: View }).data).toEqual({
      viewerRole: "clerk",
      name: "春熙店",
    });
    expect(executions).toBe(1);
    const row = await (
      await testApi.db.prisma()
    ).idempotencyRecord.findFirstOrThrow({ where: { scope: route.operationId } });
    expect(row.result).toMatchObject({ viewerRole: "owner", balance: 123, rawOnly: "saved" });
  },
);
