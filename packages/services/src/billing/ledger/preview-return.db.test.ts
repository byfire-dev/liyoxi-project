import { beforeAll, expect, it } from "vitest";
import {
  adjustPoints,
  assertSnapshotsEqual,
  captureHold,
  createLedgerHarness,
  holdDrama,
  joinLedger,
  openTerm,
  priceDrama,
  refundHold,
  releaseHold,
  snapshotTables,
  topUp,
  useSeededDatabase,
} from "../../testing/index.js";
import type { LedgerHarness } from "../../testing/index.js";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import type { ReturnReasonClass, ReturnResult } from "../index.js";
import { previewReturn } from "../index.js";

const db = useSeededDatabase("services", { max: 1 });
const TABLES = [
  "billing_account",
  "subscription_term",
  "grant_schedule",
  "point_lot",
  "point_hold",
  "point_hold_alloc",
  "ledger_operation",
  "point_ledger_entry",
  "outbox_event",
];
const at = (s: string) => new Date(`${s}+08:00`);
let h: LedgerHarness;
let staffId: string;
beforeAll(async () => {
  h = createLedgerHarness(await db.prisma());
  staffId = (await h.make.staff()).id;
}, 120000);

async function setup(date = "2026-01-05T12:00:00", points = 100) {
  h.clock.set(at(date));
  const who = await h.make.merchant({ verified: true });
  const { term } = await openTerm(h, { entityId: who.entity.id });
  const drama = await h.make.drama({ heatTier: "A" });
  await priceDrama(h, { dramaId: drama.id, points, staffId });
  return { entityId: who.entity.id, storeId: who.store.id, term, dramaId: drama.id };
}
const preview = (holdId: string, qty: number, reasonClass: ReturnReasonClass = "merchant") =>
  h.tx.run((tx) => previewReturn(tx, { holdId, qty, reasonClass }, h.clock.now()));
const counts = (r: ReturnResult) => ({
  backToOriginal: r.returnedPoints,
  convertedToAddon: r.convertedPoints,
  forfeited: r.forfeitedPoints,
});

it("真实混合批次从尾部退，重复预览零写，和真实部分退回及后续剩余分摊一致", async () => {
  const who = await setup("2026-03-05T12:00:00", 2400);
  await topUp(h, { entityId: who.entityId, points: 1000 });
  await adjustPoints(h, { ...who, direction: "decrease", lotKind: "plan", points: 4680 });
  const held = await holdDrama(h, who);
  await captureHold(h, held.pointHoldId);
  const before = await snapshotTables(h.prisma, TABLES);
  const first = await preview(held.pointHoldId, 300);
  expect(first).toMatchObject({
    qty: 300,
    backToOriginal: 300,
    convertedToAddon: 0,
    forfeited: 0,
    arbitrageHint: false,
  });
  expect(first.lots).toEqual([
    { lotKind: "addon", qty: 240, route: "original" },
    { lotKind: "plan", qty: 60, route: "original", expiresAt: who.term.endsAt.toISOString() },
  ]);
  expect(await preview(held.pointHoldId, 300)).toEqual(first);
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
  expect(first).toMatchObject(
    counts(await refundHold(h, { pointHoldId: held.pointHoldId, qty: 300 })),
  );
  const rest = await preview(held.pointHoldId, 1860);
  expect(rest.lots).toEqual([
    { lotKind: "plan", qty: 1860, route: "original", expiresAt: who.term.endsAt.toISOString() },
  ]);
  expect(rest).toMatchObject(
    counts(await refundHold(h, { pointHoldId: held.pointHoldId, qty: 1860 })),
  );
});

