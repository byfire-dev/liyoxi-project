import { createPrismaClient } from "@liyoxi/db";
import type { Ad, PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTxRunner, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { createClock, createFactories, useSeededDatabase } from "../testing/index.js";
import { clearAdCancelRequestPointers } from "./index.js";

const db = useSeededDatabase("services", { max: 1 });
const clock = createClock();
let prisma: PrismaClient, other: PrismaClient;
let run: ReturnType<typeof createTxRunner>;
let sequence = 80000;
beforeAll(async () => {
  prisma = await db.prisma();
  run = createTxRunner({ prisma, appEnv: "test" });
  other = await createPrismaClient({ connectionString: await db.url(), max: 1 });
}, 120000);
afterAll(async () => {
  await other?.$disconnect();
});

// Real table preconditions for this owner helper; not an ad/cancel/ledger producer.
async function ad(storeId: string) {
  const make = createFactories({ db: prisma, clock });
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    include: { entity: true },
  });
  const id = uuidv7(),
    now = clock.now();
  const hold = await make.pointHold({
    entityId: store.entityId,
    storeId,
    purpose: "ad",
    refType: "ad",
    refId: id,
  });
  const consent = await make.agreementConsent({
    scene: "ad_request",
    merchantUserId: store.entity.createdByUserId,
    entityId: store.entityId,
    storeId,
    bizId: id,
  });
  return prisma.ad.create({
    data: {
      id,
      adNo: `GG20260105${sequence++}`,
      entityId: store.entityId,
      storeId,
      requestedByUserId: store.entity.createdByUserId,
      type: "opening",
      durationSec: 3,
      promoPointCodes: ["TEST"],
      status: "pending_assign",
      unitPricePoints: 100,
      discountBp: 10000,
      chargePoints: 100,
      pricingSnapshot: {},
      pointHoldId: hold.id,
      freeRevisionQuota: 2,
      agreementConsentId: consent.id,
      submittedAt: now,
      firstDueAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
}
async function request(target: Ad) {
  const make = createFactories({ db: prisma, clock });
  const staff = await make.staff({ staffRoleKey: "cs" });
  const id = uuidv7(),
    approvalId = uuidv7(),
    lineId = uuidv7(),
    now = clock.now();
  await prisma.approvalRequest.create({
    data: {
      id: approvalId,
      requestNo: `TK20260105${sequence++}`,
      kind: "ad_cancel",
      category: "approval",
      subjectType: "ad",
      subjectId: target.id,
      entityId: target.entityId,
      storeId: target.storeId,
      status: "pending",
      summarySnapshot: {
        title: "取消广告表事实",
        points: 100,
        domain: { type: "cancel_request", id },
      },
      requesterStaffId: staff.id,
      submitActorType: "staff",
      submitActorId: staff.id,
      submitClient: "admin",
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  const row = await prisma.cancelRequest.create({
    data: {
      id,
      approvalRequestId: approvalId,
      kind: "ad_cancel",
      entityId: target.entityId,
      storeId: target.storeId,
      adId: target.id,
      reasonCode: "merchant_request",
      note: "仅验证所属广告指针清理",
      lineCount: 1,
      totalBasePoints: 100,
      totalDeductPoints: 0,
      totalRefundPoints: 100,
      status: "pending_approval",
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.cancelRequestLine.create({
    data: {
      id: lineId,
      cancelRequestId: id,
      entityId: target.entityId,
      storeId: target.storeId,
      targetType: "ad",
      targetId: target.id,
      pointHoldId: target.pointHoldId,
      mode: "release",
      stage: "ad_unassigned",
      stepAtSubmit: "pending_assign",
      reasonClass: "merchant",
      chargePoints: 100,
      priorRequestedPoints: 0,
      deductPoints: 0,
      refundPoints: 100,
      previewSnapshot: {},
      createdAt: now,
    },
  });
  await prisma.ad.update({ where: { id: target.id }, data: { openCancelRequestId: id } });
  return { ...row, lineId };
}
type Request = Awaited<ReturnType<typeof request>>;
const at = () => new Date(clock.now().getTime() + 60000);
function input(row: Request, adIds: readonly string[]) {
  return {
    entityId: row.entityId,
    storeId: row.storeId,
    cancelRequestId: row.id,
    adIds,
    now: at(),
  };
}
// Only raw closure preconditions, not approval callbacks/history/event acceptance.
async function closeFacts(tx: Tx, row: Request) {
  await lockRows(tx, "approval_request", [row.approvalRequestId]);
  await lockRows(tx, "cancel_request", [row.id]);
  await lockRows(tx, "cancel_request_line", [row.lineId]);
  await tx.approvalRequest.updateMany({
    where: { id: row.approvalRequestId, status: "pending" },
    data: { status: "withdrawn", isDecidedBySystem: true, decidedAt: at() },
  });
  await tx.cancelRequest.updateMany({
    where: { id: row.id, closedAt: null },
    data: { status: "not_executed", closeReason: "withdrawn", closedAt: at() },
  });
}
async function fixture() {
  const make = createFactories({ db: prisma, clock }),
    m = await make.merchant();
  const a = await ad(m.store.id),
    b = await ad(m.store.id),
    plain = await ad(m.store.id);
  return { m, a, b, plain, first: await request(a), second: await request(b) };
}
const ads = (ids: readonly string[]) =>
  prisma.ad.findMany({ where: { id: { in: [...ids] } }, orderBy: { id: "asc" } });

it("精确申请与ID集合，只更新匹配指针及版本时间；重复/重复ID/无指针均零副作用", async () => {
  const f = await fixture(),
    ids = [f.a.id, f.b.id, f.plain.id],
    before = await ads(ids);
  const ledger = await prisma.pointHold.findMany({
    where: { storeId: f.m.store.id },
    orderBy: { id: "asc" },
  });
  const consent = await prisma.agreementConsent.findMany({
    where: { storeId: f.m.store.id },
    orderBy: { id: "asc" },
  });
  const side = {
    audit: await prisma.auditLog.count(),
    histories: await prisma.statusTransition.count(),
    events: await prisma.outboxEvent.count(),
    versions: await prisma.adVersion.count(),
    revisions: await prisma.adRevision.count(),
  };
  await run.run(async (tx) => {
    await closeFacts(tx, f.first);
    expect(
      await clearAdCancelRequestPointers(tx, input(f.first, [...ids, f.a.id.toUpperCase()])),
    ).toBe(1);
    expect(await clearAdCancelRequestPointers(tx, input(f.first, ids))).toBe(0);
  });
  const after = await ads(ids);
  expect(after).toEqual(
    before.map((row) =>
      row.id === f.a.id
        ? { ...row, openCancelRequestId: null, lockVersion: row.lockVersion + 1, updatedAt: at() }
        : row,
    ),
  );
  await run.run(async (tx) => {
    expect(await clearAdCancelRequestPointers(tx, input(f.first, ids))).toBe(0);
    expect(await clearAdCancelRequestPointers(tx, input(f.first, []))).toBe(0);
    expect(
      await clearAdCancelRequestPointers(tx, { ...input(f.first, ids), cancelRequestId: uuidv7() }),
    ).toBe(0);
  });
  expect(await ads(ids)).toEqual(after);
  expect(
    await prisma.pointHold.findMany({ where: { storeId: f.m.store.id }, orderBy: { id: "asc" } }),
  ).toEqual(ledger);
  expect(
    await prisma.agreementConsent.findMany({
      where: { storeId: f.m.store.id },
      orderBy: { id: "asc" },
    }),
  ).toEqual(consent);
  expect({
    audit: await prisma.auditLog.count(),
    histories: await prisma.statusTransition.count(),
    events: await prisma.outboxEvent.count(),
    versions: await prisma.adVersion.count(),
    revisions: await prisma.adRevision.count(),
  }).toEqual(side);
});

it("同主体其他门店、跨主体及不存在的混合ID均原子拒绝且不先清本店", async () => {
  const f = await fixture(),
    make = createFactories({ db: prisma, clock });
  const sibling = await make.store({ entityId: f.m.entity.id }),
    foreign = await make.merchant();
  const s = await ad(sibling.id),
    b = await ad(foreign.store.id);
  await request(s);
  await request(b);
  const ids = [f.a.id, s.id, b.id],
    before = await ads(ids);
  for (const wrong of [s.id, b.id, uuidv7()]) {
    await expect(
      run.run(async (tx) => {
        await closeFacts(tx, f.first);
        await clearAdCancelRequestPointers(tx, input(f.first, [f.a.id, wrong]));
      }),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    expect(await ads(ids)).toEqual(before);
    expect(
      (await prisma.cancelRequest.findUniqueOrThrow({ where: { id: f.first.id } })).closedAt,
    ).toBeNull();
  }
});

it("调用方事务未提交的指针变化可见，外层失败保留申请与广告全部原值", async () => {
  const f = await fixture(),
    before = await ads([f.a.id, f.b.id, f.plain.id]);
  const failure = new Error("caller rollback");
  await expect(
    run.run(async (tx) => {
      await closeFacts(tx, f.first);
      await lockRows(tx, "ad", [f.a.id, f.plain.id]);
      await tx.ad.update({ where: { id: f.a.id }, data: { openCancelRequestId: null } });
      await tx.ad.update({ where: { id: f.plain.id }, data: { openCancelRequestId: f.first.id } });
      expect(await clearAdCancelRequestPointers(tx, input(f.first, [f.a.id, f.plain.id]))).toBe(1);
      expect(
        (await tx.ad.findUniqueOrThrow({ where: { id: f.plain.id } })).openCancelRequestId,
      ).toBeNull();
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(await ads([f.a.id, f.b.id, f.plain.id])).toEqual(before);
  expect(
    (await prisma.cancelRequest.findUniqueOrThrow({ where: { id: f.first.id } })).closedAt,
  ).toBeNull();
});

it("双独立连接重复清理，真实count合计1且只增加一次版本", async () => {
  const runners = [run, createTxRunner({ prisma: other, appEnv: "test" })];
  const pids = await Promise.all(
    [prisma, other].map((p) => p.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`),
  );
  expect(new Set(pids.flat().map((row) => row.pid)).size).toBe(2);
  for (let round = 0; round < 3; round++) {
    const f = await fixture();
    const counts = await Promise.all(
      runners.map((runner) =>
        runner.run(async (tx) => {
          await closeFacts(tx, f.first);
          return clearAdCancelRequestPointers(tx, input(f.first, [f.a.id]));
        }),
      ),
    );
    expect(counts.sort()).toEqual([0, 1]);
    const actual = await prisma.ad.findUniqueOrThrow({ where: { id: f.a.id } });
    expect(actual.openCancelRequestId).toBeNull();
    expect(actual.lockVersion).toBe(f.a.lockVersion + 1);
    expect((await prisma.ad.findUniqueOrThrow({ where: { id: f.b.id } })).openCancelRequestId).toBe(
      f.second.id,
    );
  }
});
