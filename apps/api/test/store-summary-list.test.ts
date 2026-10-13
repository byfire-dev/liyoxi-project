// W2-11: "admin.store.summary" 与 "admin.store.list" 的同筛选真实HTTP。
import { beforeAll, expect, it } from "vitest";
import { AdminStoreListSchema, StoreListSummarySchema } from "@liyoxi/contract";
import { authz, runSeed } from "@liyoxi/services";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const h = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof h.db.prisma>>,
  make: ReturnType<typeof createFactories>,
  admin: SignedInStaff,
  manager: SignedInStaff,
  editor: SignedInStaff,
  peer = 0;
beforeAll(async () => {
  api = await h.start();
  db = await h.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  make = createFactories({ db, clock: api.clock });
  admin = await signInAsStaff(db, { roleKey: "super_admin" });
  manager = await signInAsStaff(db, { roleKey: "delivery_manager" });
  editor = await signInAsStaff(db, { roleKey: "editor" });
}, 60000);
const request = (path: string, staff = admin) =>
  api.request(`/api/v1/admin/stores${path}`, {
    headers: staff.headers,
    peer: `198.19.87.${++peer % 250}`,
  });
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as { data: unknown }).data;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
const counts = async () => [
  await db.auditLog.count(),
  await db.outboxEvent.count(),
  await db.timer.count(),
  await db.subscriptionTerm.count(),
];

it("summary字面挂载与list完整筛选同scope/同店口径，默认与旧别名分页；鉴权/非法输入及GET零写", async () => {
  const own = await make.subscribedMerchant();
  await db.store.update({
    where: { id: own.store.id },
    data: { deliveryManagerId: manager.staff.id },
  });
  const sibling = await make.store({ entityId: own.entity.id, isPrimary: false });
  const before = await counts(),
    params = `entityId=${own.entity.id}&sourceType=organic&subscriptionStatus=active&planId=${own.term.planId}&expiresWithinDays=30`;
  const list = AdminStoreListSchema.parse(await data(await request(`?${params}`)));
  const summary = StoreListSummarySchema.parse(await data(await request(`/summary?${params}`)));
  expect(list.total).toBe(2);
  expect(new Set(list.items.map((r) => r.storeId))).toEqual(new Set([own.store.id, sibling.id]));
  expect(summary).toMatchObject({
    total: 2,
    paidCount: 2,
    activePlanCount: 2,
    pendingReviewCount: 0,
  });
  expect(list.items.find((r) => r.storeId === sibling.id)?.totalPaidFen).toBeNull();
  expect(AdminStoreListSchema.parse(await data(await request(`?${params}&pageSize=1`))).total).toBe(
    summary.total,
  );
  const ownList = AdminStoreListSchema.parse(await data(await request(`?${params}`, manager)));
  const ownSummary = StoreListSummarySchema.parse(
    await data(await request(`/summary?${params}`, manager)),
  );
  expect(ownList.items.map((r) => r.storeId)).toEqual([own.store.id]);
  expect(ownSummary.total).toBe(ownList.total);
  const created = AdminStoreListSchema.parse(
    await data(await request(`?entityId=${own.entity.id}&sort=-createdAt`)),
  );
  expect(
    AdminStoreListSchema.parse(
      await data(await request(`?entityId=${own.entity.id}&sort=-registeredAt`)),
    ).items,
  ).toEqual(created.items);
  expect(
    StoreListSummarySchema.parse(
      await data(await request(`/summary?entityId=${own.entity.id}&subscriptionStatus=expired`)),
    ).total,
  ).toBe(0);
  await error(await api.request("/api/v1/admin/stores/summary"), 401, "AUTH_REQUIRED");
  for (const path of [
    "?expiresWithinDays=14",
    "/summary?sourceType=unknown",
    "/summary?sort=-lastOrderAt",
    "?sort=-unknown",
    "?isManagerUnassigned=true&deliveryManagerId=" + manager.staff.id,
  ])
    await error(await request(path), 400, "VALIDATION_FAILED");
  const role = await db.staffRole.findUniqueOrThrow({ where: { key: "editor" } }),
    levels = authz.normalizeRoleConfig("editor", role).moduleLevels;
  await db.staffRole.update({
    where: { key: "editor" },
    data: { moduleLevels: { ...levels, merchant: "n" } },
  });
  try {
    await error(await request("/summary", editor), 403, "PERMISSION_DENIED");
    await error(await request("", editor), 403, "PERMISSION_DENIED");
  } finally {
    await db.staffRole.update({ where: { key: "editor" }, data: { moduleLevels: { ...levels } } });
  }
  expect(await counts()).toEqual(before);
}, 30000);
