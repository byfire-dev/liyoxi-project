import { expect, it } from "vitest";
import { StoreCreateBodySchema, StoreListSchema } from "@liyoxi/contract";
import type { RequestLayer } from "@/lib/request";
import { TENANT_NEW, TENANT_SECOND, tenantStores } from "../../../../shots/tenant-data";
import { createTenantApi } from "../../member/members/api";
import { createTenantAction } from "../../member/members/model";
import { canCreateStore, storeCreateBody } from "./model";
it("新店额度以服务器为准；默认不复制、不造地图字段，同意图复用键且只用返回ID", async () => {
  const owner = StoreListSchema.parse(tenantStores());
  expect(canCreateStore(owner)).toBe(true);
  expect(canCreateStore(tenantStores(true))).toBe(false);
  if (owner.viewerRole !== "owner") throw new Error("fixture");
  expect(canCreateStore({ ...owner, entity: { ...owner.entity, canAddStore: false } })).toBe(false);
  const input = {
    name: "  新门店  ",
    detail: "邻里路18号",
    industry: "food",
    category: "coffee",
    addressPrefix: "广东省深圳市福田区",
    sourceId: TENANT_SECOND,
    options: [],
  };
  const body = StoreCreateBodySchema.parse(storeCreateBody(input));
  expect(body).toEqual({
    name: "新门店",
    addressDetail: "广东省深圳市福田区邻里路18号",
    industryCode: "food",
    categoryCode: "coffee",
  });
  expect(body).not.toHaveProperty("latitude");
  expect(body).not.toHaveProperty("provinceCode");
  expect(
    StoreCreateBodySchema.parse(storeCreateBody({ ...input, options: ["service", "media"] })),
  ).toMatchObject({ copyFromStoreId: TENANT_SECOND, copyOptions: ["service", "media"] });
  expect(() => storeCreateBody({ ...input, category: null })).toThrow("请选择");
  const calls: { path: string; key?: string }[] = [];
  let attempt = 0;
  const call: RequestLayer["request"] = async <T>(
    path: string,
    options?: Parameters<RequestLayer["request"]>[1],
  ) => {
    calls.push({ path, key: options?.idempotencyKey });
    if (++attempt === 1) throw new Error("断网");
    return { ...owner.items[1]!, storeId: TENANT_NEW, name: body.name } as T;
  };
  const api = createTenantApi(call),
    action = createTenantAction(
      () => "owner|oldStore",
      () => "store:stable",
    );
  expect(await action.run(body, (key) => api.createStore(body, key))).toBeUndefined();
  const result = await action.run(body, (key) => api.createStore(body, key));
  expect(result?.storeId).toBe(TENANT_NEW);
  expect(result?.storeId).not.toBe(TENANT_SECOND);
  expect(calls.map((c) => c.key)).toEqual(["store:stable", "store:stable"]);
});
