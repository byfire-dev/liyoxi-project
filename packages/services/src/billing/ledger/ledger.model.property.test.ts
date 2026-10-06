import type { PrismaClient } from "@liyoxi/db";
import { addDays, startOfDay } from "@liyoxi/shared/time";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

import {
  adjustPoints,
  captureHold,
  createLedgerHarness,
  holdDrama,
  openTerm,
  priceDrama,
  refundHold,
  releaseHold,
  topUp,
  useSeededDatabase,
} from "../../testing/index.js";
import type { LedgerHarness, TermFixture } from "../../testing/index.js";
import { billingInvariants } from "../invariants.js";

// 参考模型不调生产的分摊、退回或缓存函数，不把数据库余额喂回模型。
// 只绑定生成的 id（批次、周期、冻结单）；数量与桶移动全部来自命令和下面的独立规则。
const runs = {
  numRuns: Number(process.env.LYX_FC_RUNS ?? 10),
  seed: Number(process.env.LYX_FC_SEED ?? 20261006),
};
const SLOW = 600_000;
const DAY = 86_400_000;
const buckets = [
  "available",
  "held",
  "consumed",
  "expired",
  "revoked",
  "convertedOut",
  "adjustedOut",
] as const;
type Bucket = (typeof buckets)[number];
type Kind = "plan" | "addon";
type Balances = Record<Bucket, number>;
interface Lot extends Balances {
  id: string;
  kind: Kind;
  termId: string | null;
  grantedAt: number;
  expiresAt: number | null;
  original: number;
}
interface ModelHold {
  id: string;
  qty: number;
  status: "held" | "captured" | "released" | "refunded_partial" | "refunded_full";
  returned: number;
  allocs: { lot: Lot; qty: number; returned: number }[];
}
const empty = (): Balances => ({
  available: 0,
  held: 0,
  consumed: 0,
  expired: 0,
  revoked: 0,
  convertedOut: 0,
  adjustedOut: 0,
});
const commands = fc.array(
  fc.record({
    action: fc.constantFrom(
      "grant",
      "purchase",
      "hold",
      "capture",
      "release",
      "refundPartial",
      "refundAll",
      "expire",
      "adjustPlus",
      "adjustMinus",
      "clock",
    ),
    selector: fc.nat({ max: 10_000 }),
    qty: fc.integer({ min: 1, max: 4_000 }),
    kind: fc.constantFrom<Kind>("plan", "addon"),
    days: fc.oneof(fc.constant(0), fc.constant(0), fc.constant(0), fc.integer({ min: 1, max: 45 })),
  }),
  { minLength: 1, maxLength: 60 },
);
const scenario = fc.record({ startDay: fc.constantFrom(0, 23, 24, 25, 53, 54, 364), commands });
// 固定走完混合分摊、部分退回、原周期结束后转加购及最终过期，保证短随机序列之外也覆盖完整链。
const crossTermTrace = [
  ["purchase", 1_600, "addon", 0, 0],
  ["adjustMinus", 2_000, "plan", 0, 0],
  ["hold", 1, "plan", 2, 0],
  ["grant", 1, "plan", 0, 0],
  ["capture", 1, "plan", 0, 0],
  ["grant", 1, "plan", 0, 45],
  ["refundPartial", 100, "plan", 0, 0],
  ["clock", 1, "plan", 0, 45],
  ["refundAll", 1, "plan", 0, 0],
  ["adjustPlus", 200, "plan", 0, 0],
  ["adjustMinus", 50, "addon", 0, 0],
  ["hold", 1, "plan", 0, 0],
  ["release", 1, "plan", 0, 0],
  ["expire", 1, "plan", 0, 45],
  ["expire", 1, "plan", 0, 45],
  ["expire", 1, "plan", 0, 2],
  ["purchase", 100, "addon", 0, 0],
  ["hold", 1, "plan", 0, 0],
  ["adjustPlus", 100, "plan", 0, 0],
].map(([action, qty, kind, selector, days]) => ({
  action: action as string,
  qty: qty as number,
  kind: kind as Kind,
  selector: selector as number,
  days: days as number,
}));

class ReferenceLedger {
  readonly lots: Lot[] = [];
  readonly holds: ModelHold[] = [];
  readonly granted = new Set<string>();
  constructor(readonly terms: readonly TermFixture[]) {}

