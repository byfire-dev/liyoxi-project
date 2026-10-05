import type { PrismaClient, SubscriptionTerm } from "@liyoxi/db";
import { grantDates, renewTerm, termDates } from "@liyoxi/shared/period";
import type { TermDates } from "@liyoxi/shared/period";
import { addDays, endOfDay, startOfDay } from "@liyoxi/shared/time";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createLedgerHarness,
  dumpLedger,
  openTerm,
  topUp,
  useSeededDatabase,
} from "../../testing/index.js";
import type { LedgerHarness } from "../../testing/index.js";
import { billingInvariants } from "../invariants.js";

// 甲类的性质测试（账户与批次这一半；冻结一族齐了之后的账本模型测试在第二个 PR）：
// 任取开通日（含 29、30、31 日与闰年）、周期长短、后面接几个预约周期、若干次加购与任意多次推进的时刻——
//   ① 每一步之后，账户上的余额与订阅状态等于按周期起止直接算出来的参考值；
//   ② 中间多推进任意多次，与只在要记账时才推进，最后的账本逐项相同（advance 幂等、可追赶，与什么时候跑无关）；
//   ③ 结束时七条不变量 0 违规（含只读流水重建各桶 I2、账户缓存 I3、时钟单调 I16）。
// 连真库，缺省轮次少；轮次与种子的约定同别的性质测试：
//   LYX_FC_RUNS=200 LYX_FC_SEED=42 pnpm --filter @liyoxi/services exec vitest run src/billing/ledger/advance.property.test.ts
const runs = {
  numRuns: Number(process.env.LYX_FC_RUNS ?? 10),
  seed: Number(process.env.LYX_FC_SEED ?? 20261005),
};

const SLOW = 600_000;
const DAY = 86_400_000;
const MINUTE = 60_000;
const PLANS = { basic: 3000, pro: 6600, flagship: 14_400 } as const;
type PlanCode = keyof typeof PLANS;

interface TermSpec {
  planCode: PlanCode;
  months: number;
}
interface Scenario {
  /** 开通日：2026-01-01 起第几天，另加当天的第几分钟 */
  startDay: number;
  startMinute: number;
  terms: TermSpec[];
  /** 要记账（加购）的时刻：开通后第几分钟；points 为 0 即只推进 */
  steps: { afterMinutes: number; points: number }[];
  /** 只给第二个主体多做的推进：开通后第几分钟 */
  extraAdvances: number[];
}

const planCode = fc.constantFrom<PlanCode>("basic", "pro", "flagship");
const scenario: fc.Arbitrary<Scenario> = fc.record({
  // 三年之内，偏向月末（锚定日 29、30、31 的周期）
  startDay: fc.oneof(
    fc.integer({ min: 0, max: 1095 }),
    fc.constantFrom(28, 29, 30, 58, 59, 364, 394, 423, 424, 789),
  ),
  startMinute: fc.integer({ min: 0, max: 1439 }),
  terms: fc
    .tuple(
      fc.record({ planCode, months: fc.constantFrom(1, 3, 12) }),
      fc.array(fc.record({ planCode, months: fc.constantFrom(1, 3) }), { maxLength: 2 }),
    )
    .map(([first, rest]) => [first, ...rest]),
  steps: fc.array(
    fc.record({
      afterMinutes: fc.integer({ min: 1, max: 560 * 1440 }),
      points: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 5000 })),
    }),
    { minLength: 1, maxLength: 5 },
  ),
  extraAdvances: fc.array(fc.integer({ min: 1, max: 560 * 1440 }), { maxLength: 6 }),
});

interface TermPlan extends TermSpec {
  startsAt: Date;
  endsAt: Date;
  /** 各月的应发时刻 */
  dueAts: Date[];
}

/** 参考值用的周期表：只靠周期起止与发放日，不看账本 */
function planTerms(start: Date, startDate: string, specs: readonly TermSpec[]): TermPlan[] {
  const plans: TermPlan[] = [];
  let dates: TermDates | undefined;
  for (const spec of specs) {
    dates = dates === undefined ? termDates(startDate, spec.months) : renewTerm(dates, spec.months);
    const startsAt = plans.at(-1)?.endsAt ?? start;
    plans.push({
      ...spec,
      startsAt,
      endsAt: endOfDay(dates.endDate),
      dueAts: grantDates(dates).map((date, month) => (month === 0 ? startsAt : startOfDay(date))),
    });
  }
  return plans;
}

