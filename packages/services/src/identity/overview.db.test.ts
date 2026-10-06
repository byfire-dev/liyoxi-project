import { MeOverviewSchema } from "@liyoxi/contract";
import { beforeAll, expect, it } from "vitest";
import {
  createIdentityContext,
  defineRegistration,
  implementMerchantFacts,
} from "../kernel/index.js";
import { assembleForTest, useSeededDatabase } from "../testing/index.js";
import { buildHarness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { overview } from "./overview.js";

const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = await buildHarness(await db.prisma());
}, 120_000);
it("已注册的非默认事实原口径映射，套餐日期转 ISO；店员只询问未读事实", async () => {
  const user = await h.make.merchantUser();
  const created = await h.tenant.createEntity(
    createIdentityContext({ actor: { type: "merchant", id: user.id, client: "weapp" } }),
  );
  const clerk = await h.make.merchantUser();
  const member = await h.make.entityMember({
    entityId: created.entityId,
    merchantUserId: clerk.id,
  });
  await h.make.storeMember({
    entityMemberId: member.id,
    storeId: created.storeId,
    addedByMemberId: created.memberId,
  });
  let billingCalls = 0;
  const seen: string[] = [];
  const assembly = assembleForTest({
    entry: "api",
    extra: [
      defineRegistration("lyxtest_overview", {
        portImplementations: [
          implementMerchantFacts("billing", async () => {
            billingCalls += 1;
            return {
              subscription: null,
              wallet: {
                status: "active",
                isRefundPending: true,
                planName: "专业版",
                endDate: "2026-10-12",
                remainingDays: 6,
                spendablePoints: 300,
                planAvailablePoints: 200,
                addonAvailablePoints: 100,
                planPointsExpireAt: new Date("2026-10-12T16:00:00.000Z"),
                isAddonSuspended: false,
              },
            };
          }),
          implementMerchantFacts("order", async (_tx, query) => ({
            stores: {
              [query.storeIds[0]!]: {
                liveCount: 2,
                deliveringCount: 3,
                cartCount: 4,
                todoCount: 0,
              },
            },
          })),
          implementMerchantFacts("publish", async (_tx, query) => ({
            stores: {
              [query.storeIds[0]!]: {
                launchTaskTodoCount: 5,
                hasLaunchTasks: true,
                channelAccountCount: 1,
                channelAccountAttention: {
                  channelAccountId: created.storeId,
                  platform: "douyin",
                  status: "abnormal",
                  abnormalSource: "manual",
                  abnormalReason: null,
                },
              },
            },
          })),
          implementMerchantFacts("notify", async (_tx, query) => {
            seen.push(query.viewerRole);
            return { unreadMessageCount: query.viewerRole === "owner" ? 8 : 2 };
          }),
        ],
      }),
    ],
  });
  const deps = { ...h, assembly };
  const ownerMembership = await h.tx.run((tx) =>
    h.tenant.resolveMembership(tx, { merchantUserId: user.id, storeId: created.storeId }),
  );
  if (ownerMembership === null) throw new Error("老板成员关系未建");
  const owner = MeOverviewSchema.parse(
    await overview(deps, { merchantUserId: user.id, membership: ownerMembership }),
  );
  expect(owner.viewerRole).toBe("owner");
  if (owner.viewerRole !== "owner") throw new Error("老板结构错误");
  expect(owner.subscription).toMatchObject({
    status: "active",
    spendablePoints: 300,
    planPointsExpireAt: "2026-10-12T16:00:00.000Z",
  });
  expect(owner.storeStats).toEqual({ liveCount: 2, deliveringCount: 3, cartCount: 4 });
  expect(owner.entries).toMatchObject({
    launchTaskTodoCount: 5,
    channelAccountCount: 1,
    channelAccountAttention: { abnormalSource: "manual" },
  });
  const callsBeforeClerk = billingCalls;
  const clerkMembership = await h.tx.run((tx) =>
    h.tenant.resolveMembership(tx, { merchantUserId: clerk.id, storeId: created.storeId }),
  );
  if (clerkMembership === null) throw new Error("店员成员关系未建");
  const employee = await overview(deps, { merchantUserId: clerk.id, membership: clerkMembership });
  expect(employee.unreadMessageCount).toBe(2);
  expect(employee).not.toHaveProperty("subscription");
  expect(billingCalls).toBe(callsBeforeClerk);
  expect(seen).toEqual(["owner", "clerk"]);
});
