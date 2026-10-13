// W2-11: admin.store.reassignDeliveryManager，仅一组真实HTTP。
import { beforeAll, expect, it } from "vitest";
import { ManagerTransferResultSchema } from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, signInAsStaff, snapshotTables } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof handle.db.prisma>>,
  make: ReturnType<typeof createFactories>,
  from: SignedInStaff,
  lead: SignedInStaff;
let peer = 0;
beforeAll(async () => {
  api = await handle.start();
  db = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  make = createFactories({ db, clock: api.clock });
  from = await signInAsStaff(db, { roleKey: "delivery_manager", now: api.clock.now() });
  lead = await signInAsStaff(db, {
    roleKey: "delivery_manager",
    isLead: true,
    staffGroupId: from.staff.staffGroupId,
    now: api.clock.now(),
  });
}, 120_000);
const tables = ["store", "drama_order", "assignment_history", "timer", "audit_log", "outbox_event"];
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return ManagerTransferResultSchema.parse(((await response.json()) as { data: unknown }).data);
}

it("admin.store.reassignDeliveryManager真实lead/required/幂等与撤权，null订单由runtime拥有者补齐不计moved", async () => {
  expect(
    HANDLERS.some((entry) => entry.route.operationId === "admin.store.reassignDeliveryManager"),
  ).toBe(true);
  const own = await make.merchant(),
    to = await make.staff({
      staffRoleKey: "delivery_manager",
      staffGroupId: from.staff.staffGroupId,
    });
  await db.store.update({
    where: { id: own.store.id },
    data: { deliveryManagerId: from.staff.id },
  });
  const emptyOrder = await make.dramaOrder({
    entityId: own.entity.id,
    storeId: own.store.id,
    deliveryManagerId: null,
  });
  const path = `/api/v1/admin/stores/${own.store.id}/reassign-delivery-manager`,
    key = uuidv7();
  const input = {
    toStaffId: to.id,
    reasonCode: "merchant_request",
    note: "虚构HTTP经理转移",
    confirm: { fromStaffId: from.staff.id },
  };
  const post = (staff?: SignedInStaff, idem?: string) =>
    api.request(path, {
      method: "POST",
      json: input,
      headers: { ...(staff?.headers ?? {}), ...(idem ? { "Idempotency-Key": idem } : {}) },
      peer: `198.19.86.${++peer}`,
    });
  const before = await snapshotTables(db, tables);
  await error(await post(), 401, "AUTH_REQUIRED");
  await error(await post(lead), 400, "IDEMPOTENCY_KEY_REQUIRED");
  await error(await post(from, uuidv7()), 403, "PERMISSION_DENIED");
  expect(await snapshotTables(db, tables)).toEqual(before);

  const result = await data(await post(lead, key));
  expect(result).toMatchObject({
    storeId: own.store.id,
    deliveryManager: { staffId: to.id },
    moved: { dramaOrderCount: 0, deliveryTicketCount: 0, serviceTicketCount: 0 },
    contact: {
      storeId: own.store.id,
      toStaff: { staffId: to.id },
      contactedAt: null,
      contactedBy: null,
    },
  });
  expect(
    (await db.dramaOrder.findUniqueOrThrow({ where: { id: emptyOrder.id } })).deliveryManagerId,
  ).toBe(to.id);
  expect(await db.assignmentHistory.count({ where: { batchId: result.batchId } })).toBe(1);
  expect(
    await db.timer.findFirstOrThrow({ where: { subjectId: result.contact.assignmentHistoryId } }),
  ).toMatchObject({ status: "scheduled" });
  const after = await snapshotTables(db, tables);
  expect(await data(await post(lead, key))).toEqual(result);
  expect(await snapshotTables(db, tables)).toEqual(after);
  expect(
    await db.auditLog.count({
      where: { targetId: own.store.id, action: "tenant.store.assign_manager" },
    }),
  ).toBe(1);
  await db.staff.update({ where: { id: lead.staff.id }, data: { isLead: false } });
  await error(await post(lead, key), 403, "PERMISSION_DENIED");
  expect(await snapshotTables(db, tables)).toEqual(after);
}, 60_000);