/** 时刻 at 的参考值：订阅状态、套餐可用、加购可用、最近一次清零 */
function expected(terms: readonly TermPlan[], purchased: number, at: Date) {
  const current = terms.find((term) => term.startsAt <= at && at < term.endsAt);
  const ended = terms.filter((term) => term.endsAt <= at).at(-1);
  return {
    subStatus: current ? "active" : "expired",
    planAvailableQty: current
      ? PLANS[current.planCode] * current.dueAts.filter((due) => due <= at).length
      : 0,
    addonAvailableQty: purchased,
    heldTotalQty: 0,
    lastExpiredQty: ended ? PLANS[ended.planCode] * ended.months : null,
  };
}

const db = useSeededDatabase("services");
let prisma: PrismaClient;
let h: LedgerHarness;

beforeAll(async () => {
  prisma = await db.prisma();
  h = createLedgerHarness(prisma);
}, SLOW);

async function subscribe(specs: readonly TermSpec[]): Promise<string> {
  const { entity } = await h.make.merchant({ verified: true });
  let last: SubscriptionTerm | undefined;
  for (const spec of specs) {
    last = (await openTerm(h, { entityId: entity.id, ...spec, ...(last ? { after: last } : {}) }))
      .term;
  }
  return entity.id;
}

describe("advance 的性质：余额等于按周期起止算出的参考值；多推进多少次都一样（甲类）", () => {
  it(
    `任取开通日、周期、预约周期、加购与推进的时刻（${String(runs.numRuns)} 轮，种子 ${String(runs.seed)}）`,
    async () => {
      await fc.assert(
        fc.asyncProperty(scenario, async (given) => {
          const startDate = addDays("2026-01-01", given.startDay);
          const start = new Date(startOfDay(startDate).getTime() + given.startMinute * MINUTE);
          const terms = planTerms(start, startDate, given.terms);
          const moment = (afterMinutes: number): Date =>
            new Date(start.getTime() + afterMinutes * MINUTE);
          const steps = [...given.steps].sort((a, b) => a.afterMinutes - b.afterMinutes);
          const end = new Date(moment(steps.at(-1)?.afterMinutes ?? 0).getTime() + DAY);

          h.clock.set(start);
          const sparse = await subscribe(given.terms);
          const busy = await subscribe(given.terms);
          expect(await balance(sparse)).toEqual(expected(terms, 0, start));

          // 两个主体在同样的时刻做同样的事；busy 另在任意时刻多推进若干次
          const extras = given.extraAdvances.map(moment).filter((at) => at < end);
          const timeline = [
            ...steps.map((step) => ({ at: moment(step.afterMinutes), points: step.points })),
            ...extras.map((at) => ({ at, points: -1 })),
            { at: end, points: 0 },
          ].sort((a, b) => a.at.getTime() - b.at.getTime() || a.points - b.points);
          let purchased = 0;
          for (const { at, points } of timeline) {
            h.clock.set(at);
            if (points < 0) {
              await h.tx.run((tx) => h.ledger.advance(tx, busy));
              continue;
            }
            for (const entityId of [sparse, busy]) {
              if (points > 0) await topUp(h, { entityId, points });
              else await h.tx.run((tx) => h.ledger.advance(tx, entityId));
            }
            purchased += points;
            expect(await balance(sparse), at.toISOString()).toEqual(expected(terms, purchased, at));
          }

          const [left, right] = [await dumpLedger(prisma, sparse), await dumpLedger(prisma, busy)];
          expect(right).toEqual(left);
          // 发放的次数 = 已开始的各周期里应发时刻已到的月数
          const dueByEnd = terms
            .filter((term) => term.startsAt <= end)
            .flatMap((term) => term.dueAts.filter((due) => due <= end));
          expect(left.operations.filter((op) => op.opType === "grant")).toHaveLength(
            dueByEnd.length,
          );
          for (const check of billingInvariants) {
            const found = await h.tx.run(
              async (tx) =>
                (await check.run?.(tx, { entityIds: [sparse, busy] }, { now: end })) ?? [],
            );
            expect(found, check.code).toEqual([]);
          }
        }),
        runs,
      );
    },
    SLOW,
  );
});

async function balance(entityId: string) {
  const account = await prisma.billingAccount.findUniqueOrThrow({ where: { entityId } });
  return {
    subStatus: account.subStatus,
    planAvailableQty: account.planAvailableQty,
    addonAvailableQty: account.addonAvailableQty,
    heldTotalQty: account.heldTotalQty,
    lastExpiredQty: account.lastExpiredQty,
  };
}
