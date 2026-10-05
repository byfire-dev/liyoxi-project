// billing 的种子（W0-21）：套餐与首版价目、积分包、等级模板价、计费参数、估值口径。数据在 seed-data.ts。
// 没有才插，按“键”认：套餐按版本码；价目只给一条修订都没有的套餐写首版；模板价、参数只给一行都没有的键写初始行
//（它们是不可改的修订行，之后的调整由后台追加新行）；积分包只在表空时播。初始行立即生效，首版豁免公告，没有创建人。
import { BILLING_PARAM_KEY, HEAT_TIER } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";

import { defineSeed, insertMissing, uuidv7 } from "../kernel/index.js";
import type { SeedContext, SeedTableResult, Tx } from "../kernel/index.js";

import {
  BILLING_PARAM_SEEDS,
  cyclePricesOf,
  PLAN_SEEDS,
  POINT_PACK_SEEDS,
  PRICE_TIER_SEEDS,
  VALUATION_POLICY_SEED,
} from "./seed-data.js";

async function seedPlans(tx: Tx, { now }: SeedContext): Promise<SeedTableResult[]> {
  const plans = await insertMissing({
    table: "plan",
    rows: PLAN_SEEDS,
    keyOf: (row) => row.code,
    existingKeys: async () =>
      (await tx.plan.findMany({ select: { code: true } })).map((row) => row.code),
    insert: (missing) =>
      tx.plan.createMany({
        data: missing.map((row) => ({
          id: uuidv7(),
          code: row.code,
          name: row.name,
          rank: row.rank,
          isListed: true,
          createdAt: now,
          updatedAt: now,
        })),
      }),
  });
  const stored = await tx.plan.findMany({
    where: { code: { in: PLAN_SEEDS.map((row) => row.code) } },
    select: { id: true, code: true, _count: { select: { planRevisions: true } } },
  });
  const planOf = new Map(stored.map((row) => [row.code, row]));
  const revisions = await insertMissing({
    table: "plan_revision",
    rows: PLAN_SEEDS,
    keyOf: (row) => row.code,
    existingKeys: () =>
      Promise.resolve(stored.filter((row) => row._count.planRevisions > 0).map((row) => row.code)),
    insert: (missing) =>
      tx.planRevision.createMany({
        data: missing.map((row) => ({
          id: uuidv7(),
          planId: planOf.get(row.code)?.id as string,
          revisionNo: 1,
          monthlyFeeFen: row.monthlyFeeFen,
          monthlyPoints: row.monthlyPoints,
          discountBp: row.discountBp,
          productionModel: row.productionModel,
          maxStores: row.maxStores,
          maxMembers: row.maxMembers,
          schedulePriority: row.schedulePriority,
          hasMonthlyReport: row.hasMonthlyReport,
          cyclePrices: cyclePricesOf(row),
          effectiveAt: now,
          createdAt: now,
        })),
      }),
  });
  return [plans, revisions];
}

async function seedPointPacks(tx: Tx, { now }: SeedContext): Promise<SeedTableResult> {
  // 积分包没有业务上的唯一键（下架的可以与上架的同分值）：表里有过任何一行就整组不播
  const any = (await tx.pointPack.count()) > 0;
  return insertMissing({
    table: "point_pack",
    rows: POINT_PACK_SEEDS,
    keyOf: (row) => String(row.points),
    existingKeys: () =>
      Promise.resolve(any ? POINT_PACK_SEEDS.map((row) => String(row.points)) : []),
    insert: (missing) =>
      tx.pointPack.createMany({
        data: missing.map((row) => ({
          id: uuidv7(),
          points: row.points,
          priceFen: row.priceFen,
          position: POINT_PACK_SEEDS.indexOf(row),
          createdAt: now,
          updatedAt: now,
        })),
      }),
  });
}

function seedPriceTiers(tx: Tx, { now }: SeedContext): Promise<SeedTableResult> {
  const batchId = uuidv7();
  return insertMissing({
    table: "price_tier_revision",
    rows: HEAT_TIER.values,
    keyOf: (tier) => tier,
    existingKeys: async () =>
      (await tx.priceTierRevision.findMany({ select: { tier: true }, distinct: ["tier"] })).map(
        (row) => row.tier,
      ),
    insert: (missing) =>
      tx.priceTierRevision.createMany({
        data: missing.map((tier) => ({
          id: uuidv7(),
          tier,
          points: PRICE_TIER_SEEDS[tier],
          effectiveAt: now,
          batchId,
          createdAt: now,
        })),
      }),
  });
}

function seedBillingParams(tx: Tx, { now }: SeedContext): Promise<SeedTableResult> {
  const changeId = uuidv7();
  return insertMissing({
    table: "billing_param",
    rows: BILLING_PARAM_KEY.values,
    keyOf: (key) => key,
    existingKeys: async () =>
      (await tx.billingParam.findMany({ select: { key: true }, distinct: ["key"] })).map(
        (row) => row.key,
      ),
    insert: (missing) =>
      tx.billingParam.createMany({
        data: missing.map((key) => ({
          id: uuidv7(),
          key,
          value: BILLING_PARAM_SEEDS[key] as Prisma.InputJsonValue,
          effectiveAt: now,
          changeId,
          note: "上线初始值",
          createdAt: now,
        })),
      }),
  });
}

function seedValuationPolicy(tx: Tx, { now }: SeedContext): Promise<SeedTableResult> {
  return insertMissing({
    table: "valuation_policy",
    rows: [VALUATION_POLICY_SEED],
    keyOf: (row) => String(row.versionNo),
    existingKeys: async () =>
      (await tx.valuationPolicy.findMany({ select: { versionNo: true } })).map((row) =>
        String(row.versionNo),
      ),
    insert: (missing) =>
      tx.valuationPolicy.createMany({
        data: missing.map((row) => ({
          versionNo: row.versionNo,
          description: row.description,
          rule: row.rule,
          createdAt: now,
        })),
      }),
  });
}

export const seed = defineSeed("billing", async (tx, context) => [
  ...(await seedPlans(tx, context)),
  await seedPointPacks(tx, context),
  await seedPriceTiers(tx, context),
  await seedBillingParams(tx, context),
  await seedValuationPolicy(tx, context),
]);