it("周期临界与扫描未推进时现算去向，新周期已到点也不把旧套餐退到新周期", async () => {
  const who = await setup("2026-05-05T12:00:00");
  const held = await holdDrama(h, who);
  await captureHold(h, held.pointHoldId);
  const next = await openTerm(h, { entityId: who.entityId, after: who.term });
  h.clock.set(new Date(who.term.endsAt.getTime() - 1));
  expect(await preview(held.pointHoldId, held.points)).toMatchObject({
    backToOriginal: 90,
    convertedToAddon: 0,
  });
  h.clock.set(who.term.endsAt);
  const before = await snapshotTables(h.prisma, TABLES);
  const p = await preview(held.pointHoldId, held.points, "platform");
  expect(p).toMatchObject({ backToOriginal: 0, convertedToAddon: 90, forfeited: 0 });
  expect(
    await h.prisma.billingAccount.findUniqueOrThrow({ where: { entityId: who.entityId } }),
  ).toMatchObject({ currentSubscriptionTermId: who.term.id });
  expect(
    await h.prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: next.term.id } }),
  ).toMatchObject({ status: "scheduled" });
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
  expect(p).toMatchObject(
    counts(
      await refundHold(h, {
        pointHoldId: held.pointHoldId,
        qty: held.points,
        reasonClass: "platform",
      }),
    ),
  );
});

it("释放跨过周期也按原快照三类原因，当前参数改变不改历史；真实释放同值", async () => {
  h.clock.set(at("2040-01-01T12:00:00"));
  const rule = (merchant: "addon" | "forfeit", effectiveAt: Date) => ({
    id: uuidv7(),
    key: "expiredTermRefund",
    value: { merchant, platform: "addon", qualification: "addon" },
    effectiveAt,
    changeId: uuidv7(),
    createdAt: h.clock.now(),
  });
  await h.prisma.billingParam.createMany({
    data: [rule("forfeit", at("2040-01-01T00:00:00")), rule("addon", at("2040-03-01T00:00:00"))],
  });
  const who = await setup("2040-01-10T12:00:00");
  const holds = [];
  for (let i = 0; i < 3; i++) holds.push(await holdDrama(h, who));
  h.clock.set(at("2040-03-10T12:00:00"));
  for (const [i, reason] of (["merchant", "platform", "qualification"] as const).entries()) {
    const held = holds[i]!;
    const before = await snapshotTables(h.prisma, TABLES);
    const p = await preview(held.pointHoldId, held.points, reason);
    expect(p).toMatchObject({
      backToOriginal: 0,
      convertedToAddon: reason === "merchant" ? 0 : 90,
      forfeited: reason === "merchant" ? 90 : 0,
    });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    expect(p).toMatchObject(counts(await releaseHold(h, held.pointHoldId, reason)));
  }
});

it("实际全额释放前预览同值；扣减后的零数量仅终止无去向也零写", async () => {
  const who = await setup();
  const first = await holdDrama(h, who);
  const p = await preview(first.pointHoldId, first.points);
  expect(p).toMatchObject(counts(await releaseHold(h, first.pointHoldId)));
  const second = await holdDrama(h, who);
  await captureHold(h, second.pointHoldId);
  const before = await snapshotTables(h.prisma, TABLES);
  expect(await preview(second.pointHoldId, 0)).toEqual({
    qty: 0,
    backToOriginal: 0,
    convertedToAddon: 0,
    forfeited: 0,
    lots: [],
    arbitrageHint: false,
  });
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
});

it("调用方事务里可见实际未提交退回，外层失败时流水及预览来源整体回滚", async () => {
  const who = await setup();
  const held = await holdDrama(h, who);
  await captureHold(h, held.pointHoldId);
  const before = await snapshotTables(h.prisma, TABLES);
  await expect(
    h.tx.run(async (tx) => {
      await h.ledger.refund(tx, {
        pointHoldId: held.pointHoldId,
        qty: 30,
        reasonClass: "platform",
        source: { type: "cancel_request_line", id: uuidv7() },
        refNo: "LYX-TEST",
        ctx: createIdentityContext({ actor: { type: "system", job: "test.preview-return" } }),
      });
      expect(
        await previewReturn(
          tx,
          { holdId: held.pointHoldId, qty: 60, reasonClass: "platform" },
          h.clock.now(),
        ),
      ).toMatchObject({ backToOriginal: 60, convertedToAddon: 0 });
      await expect(
        previewReturn(
          tx,
          { holdId: held.pointHoldId, qty: 61, reasonClass: "platform" },
          h.clock.now(),
        ),
      ).rejects.toMatchObject({ reason: "exceeds_refundable" });
      throw new Error("outer rollback");
    }),
  ).rejects.toThrow("outer rollback");
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
  expect(await preview(held.pointHoldId, 90)).toMatchObject({ backToOriginal: 90 });
});

