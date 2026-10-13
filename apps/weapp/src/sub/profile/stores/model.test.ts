import { expect, it } from "vitest";
import { StoreListSchema } from "@liyoxi/contract";
import { ApiError, type RequestLayer } from "@/lib/request";
import { tenantStores, TENANT_SECOND } from "../../../../shots/tenant-data";
import { createTenantApi } from "../../member/members/api";
import { createTenantAction, tenantError } from "../../member/members/model";
import { createResource } from "../private/resource";
import { permittedStoreAction } from "./model";
it("门店动作按真实卡片ID与角色；阻断原样、旧读/旧finally/离页导航所有权隔离", async () => {
  const owner = StoreListSchema.parse(tenantStores()),
    clerk = StoreListSchema.parse(tenantStores(true));
  expect(permittedStoreAction(owner, TENANT_SECOND, "delete")).toBe(true);
  expect(permittedStoreAction(owner, TENANT_SECOND, "archive")).toBe(false);
  expect(permittedStoreAction(clerk, TENANT_SECOND, "delete")).toBe(false);
  expect(clerk.entity).not.toHaveProperty("storesUsed");
  const paths: string[] = [];
  const call: RequestLayer["request"] = async <T>(path: string) => {
    paths.push(path);
    return { storeId: TENANT_SECOND } as T;
  };
  const api = createTenantApi(call);
  await api.removeStore(TENANT_SECOND, "delete:1");
  await api.restore(TENANT_SECOND, "restore:1");
  expect(paths).toEqual([
    `/m/stores/${TENANT_SECOND}/delete`,
    `/m/stores/${TENANT_SECOND}/restore`,
  ]);
  const blocked = new ApiError({
    error: "STORE_HAS_OPEN_WORK",
    message: "暂不能归档",
    status: 409,
    requestId: "fixture",
    details: {
      blockers: [
        { kind: "open_order", count: 2 },
        { kind: "qualification_in_review", count: 1 },
      ],
    },
  });
  expect(tenantError(blocked)).toContain("在办订购 2 项");
  expect(tenantError(blocked)).toContain("审核中资质 1 项");
  let context = "old",
    token = "first";
  const action = createTenantAction(
    () => context,
    () => "key",
    () => token,
  );
  let finishOld!: (value: number) => void, finishNew!: (value: number) => void;
  let oldAlive!: () => boolean;
  const old = action.run({}, (_key, _current, alive) => {
    oldAlive = alive;
    return new Promise<number>((done) => {
      finishOld = done;
    });
  });
  expect(await action.run({}, async () => 9)).toBeUndefined();
  context = "new";
  action.invalidate();
  const next = action.run(
    {},
    () =>
      new Promise<number>((done) => {
        finishNew = done;
      }),
  );
  finishOld(1);
  expect(await old).toBeUndefined();
  expect(action.snapshot().busy).toBe(true);
  expect(oldAlive()).toBe(true); // 自有切店不能使页面存活守卫失效。
  action.hide();
  action.activate();
  expect(oldAlive()).toBe(false);
  finishNew(2);
  expect(await next).toBeUndefined();
  let alive!: () => boolean;
  await action.run({}, async (_key, _current, keepAlive) => {
    alive = keepAlive;
    return 1;
  });
  token = "another";
  expect(alive()).toBe(false);
  let complete!: (value: string) => void;
  const resource = createResource({
    context: () => context,
    message: String,
    read: () =>
      new Promise<string>((done) => {
        complete = done;
      }),
  });
  const reading = resource.load();
  context = "third";
  resource.reset();
  complete("old card");
  await reading;
  expect(resource.snapshot().data).toBeUndefined();
});