  current(now: number) {
    return this.terms.find(
      ({ term }) => term.startsAt.getTime() <= now && now < term.endsAt.getTime(),
    );
  }
  add(id: string, kind: Kind, qty: number, at: number, term?: TermFixture) {
    const lot: Lot = {
      ...empty(),
      id,
      kind,
      termId: term?.term.id ?? null,
      expiresAt: term?.term.endsAt.getTime() ?? null,
      grantedAt: at,
      original: qty,
      available: qty,
    };
    this.lots.push(lot);
    return lot;
  }
  advance(now: number, identities: ReadonlyMap<string, string>) {
    for (const fixture of this.terms) {
      for (const schedule of fixture.schedules) {
        if (schedule.dueAt.getTime() > now || this.granted.has(schedule.id)) continue;
        const id = identities.get(schedule.id);
        if (!id) throw new Error("到点发放没有批次 id");
        this.add(id, "plan", 3_000, schedule.dueAt.getTime(), fixture);
        this.granted.add(schedule.id);
      }
      if (fixture.term.endsAt.getTime() <= now) {
        for (const lot of this.lots.filter((item) => item.termId === fixture.term.id)) {
          lot.expired += lot.available;
          lot.available = 0;
        }
      }
    }
  }
  available(now: number, kind?: Kind) {
    const termId = this.current(now)?.term.id;
    return this.lots
      .filter(
        (lot) =>
          lot.available > 0 &&
          (!kind || lot.kind === kind) &&
          (lot.kind === "addon" || lot.termId === termId),
      )
      .sort(
        (a, b) =>
          (a.kind === b.kind ? 0 : a.kind === "plan" ? -1 : 1) ||
          (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) ||
          a.grantedAt - b.grantedAt ||
          a.id.localeCompare(b.id),
      );
  }
  take(qty: number, now: number, to: "held" | "adjustedOut", kind?: Kind) {
    const candidates = this.available(now, kind);
    if (candidates.reduce((sum, lot) => sum + lot.available, 0) < qty) return null;
    let remaining = qty;
    const allocs: ModelHold["allocs"] = [];
    for (const lot of candidates) {
      const taken = Math.min(remaining, lot.available);
      if (taken > 0) {
        lot.available -= taken;
        lot[to] += taken;
        allocs.push({ lot, qty: taken, returned: 0 });
        remaining -= taken;
      }
    }
    return allocs;
  }
  giveBack(hold: ModelHold, qty: number, now: number, from: "held" | "consumed") {
    const converted: { origin: string; qty: number }[] = [];
    let remaining = qty;
    let returnedPoints = 0;
    for (const alloc of [...hold.allocs].reverse()) {
      const taken = Math.min(remaining, alloc.qty - alloc.returned);
      if (taken === 0) continue;
      alloc.returned += taken;
      alloc.lot[from] -= taken;
      if (alloc.lot.kind === "addon" || alloc.lot.termId === this.current(now)?.term.id) {
        alloc.lot.available += taken;
        returnedPoints += taken;
      } else {
        alloc.lot.convertedOut += taken;
        converted.push({ origin: alloc.lot.id, qty: taken });
      }
      remaining -= taken;
    }
    expect(remaining).toBe(0);
    hold.returned += qty;
    hold.status =
      from === "held"
        ? "released"
        : hold.returned === hold.qty
          ? "refunded_full"
          : "refunded_partial";
    return { converted, returnedPoints };
  }
  balance(now: number) {
    const sum = (pick: (lot: Lot) => number) =>
      this.lots.reduce((total, lot) => total + pick(lot), 0);
    return {
      subStatus: this.current(now) ? "active" : "expired",
      currentSubscriptionTermId: this.current(now)?.term.id ?? null,
      planAvailableQty: sum((lot) =>
        lot.termId === this.current(now)?.term.id ? lot.available : 0,
      ),
      addonAvailableQty: sum((lot) => (lot.kind === "addon" ? lot.available : 0)),
      heldTotalQty: sum((lot) => lot.held),
    };
  }
}

const db = useSeededDatabase("services");
let prisma: PrismaClient;
let h: LedgerHarness;
beforeAll(async () => {
  prisma = await db.prisma();
  h = createLedgerHarness(prisma);
}, SLOW);

