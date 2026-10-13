// W2-11: "admin.store.profile.get", "admin.store.profile.update"，两组真实HTTP。
import { beforeAll, describe, expect, it } from "vitest";
import { AdminStoreProfileSchema } from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { TEST_WEAPP_APPID, useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const h = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof h.db.prisma>>,
  make: ReturnType<typeof createFactories>,
  admin: SignedInStaff,
  manager: SignedInStaff,
  viewer: SignedInStaff,
  peer = 0;
beforeAll(async () => {
  api = await h.start();
  db = await h.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  make = createFactories({ db, clock: api.clock });
  admin = await signInAsStaff(db, { roleKey: "super_admin" });
  manager = await signInAsStaff(db, { roleKey: "delivery_manager" });
  viewer = await signInAsStaff(db, { roleKey: "finance" });
}, 60000);
async function store(managed = true) {
  const user = await make.merchantUser(),
    entity = await make.entity({ createdByUserId: user.id }),
    store = await make.store({
      entityId: entity.id,
      isPrimary: true,
      deliveryManagerId: managed ? manager.staff.id : null,
    });
  await make.entityMember({ entityId: entity.id, merchantUserId: user.id, role: "owner" });
  await db.wechatIdentity.create({
    data: {
      id: uuidv7(),
      merchantUserId: user.id,
      appid: TEST_WEAPP_APPID,
      openid: `lyxtest_proxy_http_${uuidv7()}`,
      lastLoginAt: api.clock.now(),
      lastActiveAt: api.clock.now(),
      createdAt: api.clock.now(),
      updatedAt: api.clock.now(),
    },
  });
  return { user, entity, store, path: `/api/v1/admin/stores/${store.id}/profile` };
}
const request = (path: string, method = "GET", json?: unknown, staff = admin, key?: string) =>
  api.request(path, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: { ...staff.headers, ...(key ? { "Idempotency-Key": key } : {}) },
    peer: `198.19.81.${++peer % 250}`,
  });
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return AdminStoreProfileSchema.parse(((await response.json()) as { data: unknown }).data);
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
const body = (lockVersion = 0) => ({ lockVersion, reasonCode: "merchant_wecom_request" });
const counts = async (storeId: string) => {
  const media = await db.storeProfileMedia.findMany({ where: { storeId }, select: { id: true } }),
    services = await db.storeServiceItem.findMany({ where: { storeId }, select: { id: true } });
  return [
    await db.storeProfile.count({ where: { storeId } }),
    await db.auditLog.count({ where: { storeId } }),
    await db.outboxEvent.count({ where: { storeId } }),
    await db.fileRef.count({
      where: {
        OR: [
          { refType: "store_profile", refId: storeId },
          { refType: "store_profile_media", refId: { in: media.map((r) => r.id) } },
          { refType: "store_service_item", refId: { in: services.map((r) => r.id) } },
        ],
      },
    }),
  ];
};

describe("后台档案两正式接口", { timeout: 30000 }, () => {
  it("真实模块/范围/权限与required，禁改专码零写；保存GET与幂等重放只一代理事实", async () => {
    const who = await store(),
      foreign = await store(false),
      before = await counts(who.store.id),
      input = { ...body(), brandName: "虚构代理品牌", avgSpendFen: 1234 },
      key = uuidv7();
    const empty = await data(await request(who.path, "GET", undefined, manager));
    expect(empty).toMatchObject({
      storeId: who.store.id,
      lockVersion: 0,
      lastEditor: null,
      actions: ["update"],
    });
    expect(await counts(who.store.id)).toEqual(before);
    await error(await request(foreign.path, "GET", undefined, manager), 404, "NOT_FOUND");
    await error(
      await request(who.path, "PATCH", input, viewer, uuidv7()),
      403,
      "PERMISSION_DENIED",
    );
    await error(await request(who.path, "PATCH", input), 400, "IDEMPOTENCY_KEY_REQUIRED");
    await error(
      await request(who.path, "PATCH", { ...input, storeName: "不得改名" }, manager, uuidv7()),
      400,
      "FIELD_NOT_PROXY_EDITABLE",
    );
    await error(
      await request(who.path, "PATCH", { ...input, contactPhone: null }, manager, uuidv7()),
      400,
      "FIELD_NOT_PROXY_EDITABLE",
    );
    for (const method of ["GET", "PATCH"])
      await error(
        await api.request(who.path, {
          method,
          ...(method === "PATCH" ? { json: input } : {}),
          peer: `198.19.81.${++peer % 250}`,
        }),
        401,
        "AUTH_REQUIRED",
      );
    expect(await counts(who.store.id)).toEqual(before);
    const saved = await data(await request(who.path, "PATCH", input, manager, key));
    expect(saved).toMatchObject({
      lockVersion: 1,
      brandName: "虚构代理品牌",
      avgSpendFen: 1234,
      lastEditor: { actorType: "staff", name: manager.staff.name },
    });
    expect(await data(await request(who.path, "PATCH", input, manager, key))).toEqual(saved);
    expect(await data(await request(who.path))).toEqual(saved);
    expect(await counts(who.store.id)).toEqual([1, 1, 1, 0]);
    expect(await db.auditLog.findFirstOrThrow({ where: { storeId: who.store.id } })).toMatchObject({
      stream: "ops",
      onBehalfOfEntityId: who.entity.id,
      reasonCode: "merchant_wecom_request",
    });
    expect(
      await db.outboxEvent.findFirstOrThrow({ where: { storeId: who.store.id } }),
    ).toMatchObject({ eventType: "store.profile.changed", payload: { source: "staff_proxy" } });
  });

  it("两个HTTP同版本只一胜；错误值/伪造文件/无变化不产生额外业务事实", async () => {
    const who = await store(),
      results = await Promise.all([
        request(who.path, "PATCH", { ...body(), avgSpendFen: 1000 }, manager, uuidv7()),
        request(who.path, "PATCH", { ...body(), avgSpendFen: 2000 }, admin, uuidv7()),
      ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200)!,
      loser = results.find((r) => r.status === 409)!;
    const current = await data(winner);
    expect(current.lockVersion).toBe(1);
    await error(loser, 409, "VERSION_CONFLICT");
    expect(await data(await request(who.path))).toEqual(current);
    const before = await counts(who.store.id);
    await error(
      await request(who.path, "PATCH", { ...body(1), avgSpendFen: -1 }, admin, uuidv7()),
      400,
      "VALIDATION_FAILED",
    );
    await error(
      await request(
        who.path,
        "PATCH",
        { ...body(1), avgSpendFen: current.avgSpendFen },
        admin,
        uuidv7(),
      ),
      400,
      "PROXY_EDIT_NO_CHANGE",
    );
    const unmarked = await make.fileObject({
      category: "profile_image",
      bucket: "asset",
      scopeType: "store",
      entityId: who.entity.id,
      storeId: who.store.id,
      uploadActorType: "staff",
      uploadActorId: admin.staff.id,
      uploadClient: "admin",
    });
    await error(
      await request(who.path, "PATCH", { ...body(1), logoFileId: unmarked.id }, admin, uuidv7()),
      400,
      "FILE_NOT_USABLE",
    );
    expect(await counts(who.store.id)).toEqual(before);
    await error(await request(`/api/v1/admin/stores/${uuidv7()}/profile`), 404, "NOT_FOUND");
  });
});
