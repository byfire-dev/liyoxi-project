import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { DramaPriceListQuerySchema, z } from "@liyoxi/contract";
import {
  useSeededDatabase,
  createClock,
  createFactories,
  assembleForTest,
  createProviderHarness,
} from "../../testing/index.js";
import { buildStaffContext, normalizeRoleConfig } from "../../authz/index.js";
import { staffBriefs } from "../../staff/index.js";
import { createIdentityContext, createTxRunner } from "../../kernel/index.js";
import { createContent } from "../../content/index.js";
import { createEvents } from "../../events/index.js";
import { createFlow } from "../../flow/index.js";
import { createTimers } from "../../timers/index.js";
import { createMedia } from "../../media/index.js";
import { createDramaPricing } from "./revisions.js";
import { priceAt } from "./index.js";
const firedTimer = <T extends { payload: unknown }>(row: T) => ({
  ...row,
  payload: z.record(z.string(), z.unknown()).nullable().parse(row.payload),
});
const db = useSeededDatabase("services"),
  clock = createClock();
async function setup() {
  const prisma = await db.prisma(),
    tx = createTxRunner({ prisma, appEnv: "test" }),
    assembly = assembleForTest({ entry: "worker" }),
    events = createEvents({ tx, clock, assembly }),
    flow = createFlow({ clock, assembly, events }),
    timers = createTimers({ assembly }),
    providers = createProviderHarness({ clock }).providers,
    media = createMedia({ tx, clock, assembly, events, storage: providers.storage }),
    content = createContent({ clock, flow, assembly, events, media }),
    make = createFactories({ db: prisma, clock }),
    employee = await make.staff({ staffRoleKey: "super_admin" }),
    role = await prisma.staffRole.findUniqueOrThrow({ where: { key: "super_admin" } });
  const staff = buildStaffContext({
    staff: {
      id: employee.id,
      roleKey: "super_admin",
      isLead: employee.isLead,
      staffGroupId: employee.staffGroupId,
    },
    role: normalizeRoleConfig("super_admin", role),
    groupStaffIds: [],
    stepUpAt: clock.now(),
  });
  const service = createDramaPricing({
    clock,
    events,
    timers,
    content,
    staffBriefs,
  });
  return {
    prisma,
    tx,
    assembly,
    events,
    timers,
    media,
    content,
    make,
    employee,
    staff,
    service,
    identity: createIdentityContext({ actor: { type: "staff", id: employee.id, client: "admin" } }),
  };
}
let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  h = await setup();
}, 180000);
afterAll(async () => {
  await h?.media.jobs.shutdown();
});
const input = (points: number, currentPoints: number | null, date: string | null = null) => ({
  mode: "custom" as const,
  customPoints: points,
  effectiveDate: date,
  reasonCode: "quality" as const,
  note: null,
  confirm: { currentPoints },
});
const create = (id: string, points: number, current: number | null, date: string | null = null) =>
  h.tx.run((t) => h.service.create(t, h.staff, h.identity, id, input(points, current, date)));