it("套利提示按真实期限严格不足七天且已过原周期，零数量不提示", async () => {
  const who = await setup();
  h.clock.set(new Date(who.term.endsAt.getTime() - 7 * 24 * 60 * 60 * 1000));
  const seven = await holdDrama(h, who);
  h.clock.set(new Date(h.clock.now().getTime() + 1)); // 比七天少一毫秒
  const six = await holdDrama(h, who);
  await captureHold(h, six.pointHoldId);
  expect(await preview(six.pointHoldId, 90)).toMatchObject({ arbitrageHint: false });
  h.clock.set(who.term.endsAt);
  const before = await snapshotTables(h.prisma, TABLES);
  expect(await preview(seven.pointHoldId, 90)).toMatchObject({ arbitrageHint: false });
  expect(await preview(six.pointHoldId, 90)).toMatchObject({ arbitrageHint: true });
  expect(await preview(six.pointHoldId, 0)).toMatchObject({ arbitrageHint: false });
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
});

it("无效数量、时刻、冻结部分释放、已释放与超可退范围拒绝且零写", async () => {
  const who = await setup();
  const held = await holdDrama(h, who);
  const before = await snapshotTables(h.prisma, TABLES);
  for (const qty of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, 0, 89])
    await expect(preview(held.pointHoldId, qty)).rejects.toMatchObject({ reason: "guard" });
  await expect(
    h.tx.run((tx) =>
      previewReturn(
        tx,
        { holdId: held.pointHoldId, qty: 90, reasonClass: "merchant" },
        new Date("invalid"),
      ),
    ),
  ).rejects.toMatchObject({ reason: "guard" });
  await expect(preview(uuidv7(), 90)).rejects.toMatchObject({ reason: "guard" });
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
  await releaseHold(h, held.pointHoldId);
  await expect(preview(held.pointHoldId, 90)).rejects.toMatchObject({ reason: "not_captured" });
  const captured = await holdDrama(h, who);
  await captureHold(h, captured.pointHoldId);
  const after = await snapshotTables(h.prisma, TABLES);
  await expect(preview(captured.pointHoldId, 91)).rejects.toMatchObject({
    reason: "exceeds_refundable",
  });
  assertSnapshotsEqual(after, await snapshotTables(h.prisma, TABLES));
});

it("真实独立连接占有账户写锁时仍可预览，不拿账户锁也不推进", async () => {
  const who = await setup();
  const held = await holdDrama(h, who);
  const other = await joinLedger(h, await db.url());
  let ready!: () => void;
  let release!: () => void;
  const locked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holderPid = 0;
  const holder = other.tx.run(
    async (tx) => {
      await other.ledger.lockAccount(tx, who.entityId);
      holderPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      ready();
      await done;
    },
    { timeoutMs: 10000 },
  );
  try {
    await locked;
    const before = await snapshotTables(h.prisma, TABLES);
    await h.tx.run(async (tx) => {
      const pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      expect(pid).not.toBe(holderPid);
      // 给误拿写锁的实现一个确定拒绝边界，不用吞吐量或机器速度判定只读。
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '2000ms'");
      expect(
        await previewReturn(
          tx,
          { holdId: held.pointHoldId, qty: 90, reasonClass: "merchant" },
          h.clock.now(),
        ),
      ).toMatchObject({ backToOriginal: 90 });
    });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
  } finally {
    release();
    await holder;
    await other.close();
  }
});
