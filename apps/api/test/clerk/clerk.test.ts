import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createIdentityContext } from "@liyoxi/services";
import { createFactories } from "@liyoxi/services/testing";
import { expect, it } from "vitest";
import { HANDLERS } from "../../src/routes/index.js";
import { merchantServicesOf } from "../../src/merchant/services.js";
import { useTestApi } from "../../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../../src/testing/merchant.js";
import { CLERK_SAMPLES } from "./samples.js";
import { assertClerkSampleCoverage, clerkVisibleKeys } from "./visible-keys.js";

const testApi = useTestApi();
const golden = fileURLToPath(new URL("../../golden/clerk-visible-keys.snap", import.meta.url));
it(
  "全部已挂载 /m/* 逐条店员回放：禁用字段与字段路径黄金文件（缺样例不能过）",
  { timeout: 180_000 },
  async () => {
    const routes = HANDLERS.map((entry) => entry.route).filter((route) =>
      route.path.startsWith("/api/v1/m/"),
    );
    assertClerkSampleCoverage(
      routes,
      CLERK_SAMPLES.map((sample) => sample.operationId),
    );
    const api = await testApi.start();
    const versions = await seedUserAgreements(testApi, api);
    const owner = await signInAsMerchant(api);
    const created = await merchantServicesOf(api.runtime).tenant.createEntity(
      createIdentityContext({
        actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
      }),
    );
    const clerk = await signInAsMerchant(api);
    const make = createFactories({ db: await testApi.db.prisma(), clock: api.clock });
    const member = await make.entityMember({
      entityId: created.entityId,
      merchantUserId: clerk.merchantUserId,
    });
    await make.storeMember({
      entityMemberId: member.id,
      storeId: created.storeId,
      addedByMemberId: created.memberId,
    });
    const actual: Record<string, string[]> = {};
    for (const sample of CLERK_SAMPLES) {
      const response = await sample.play(api, {
        clerk,
        storeId: created.storeId,
        agreementVersionId: versions.user,
      });
      const body = (await response.json()) as { data?: unknown; error?: string };
      const route = routes.find((route) => route.operationId === sample.operationId)!;
      if (route["x-clerk-view"] === "none") {
        expect(response.status, sample.operationId).toBe(403);
        expect(body.error).toBe("ROLE_FORBIDDEN");
        continue;
      }
      expect(response.status, `${sample.operationId} ${JSON.stringify(body)}`).toBe(200);
      actual[sample.operationId] = clerkVisibleKeys(sample.operationId, body.data);
    }
    const rendered = `${JSON.stringify(Object.fromEntries(Object.entries(actual).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`;
    if (process.env.LYX_CLERK_UPDATE === "1") writeFileSync(golden, rendered);
    expect(rendered).toBe(readFileSync(golden, "utf8"));
  },
);

it("框架拒绝漏样例、重复样例及没有挂载的样例", () => {
  expect(() =>
    assertClerkSampleCoverage([{ operationId: "m.a", "x-clerk-view": "trimmed" }], []),
  ).toThrow("缺店员回放样例：m.a");
  expect(() => assertClerkSampleCoverage([{ operationId: "m.a" }], ["m.a", "m.a"])).toThrow(
    "店员回放样例重复",
  );
  expect(() => assertClerkSampleCoverage([], ["m.a"])).toThrow("店员样例没有挂载：m.a");
});
it("键扫描：Mask 例外、嵌套/数组泄漏、动态字典值仍扫描、标价不按名称全局放行", () => {
  expect(
    clerkVisibleKeys("m.sample", { phoneMask: "138****1234", flags: { "invoice.feature": false } }),
  ).toEqual(["flags", "flags.*", "phoneMask"]);
  for (const data of [
    { list: [{ balance: 1 }] },
    { flags: { any: { phone: "13812341234" } } },
    { priceFen: 1 },
    { current: { contractNo: "a" } },
  ])
    expect(() => clerkVisibleKeys("m.sample", data)).toThrow("店员禁用字段");
});

it("静默登录既定 needPhone 只放行该路由的布尔值，明文与其它路由仍失败", () => {
  expect(clerkVisibleKeys("m.session.create", { needPhone: true })).toEqual(["needPhone"]);
  expect(() => clerkVisibleKeys("m.session.create", { needPhone: "13812341234" })).toThrow(
    "店员禁用字段",
  );
  expect(() => clerkVisibleKeys("m.sample", { needPhone: true })).toThrow("店员禁用字段");
  expect(() => clerkVisibleKeys("m.session.create", { nested: { needPhone: true } })).toThrow(
    "店员禁用字段",
  );
  expect(() => clerkVisibleKeys("m.session.create", { hasPhone: true })).toThrow("店员禁用字段");
});
