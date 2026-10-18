import { beforeAll, describe, expect, it } from "vitest";
import { defineRegistration, implement } from "../kernel/index.js";
import { sampleStaffContext, useSeededDatabase } from "../testing/index.js";
import { harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { implementAdminProfileFacts } from "./admin-ports.js";
import type { AdminFacts } from "./admin-ports.js";
import { adminStoreListBillingPort } from "./admin-list-ports.js";
const db = useSeededDatabase("services");
let h: Harness;
function billingFacts(entityId: string): AdminFacts["billing"] {
  return {
    subscription: {
      status: "active",
      plan: { planId: entityId, code: "TEST", name: "测试套餐" },
      months: 1,
      startDate: "2026-10-01",
      endDate: "2026-10-31",
      hasScheduledTerm: false,
      isRefundPending: false,
      latestPaymentOrder: null,
    },
    points: {
      spendablePoints: 120,
      planAvailablePoints: 100,
      addonAvailablePoints: 20,
      heldPoints: 5,
      isAddonSuspended: false,
    },
    paid: { totalPaidFen: 10000, paidOrderCount: 1, planOrderCount: 1, topupOrderCount: 0 },
    pendingPointAdjustment: null,
    relatedOrders: [],
  };
}
beforeAll(async () => {
  h = harness(await db.prisma(), [
    defineRegistration("lyxtest_admin_profile_facts", {
      portImplementations: [
        implementAdminProfileFacts("billing", async (_tx, q) => billingFacts(q.entityId)),
        implement(adminStoreListBillingPort, async (_tx, { entityIds }) => ({
          facts: new Map(
            entityIds.map((entityId) => [
              entityId,
              {
                status: "active" as const,
                activePlanId: entityId,
                remainingDays: 30,
                totalPaidFen: billingFacts(entityId).paid.totalPaidFen,
                hasPaidOrder: true,
              },
            ]),
          ),
          readRows: async (_tx, ids) =>
            new Map(
              ids.map((entityId) => {
                const { subscription, points } = billingFacts(entityId);
                return [entityId, { subscription, points }];
              }),
            ),
        })),
        implementAdminProfileFacts("order", async () => ({
          lastOrderAt: "2026-10-01T00:00:00.000Z",
          dramaOrderCount: 2,
          relatedOrders: [],
          liveDramaCount: 2,
          liveSummary: {
            firstLiveDate: "2026-10-01",
            latestUsageEndDate: "2026-10-31",
            usageEndSource: "license",
          },
          nearestAgreedLaunchDate: "2026-10-02",
        })),
      ],
    }),
  ]);
}, 120000);
describe("后台聚合端口", () => {
  it("按主体门店查询拥有者键，未注册键为空；次店列表隐金额而详情保留主体合计", async () => {
    const { entity } = await h.owner();
    const store = await h.make.store({ entityId: entity.id, isPrimary: false }),
      admin = await h.make.staff({ staffRoleKey: "super_admin" });
    const staff = await sampleStaffContext(h.prisma, admin.id);
    const result = await h.profile.admin.get(staff, store.id);
    expect(result.entity.activeStoreCount).toBe(2);
    expect(result.subscription.plan?.planId).toBe(entity.id);
    expect(result.points.spendablePoints).toBe(120);
    expect(result.paid).toEqual({
      totalPaidFen: 10000,
      paidOrderCount: 1,
      planOrderCount: 1,
      topupOrderCount: 0,
    });
    expect(result.liveDramaCount).toBe(2);
    expect(result.liveSummary.firstLiveDate).toBe("2026-10-01");
    expect(result.nearestAgreedLaunchDate).toBe("2026-10-02");
    expect(result.deliveringTicketCount).toBe(0);
    expect(result.managerContact).toBeNull();
    expect(result.isWecomAdded).toBe(false);
    const list = await h.profile.admin.list(staff, {
      entityId: entity.id,
      lifecycle: "active",
      sort: "-registeredAt",
      page: 1,
      pageSize: 20,
    });
    expect(list.items.find((v) => v.storeId === store.id)?.totalPaidFen).toBeNull();
    expect(list.items.find((v) => v.isPrimary)?.totalPaidFen).toBe(10000);
  });
});