async function assertState(entityId: string, model: ReferenceLedger, now: number) {
  const [account, lots, holds, entries] = await Promise.all([
    prisma.billingAccount.findUniqueOrThrow({ where: { entityId } }),
    prisma.pointLot.findMany({ where: { entityId } }),
    prisma.pointHold.findMany({
      where: { entityId },
      include: { pointHoldAllocs: { orderBy: { allocNo: "asc" } } },
    }),
    prisma.pointLedgerEntry.findMany({ where: { entityId }, orderBy: { seq: "asc" } }),
  ]);
  expect(account).toMatchObject(model.balance(now));
  expect(lots).toHaveLength(model.lots.length);
  const replay = new Map<string, Balances>();
  const bucketOf = (value: string) =>
    value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) as Bucket;
  for (const entry of entries) {
    const state = replay.get(entry.pointLotId) ?? empty();
    if (entry.fromBucket !== "external") state[bucketOf(entry.fromBucket)] -= entry.qty;
    state[bucketOf(entry.toBucket)] += entry.qty;
    replay.set(entry.pointLotId, state);
  }
  for (const expected of model.lots) {
    const actual = lots.find((lot) => lot.id === expected.id);
    expect(actual).toBeDefined();
    expect(actual).toMatchObject({
      kind: expected.kind,
      originalQty: expected.original,
      subscriptionTermId: expected.termId,
    });
    const stored = Object.fromEntries(buckets.map((bucket) => [bucket, actual?.[`${bucket}Qty`]]));
    const reference = Object.fromEntries(buckets.map((bucket) => [bucket, expected[bucket]]));
    expect(stored, `批次 ${expected.id}`).toEqual(reference);
    expect(replay.get(expected.id), "只读流水重建各桶").toEqual(reference);
  }
  const replayLots = lots.map((lot) => ({ ...lot, ...replay.get(lot.id) }));
  expect({
    planAvailableQty: replayLots
      .filter(
        (lot) =>
          lot.kind === "plan" && lot.subscriptionTermId === account.currentSubscriptionTermId,
      )
      .reduce((sum, lot) => sum + (lot.available ?? 0), 0),
    addonAvailableQty: replayLots
      .filter((lot) => lot.kind === "addon")
      .reduce((sum, lot) => sum + (lot.available ?? 0), 0),
    heldTotalQty: replayLots.reduce((sum, lot) => sum + (lot.held ?? 0), 0),
  }).toMatchObject({
    planAvailableQty: account.planAvailableQty,
    addonAvailableQty: account.addonAvailableQty,
    heldTotalQty: account.heldTotalQty,
  });
  expect(holds).toHaveLength(model.holds.length);
  for (const expected of model.holds) {
    const actual = holds.find((hold) => hold.id === expected.id);
    expect(actual).toMatchObject({
      qty: expected.qty,
      status: expected.status,
      returnedQty: expected.returned,
      forfeitedQty: 0,
    });
    expect(
      actual?.pointHoldAllocs.map((alloc) => ({
        id: alloc.pointLotId,
        qty: alloc.qty,
        returned: alloc.returnedQty,
      })),
    ).toEqual(
      expected.allocs.map((alloc) => ({
        id: alloc.lot.id,
        qty: alloc.qty,
        returned: alloc.returned,
      })),
    );
  }
  await h.tx.run(async (tx) => {
    for (const check of billingInvariants.filter((item) => /^billing\.I[1-5]$/.test(item.code))) {
      expect(
        await check.run?.(tx, { entityIds: [entityId] }, { now: new Date(now) }),
        check.code,
      ).toEqual([]);
    }
  });
}

