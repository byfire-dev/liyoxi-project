import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { ClientAnalyticsEventSchema } from "@liyoxi/contract";
import type { AnalyticsEventBatch, ClientAnalyticsEvent } from "@liyoxi/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConfig } from "../config/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import { assertNotInTransaction, createTxRunner, uuidv7 } from "../kernel/index.js";
import type { AlertInput, TxRunner } from "../kernel/index.js";
import { createTenant } from "../tenant/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  testDatabaseUrl,
  useSeededDatabase,
} from "../testing/index.js";
import type { Factories } from "../testing/index.js";
import { analyticsDayStart, createAnalyticsReceiver } from "./receive.js";
import type { AnalyticsRequest } from "./receive.js";
import { purgeAnalyticsDedup } from "./dedup-purge.js";

const db = useSeededDatabase("services");
const clock = createClock(new Date("2026-10-08T04:00:00Z"));
let prisma: PrismaClient, owner: PrismaClient, tx: TxRunner, make: Factories;
let receiver: ReturnType<typeof createAnalyticsReceiver>;
const alerts: AlertInput[] = [];
const anonymous: AnalyticsRequest = {
  merchantUserId: null,
  storeId: null,
  flagContext: { platform: "devtools", clientVersion: "1.0.0" },
};
beforeAll(async () => {
  prisma = await db.prisma();
  tx = createTxRunner({ prisma, appEnv: "test" });
  owner = createPrismaClient({
    connectionString: testDatabaseUrl(db.name, { role: null }),
    max: 1,
  });
  // 管理角色仅为隔离测试库准备已存在的分区；生产接收只使用app DML。
  await owner.$queryRaw`SELECT lyx_14_analytics_event_ensure_partition(DATE '2026-09-01')`;
  make = createFactories({ db: prisma, clock });
  const assembly = assembleForTest({ entry: "api" });
  const flow = createFlow({ assembly, clock, events: createEvents({ assembly, clock, tx }) });
  const tenant = createTenant({ tx, clock, assembly, flow });
  const config = createConfig({ db: prisma, clock, redis: null });
  receiver = createAnalyticsReceiver({
    tx,
    clock,
    config,
    tenant,
    alerts: {
      raise: async (input) => {
        assertNotInTransaction("alerts.raise");
        alerts.push(input);
      },
    },
  });
}, 120_000);
afterAll(async () => {
  await owner?.$disconnect();
});
function batch(events: unknown[], anonymousId = uuidv7()): AnalyticsEventBatch {
  return {
    sentAt: clock.now().toISOString(),
    anonymousId,
    sessionId: uuidv7(),
    clientVersion: "1.0.0",
    platform: "devtools",
    events,
  };
}
function launch(at = clock.now().toISOString(), eventId = uuidv7()) {
  return { eventId, name: "app_launch" as const, occurredAt: at, props: { hasInvitation: false } };
}
describe("真实埋点接收", () => {
  it("并发同eventId全站只插一行，大小写UUID也不能绕去重", async () => {
    clock.set(new Date("2026-10-08T04:00:00Z"));
    const input = batch([launch()]),
      eventId = (input.events[0] as ReturnType<typeof launch>).eventId;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => receiver.receive(input, anonymous)),
    );
    expect(results.reduce((n, result) => n + result.accepted, 0)).toBe(1);
    expect(results.reduce((n, result) => n + result.duplicated, 0)).toBe(7);
    expect(await prisma.analyticsEvent.count({ where: { eventId } })).toBe(1);
    expect(
      await receiver.receive(
        batch([launch(clock.now().toISOString(), eventId.toUpperCase())]),
        anonymous,
      ),
    ).toMatchObject({ accepted: 0, duplicated: 1 });
  });
  it("十个严格属性同形；坏属性/伪服务事件逐条拒收而不堵有效事件", async () => {
    clock.set(new Date("2026-10-09T04:00:00Z"));
    const id = uuidv7();
    const props: Record<ClientAnalyticsEvent["name"], unknown> = {
      app_launch: { hasInvitation: true, channelCode: "campaign_a" },
      profile_step_save: { step: 2, durationMs: 42 },
      store_switch: { fromPage: "home" },
      mall_view: { mode: "list", filters: { genre: "love", price: "low" }, sort: "heat" },
      trailer_play: { dramaId: id, playMs: 100, finished: false },
      drama_detail_view: { dramaId: id, fromPage: "mall" },
      share_click: { page: "drama", dramaId: id },
      banner_click: { homeBannerId: id },
      playback_fallback: {
        playableId: id,
        network: "wifi",
        fromQuality: "hd",
        toQuality: "sd",
        sdkVersion: "1.0.0",
      },
      trailer_first_frame: { playableId: id, firstFrameMs: 100, network: "wifi", quality: "hd" },
    };
    const valid = Object.entries(props).map(([name, eventProps]) => ({
      eventId: uuidv7(),
      occurredAt: clock.now().toISOString(),
      name,
      props: eventProps,
    }));
    expect(valid.every((event) => ClientAnalyticsEventSchema.safeParse(event).success)).toBe(true);
    const invalid = [
      { ...launch(), props: { hasInvitation: false, phone: "13800000000" } },
      { ...launch(), props: { hasInvitation: false, channelCode: "13800000000" } },
      { ...launch(), props: { hasInvitation: false, invitationToken: "fixture-token" } },
      { ...launch(), name: "order_submit" },
      ...["constructor", "__proto__", "toString"].map((name) => ({ ...launch(), name })),
      { ...launch(), props: { hasInvitation: false, channelCode: "91310000123456789X" } },
    ];
    expect(await receiver.receive(batch([...valid, ...invalid]), anonymous)).toEqual({
      accepted: 10,
      duplicated: 0,
      rejected: invalid.length,
      dropped: 0,
    });
  });
  it("客户端校时、7天边界与跨月实际分区，跨月重放仍只一条", async () => {
    clock.set(new Date("2026-10-01T04:00:00Z"));
    const edge = launch("2026-09-24T04:00:00Z"),
      stale = launch("2026-09-24T03:59:59.999Z"),
      future = launch("2026-10-03T04:00:00Z");
    const input = batch([edge, stale, future]);
    expect(await receiver.receive(input, anonymous)).toEqual({
      accepted: 2,
      duplicated: 0,
      rejected: 1,
      dropped: 0,
    });
    const rows = await prisma.$queryRaw<
      { eventId: string; partition: string; occurredAt: Date }[]
    >`SELECT event_id AS "eventId", tableoid::regclass::text AS partition, occurred_at AS "occurredAt" FROM analytics_event WHERE event_id IN (${edge.eventId}, ${future.eventId})`;
    expect(rows.find((row) => row.eventId === edge.eventId)?.partition).toBe(
      "analytics_event_y2026m09",
    );
    expect(rows.find((row) => row.eventId === future.eventId)?.occurredAt).toEqual(clock.now());
    expect(await receiver.receive(input, anonymous)).toEqual({
      accepted: 0,
      duplicated: 2,
      rejected: 1,
      dropped: 0,
    });
    const shifted = batch([launch("2026-09-30T03:00:00Z")]);
    shifted.sentAt = "2026-10-01T03:00:00Z";
    await receiver.receive(shifted, anonymous);
    expect(
      (
        await prisma.analyticsEvent.findFirstOrThrow({
          where: { eventId: (shifted.events[0] as ReturnType<typeof launch>).eventId },
        })
      ).occurredAt.toISOString(),
    ).toBe("2026-09-30T04:00:00.000Z");
  });
  it("实际北京时间日上限并发不越界，满额重复仍duplicated，丢弃不占键", async () => {
    clock.set(new Date("2026-10-10T15:59:59Z"));
    await prisma.paramValue.create({
      data: {
        id: uuidv7(),
        key: "analytics.anon.daily_cap",
        value: 3,
        effectiveAt: clock.now(),
        createdAt: clock.now(),
        createdByStaffId: uuidv7(),
      },
    });
    const capReceiver = createAnalyticsReceiver({
      tx,
      clock,
      config: createConfig({ db: prisma, clock, redis: null }),
      tenant: { resolveMembership: async () => null },
      alerts: {
        raise: async (input) => {
          assertNotInTransaction("alerts.raise");
          alerts.push(input);
        },
      },
    });
    const inputs = Array.from({ length: 8 }, () => batch([launch("2026-10-09T04:00:00Z")]));
    const results = await Promise.all(inputs.map((input) => capReceiver.receive(input, anonymous)));
    expect(results.reduce((n, result) => n + result.accepted, 0)).toBe(3);
    expect(results.reduce((n, result) => n + result.dropped, 0)).toBe(5);
    expect(
      await prisma.analyticsEvent.count({
        where: { merchantUserId: null, receivedAt: { gte: analyticsDayStart(clock.now()) } },
      }),
    ).toBe(3);
    const accepted = inputs[results.findIndex((result) => result.accepted === 1)]!;
    expect(await capReceiver.receive(accepted, anonymous)).toMatchObject({
      duplicated: 1,
      dropped: 0,
    });
    const dropped = inputs[results.findIndex((result) => result.dropped === 1)]!;
    expect(
      await prisma.analyticsEventDedup.findUnique({
        where: { eventId: (dropped.events[0] as ReturnType<typeof launch>).eventId },
      }),
    ).toBeNull();
    clock.advance(1000);
    expect(await capReceiver.receive(dropped, anonymous)).toMatchObject({
      accepted: 1,
      dropped: 0,
    });
    expect(
      alerts
        .filter((alert) => alert.rule === "analytics.anon_daily_cap")
        .every(
          (alert) => alert.severity === "P3" && Object.keys(alert.detail).join() === "dropped",
        ),
    ).toBe(true);
  });
  it("可信门店归属；客户端越权门店不落归属；匿名首次绑定不改绑", async () => {
    clock.set(new Date("2026-10-12T04:00:00Z"));
    const merchant = await make.merchant(),
      stranger = await make.merchant();
    const anonymousId = uuidv7(),
      own = { ...launch(), storeId: merchant.store.id },
      foreign = { ...launch(), storeId: stranger.store.id };
    const request: AnalyticsRequest = {
      ...anonymous,
      merchantUserId: merchant.user.id,
      storeId: merchant.store.id,
    };
    await receiver.receive(batch([own, foreign], anonymousId), request);
    expect(
      await prisma.analyticsEvent.findFirst({ where: { eventId: own.eventId } }),
    ).toMatchObject({
      merchantUserId: merchant.user.id,
      actorId: merchant.user.id,
      storeId: merchant.store.id,
      entityId: merchant.entity.id,
      role: "owner",
    });
    expect(
      await prisma.analyticsEvent.findFirst({ where: { eventId: foreign.eventId } }),
    ).toMatchObject({
      merchantUserId: merchant.user.id,
      storeId: null,
      entityId: null,
      role: null,
    });
    await receiver.receive(batch([launch()], anonymousId), {
      ...anonymous,
      merchantUserId: stranger.user.id,
    });
    expect(await prisma.analyticsIdentity.findUnique({ where: { anonymousId } })).toMatchObject({
      merchantUserId: merchant.user.id,
    });
  });
  it("非法批头不写库；去重purge严格8天且有界，原事件保留", async () => {
    const id = uuidv7();
    await expect(
      receiver.receive({ ...batch([launch(undefined, id)]), anonymousId: "not-uuid" }, anonymous),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    expect(await prisma.analyticsEventDedup.findUnique({ where: { eventId: id } })).toBeNull();
    const now = clock.now(),
      before = new Date(now.getTime() - 8 * 86_400_000);
    const earlierCount = await prisma.analyticsEventDedup.count({
      where: { receivedAt: { lt: before } },
    });
    const old = Array.from({ length: 3 }, () => uuidv7()),
      edge = uuidv7();
    await prisma.analyticsEventDedup.createMany({
      data: [
        ...old.map((eventId) => ({ eventId, receivedAt: new Date(before.getTime() - 1) })),
        { eventId: edge, receivedAt: before },
      ],
    });
    const eventCount = await prisma.analyticsEvent.count();
    expect(await tx.run((t) => purgeAnalyticsDedup(t, now, 2))).toBe(2);
    expect(await tx.run((t) => purgeAnalyticsDedup(t, now, 50_000))).toBe(earlierCount + 1);
    expect(
      await prisma.analyticsEventDedup.findUnique({ where: { eventId: edge } }),
    ).not.toBeNull();
    expect(await prisma.analyticsEvent.count()).toBe(eventCount);
  });
});