it("立即单剧调价只增，snapshot旧价真实，事件/审计同TX，冻结订单未写", async () => {
  const d = await h.make.drama({ status: "draft", heatTier: "A" });
  const result = await create(d.id, 1700, 2000);
  expect(result.revision).toMatchObject({
    prevPoints: 2000,
    newPoints: 1700,
    mode: "custom",
    state: "effective",
  });
  expect((await priceAt(h.prisma, [d.id], clock.now())).get(d.id)).toMatchObject({ points: 1700 });
  expect(
    await h.prisma.auditLog.count({
      where: { targetType: "drama_price_revision", targetId: result.revision.dramaPriceRevisionId },
    }),
  ).toBe(1);
  expect(
    await h.prisma.outboxEvent.count({
      where: {
        eventType: "pricing.drama_price_changed",
        aggregateId: result.revision.dramaPriceRevisionId,
      },
    }),
  ).toBe(1);
  expect(await h.prisma.orderItem.count()).toBe(0);
});
it("未来上海00生效读取不等timer，延迟timer只发一次；撤销仅未来且原快照保留", async () => {
  clock.set(new Date("2026-01-05T04:00:00Z"));
  const d = await h.make.drama({ status: "draft", heatTier: "A" }),
    future = await create(d.id, 1600, 2000, "2026-01-07"),
    id = future.revision.dramaPriceRevisionId;
  expect((await priceAt(h.prisma, [d.id], clock.now())).get(d.id)).toMatchObject({ points: 2000 });
  clock.set(new Date("2026-01-06T16:00:00Z"));
  expect((await priceAt(h.prisma, [d.id], clock.now())).get(d.id)).toMatchObject({ points: 1600 });
  const timer = await h.prisma.timer.findFirstOrThrow({ where: { subjectId: id } });
  expect(timer.fireAt).toEqual(clock.now());
  clock.advance(86400000);
  await h.tx.run((t) => h.service.effective(t, firedTimer(timer)));
  await h.tx.run((t) => h.service.effective(t, firedTimer(timer)));
  expect(await h.prisma.outboxEvent.count({ where: { aggregateId: id } })).toBe(1);
  await expect(
    h.tx.run((t) => h.service.withdraw(t, h.staff, h.identity, id, {})),
  ).rejects.toMatchObject({ error: "REVISION_ALREADY_EFFECTIVE" });
  const second = await create(d.id, 1500, 1600, "2026-01-10"),
    before = await h.prisma.dramaPriceRevision.findUniqueOrThrow({
      where: { id: second.revision.dramaPriceRevisionId },
    });
  await h.tx.run((t) =>
    h.service.withdraw(t, h.staff, h.identity, before.id, { note: "取消本次计划" }),
  );
  const after = await h.prisma.dramaPriceRevision.findUniqueOrThrow({ where: { id: before.id } });
  expect({ ...after, cancelledAt: null }).toEqual(before);
  expect(after.cancelledAt).toEqual(clock.now());
  expect((await h.prisma.timer.findFirstOrThrow({ where: { subjectId: before.id } })).status).toBe(
    "cancelled",
  );
  expect(await h.prisma.outboxEvent.count({ where: { aggregateId: before.id } })).toBe(0);
});
it("两真实连接咨询锁串行：后一等待后重读确认，胜者一条修订，失败零写", async () => {
  clock.set(new Date("2026-01-05T04:00:00Z"));
  const d = await h.make.drama({ status: "draft", heatTier: "A" });
  let entered!: () => void, release!: () => void;
  let firstPid: number | undefined, secondPid: number | undefined;
  const held = new Promise<void>((resolve) => (release = resolve)),
    ready = new Promise<void>((resolve) => (entered = resolve));
  const first = h.tx.run(async (t) => {
    firstPid = (await t.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
    await t.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pricing.drama:${d.id}`},0))`;
    entered();
    await held;
    return h.service.create(t, h.staff, h.identity, d.id, input(1500, 2000));
  });
  void first.catch(() => {});
  await Promise.race([ready, first]);
  const second = h.tx.run(async (t) => {
    secondPid = (await t.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
    return h.service.create(t, h.staff, h.identity, d.id, input(1400, 2000));
  });
  const observed = second.then(
    () => "ok",
    (error) => error,
  );
  try {
    await vi.waitFor(async () => {
      expect(secondPid).toBeDefined();
      expect(secondPid).not.toBe(firstPid);
      const rows = await h.prisma.$queryRaw<{ blockers: number[] }[]>`
        SELECT pg_blocking_pids(${secondPid!}::integer) AS blockers`;
      expect(rows[0]!.blockers).toContain(firstPid);
    });
    release();
    await first;
    expect(await observed).toMatchObject({ error: "CONFIRM_MISMATCH" });
    expect(await h.prisma.dramaPriceRevision.count({ where: { dramaId: d.id } })).toBe(1);
  } finally {
    release();
    await Promise.allSettled([first, second]);
  }
});
it("相同生效时刻/同价/今天日期/template配对/归档与缺等级正式拒绝", async () => {
  clock.set(new Date("2026-01-05T04:00:00Z"));
  const d = await h.make.drama({ status: "draft", heatTier: "A" });
  await expect(create(d.id, 2000, 2000)).rejects.toMatchObject({
    error: "DRAMA_PRICE_UNCHANGED",
    details: { currentPoints: 2000 },
  });
  await expect(create(d.id, 1400, 2000, "2026-01-05")).rejects.toMatchObject({
    error: "VALIDATION_FAILED",
  });
  await create(d.id, 1400, 2000, "2026-01-07");
  await expect(create(d.id, 1300, 2000, "2026-01-07")).rejects.toMatchObject({
    error: "DRAMA_PRICE_EFFECTIVE_AT_TAKEN",
  });
  const empty = await h.make.drama({ status: "draft", heatTier: null });
  await expect(
    h.tx.run((t) =>
      h.service.create(t, h.staff, h.identity, empty.id, {
        mode: "template",
        customPoints: null,
        effectiveDate: null,
        reasonCode: "restore_template",
        confirm: { currentPoints: null },
      }),
    ),
  ).rejects.toMatchObject({ error: "HEAT_TIER_MISSING" });
  const archived = await h.make.drama({
    status: "delisted",
    heatTier: "A",
    archivedAt: clock.now(),
  });
  await expect(create(archived.id, 1100, 2000)).rejects.toMatchObject({
    error: "DRAMA_PRICE_LOCKED",
    details: { reason: "archived", stopOrderDate: null },
  });
});
it("等级真实producer/订阅重放幂等、custom不受影响，列表与summary零写全局计数", async () => {
  clock.set(new Date("2026-01-05T04:00:00Z"));
  const d = await h.make.drama({ status: "draft", heatTier: "A" });
  await h.tx.run((t) =>
    h.content.saveCommercial(t, h.identity, d.id, { lockVersion: 0, heatTier: "B" }),
  );
  const event = await h.prisma.outboxEvent.findFirstOrThrow({
    where: { eventType: "drama.tier_changed", aggregateId: d.id },
  });
  expect(event.payload).toMatchObject({ fromTier: "A", toTier: "B" });
  await h.tx.run((t) =>
    h.service.onTierChanged(t, {
      id: event.id,
      type: event.eventType,
      payload: event.payload as Record<string, unknown>,
    }),
  );
  await h.tx.run((t) =>
    h.service.onTierChanged(t, {
      id: event.id,
      type: event.eventType,
      payload: event.payload as Record<string, unknown>,
    }),
  );
  expect(
    await h.prisma.outboxEvent.count({
      where: { eventType: "pricing.drama_price_changed", aggregateId: d.id },
    }),
  ).toBe(1);
  const custom = await h.make.drama({ status: "draft", heatTier: "A" });
  await create(custom.id, 1700, 2000);
  clock.advance(1);
  await h.tx.run((t) =>
    h.content.saveCommercial(t, h.identity, custom.id, { lockVersion: 0, heatTier: "B" }),
  );
  const next = await h.prisma.outboxEvent.findFirstOrThrow({
    where: { eventType: "drama.tier_changed", aggregateId: custom.id },
  });
  await h.tx.run((t) =>
    h.service.onTierChanged(t, {
      id: next.id,
      type: next.eventType,
      payload: next.payload as Record<string, unknown>,
    }),
  );
  expect(
    await h.prisma.outboxEvent.count({
      where: { eventType: "pricing.drama_price_changed", aggregateId: custom.id },
    }),
  ).toBe(0);
  const before = await h.prisma.auditLog.count();
  const page = await h.tx.run((t) =>
    h.service.list(t, h.staff, DramaPriceListQuerySchema.parse({ q: d.title })),
  );
  expect(page.items.map((v) => v.dramaId)).toContain(d.id);
  expect((await h.tx.run((t) => h.service.summary(t, h.staff))).customPriced).toBeGreaterThan(0);
  expect(await h.prisma.auditLog.count()).toBe(before);
});