describe("账本模型：每步对照独立桶模型与只读流水回放（甲类）", () => {
  it(
    `随机 1–60 步（${String(runs.numRuns)} 轮，种子 ${String(runs.seed)}）`,
    async () => {
      await fc.assert(
        fc.asyncProperty(scenario, async (given) => {
          // 种子在 2026-01-05 12:00 生效；从次日开始，偏向 29、30、31 日与跨月。
          h.clock.set(startOfDay(addDays("2026-01-06", given.startDay)));
          const { entity, store } = await h.make.merchant({ verified: true });
          const first = await openTerm(h, { entityId: entity.id, months: 3, planCode: "basic" });
          const next = await openTerm(h, {
            entityId: entity.id,
            months: 3,
            planCode: "basic",
            after: first.term,
          });
          const model = new ReferenceLedger([first, next]);
          const staff = await h.make.staff();
          const prices = [100, 1_200, 2_160];
          const dramas = await Promise.all(
            prices.map(async (points) => {
              const drama = await h.make.drama();
              await priceDrama(h, { dramaId: drama.id, points, staffId: staff.id });
              return drama.id;
            }),
          );
          const advance = async (grantScheduleId?: string) => {
            if (grantScheduleId) {
              const replayed = model.granted.has(grantScheduleId);
              expect(await h.tx.run((tx) => h.ledger.grant(tx, { grantScheduleId }))).toMatchObject(
                { points: 3_000, replayed },
              );
            } else await h.tx.run((tx) => h.ledger.advance(tx, entity.id));
            const schedules = await prisma.grantSchedule.findMany({
              where: { entityId: entity.id },
              select: { id: true, pointLotId: true },
            });
            model.advance(
              h.clock.now().getTime(),
              new Map(
                schedules
                  .filter((row) => row.pointLotId !== null)
                  .map((row) => [row.id, row.pointLotId as string]),
              ),
            );
          };
          await advance();
          await assertState(entity.id, model, h.clock.now().getTime());
          for (const command of given.commands) {
            h.clock.advance(
              ["clock", "expire", "grant"].includes(command.action) ? command.days * DAY + 1 : 1,
            );
            const due = [first, next]
              .flatMap((term) => term.schedules)
              .filter((row) => row.dueAt <= h.clock.now());
            const pending = due.filter((row) => !model.granted.has(row.id));
            const pool = pending.length > 0 ? pending : due;
            await advance(
              command.action === "grant" ? pool[command.selector % pool.length]?.id : undefined,
            );
            const now = h.clock.now().getTime();
            const active = model.current(now);
            if (command.action === "purchase") {
              const result = await topUp(h, { entityId: entity.id, points: command.qty });
              model.add(result.pointLotId, "addon", command.qty, now);
            } else if (command.action === "hold") {
              const n = command.selector % prices.length;
              const qty = prices[n] as number;
              const allocs = active ? model.take(qty, now, "held") : null;
              const result = await holdDrama(h, {
                entityId: entity.id,
                storeId: store.id,
                dramaId: dramas[n] as string,
              }).catch((error: unknown) => error);
              if (!allocs)
                expect(result).toMatchObject({
                  error: active ? "POINTS_INSUFFICIENT" : "SUBSCRIPTION_INACTIVE",
                });
              else {
                expect(result).toMatchObject({ points: qty, replayed: false });
                const id = (result as { pointHoldId: string }).pointHoldId;
                model.holds.push({ id, qty, status: "held", returned: 0, allocs });
              }
            } else if (command.action === "adjustPlus" || command.action === "adjustMinus") {
              const increase = command.action === "adjustPlus";
              const taken =
                active && !increase
                  ? model.take(command.qty, now, "adjustedOut", command.kind)
                  : null;
              const result = await adjustPoints(h, {
                entityId: entity.id,
                direction: increase ? "increase" : "decrease",
                lotKind: command.kind,
                points: command.qty,
              }).catch((error: unknown) => error);
              if (!active || (!increase && !taken))
                expect(result).toMatchObject({
                  error: active ? "PRECONDITION_CHANGED" : "SUBSCRIPTION_INACTIVE",
                });
              else {
                expect(result).toMatchObject({
                  deltaPoints: increase ? command.qty : -command.qty,
                  replayed: false,
                });
                if (increase)
                  model.add(
                    (result as { pointLotId: string }).pointLotId,
                    command.kind,
                    command.qty,
                    now,
                    command.kind === "plan" ? active : undefined,
                  );
              }
            } else if (
              ["capture", "release", "refundPartial", "refundAll"].includes(command.action)
            ) {
              const eligible = model.holds.filter((hold) =>
                ["capture", "release"].includes(command.action)
                  ? hold.status === "held"
                  : hold.status === "captured" || hold.status === "refunded_partial",
              );
              const hold = eligible[command.selector % eligible.length];
              if (hold && command.action === "capture") {
                expect(await captureHold(h, hold.id)).toMatchObject({
                  points: hold.qty,
                  replayed: false,
                });
                for (const alloc of hold.allocs) {
                  alloc.lot.held -= alloc.qty;
                  alloc.lot.consumed += alloc.qty;
                }
                hold.status = "captured";
              } else if (hold) {
                const release = command.action === "release";
                const remaining = hold.qty - hold.returned;
                const qty =
                  command.action === "refundPartial" && remaining > 1
                    ? Math.min(command.qty, remaining - 1)
                    : remaining;
                const expected = model.giveBack(hold, qty, now, release ? "held" : "consumed");
                const result = release
                  ? await releaseHold(h, hold.id)
                  : await refundHold(h, { pointHoldId: hold.id, qty });
                expect(result).toMatchObject({
                  returnedPoints: expected.returnedPoints,
                  convertedPoints: expected.converted.reduce((sum, item) => sum + item.qty, 0),
                  forfeitedPoints: 0,
                  replayed: false,
                });
                const identities = await prisma.pointLot.findMany({
                  where: { sourceType: "conversion", sourceId: result.operationId },
                  select: { id: true, originPointLotId: true },
                });
                expect(identities).toHaveLength(expected.converted.length);
                for (const conversion of expected.converted) {
                  const id = identities.find(
                    (lot) => lot.originPointLotId === conversion.origin,
                  )?.id;
                  if (!id) throw new Error("转加购没有批次 id");
                  model.add(id, "addon", conversion.qty, now);
                }
              }
            }
            await assertState(entity.id, model, now);
          }
        }),
        { ...runs, examples: [[{ startDay: 0, commands: crossTermTrace }]] },
      );
    },
    SLOW,
  );
});
