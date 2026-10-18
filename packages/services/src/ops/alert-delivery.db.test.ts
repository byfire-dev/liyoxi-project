import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assembleForTest, notificationFixture, useSeededDatabase } from "../testing/index.js";
import { notificationFailed, notificationOk } from "../providers/types.js";
import { sendSystemAlert } from "../notify/index.js";
import { createAlertDispatcher } from "./alert-delivery.js";
import type { AlertDispatcherOptions } from "./alert-delivery.js";
import { resolveQuietEventFacts, writeAlertFact, writeHealthyProbeFact } from "./alert-facts.js";

const db = useSeededDatabase("services", { max: 1, label: "alertsend" });
let h: ReturnType<typeof notificationFixture>;
let adminId: string;
const dispatchers: ReturnType<typeof createAlertDispatcher>[] = [];
beforeEach(async () => {
  await db.reset();
  h = notificationFixture(await db.prisma());
  h.clock.set(new Date("2026-10-14T00:00:00Z"));
  adminId = (await h.make.staff({ staffRoleKey: "super_admin" })).id;
  const wall = new Date();
  await h.prisma.workerLease.create({
    data: {
      name: "primary",
      holder: "alert-test",
      holderVersion: "test",
      acquiredAt: wall,
      heartbeatAt: wall,
    },
  });
});
afterEach(async () => {
  for (const dispatcher of dispatchers.splice(0)) await dispatcher.close();
  await h?.service.close();
});
const rejected = () =>
  notificationFailed("rejected", "测试明确拒绝", {
    acceptance: "not_accepted",
    code: "provider_rejected",
  });
const unknown = () =>
  notificationFailed("unavailable", "测试结果未知", {
    acceptance: "unknown",
    code: "unknown_outcome",
  });
function setup(overrides: Partial<AlertDispatcherOptions> = {}) {
  const robot = vi.fn<AlertDispatcherOptions["robot"]>(async () => notificationOk(undefined));
  const sms = vi.fn<AlertDispatcherOptions["sms"]>(async () => ({
    accepted: true,
    unknown: false,
    configured: true,
  }));
  const assembly = assembleForTest({ entry: "worker" });
  const options: AlertDispatcherOptions = {
    tx: h.tx,
    clock: h.clock,
    logger: h.deps.logger,
    holder: () => "alert-test",
    config: { oncallPhones: ["13800138000"] },
    robot,
    sms,
    bell: (tx, input) => sendSystemAlert(tx, input, assembly),
    ...overrides,
  };
  const dispatcher = createAlertDispatcher(options);
  dispatchers.push(dispatcher);
  return { robot, sms, dispatcher, options };
}
async function breach(
  severity: "P1" | "P2" | "P3" = "P1",
  rule = "billing.unfulfilled",
  dimension = "small",
) {
  await h.tx.run((tx) =>
    writeAlertFact(tx, { rule, dimension, severity, detail: {} }, "probe", h.clock.now()),
  );
  return h.prisma.alertEvent.findFirstOrThrow({
    where: { fingerprint: `${rule}:${dimension}`, status: "open" },
  });
}
async function state(id: string) {
  return (await h.prisma.alertEvent.findUniqueOrThrow({ where: { id } })).lastValue as {
    _delivery: { robot: { status: string }; sms: { status: string }; bell: { status: string } };
    _recoveryReason?: string;
  };
}

it("P1各通道持久化独立、真实逐人SMS与铃铛幂等，采样不擦状态，重复/认领间隔保持", async () => {
  await h.prisma.smsTemplate.update({
    where: { templateKey: "ops_alert" },
    data: {
      status: "active",
      providerTemplateId: "publicfake",
      signName: "测试",
      updatedAt: h.clock.now(),
    },
  });
  const { dispatcher, robot } = setup({
    sms: (input) => h.service.sendOpsAlert(input),
    config: { oncallPhones: ["13800138000", "13900139000"] },
  });
  robot.mockResolvedValueOnce(rejected());
  const row = await breach();
  await dispatcher.run();
  expect((await state(row.id))._delivery).toMatchObject({
    robot: { status: "not_accepted" },
    sms: { status: "accepted" },
    bell: { status: "accepted" },
  });
  expect(h.providers.sms.callsOf("sendSubscribeFallback")).toHaveLength(2);
  const deliveries = await h.prisma.notificationDelivery.findMany({ where: { isDirect: true } });
  expect(deliveries).toHaveLength(2);
  expect(new Set(deliveries.map((one) => one.directKey)).size).toBe(2);
  expect(JSON.stringify(deliveries)).not.toContain("13800138000");
  expect(JSON.stringify(deliveries)).not.toContain("13900139000");
  await dispatcher.run();
  expect(robot).toHaveBeenCalledTimes(1);
  await breach();
  expect((await state(row.id))._delivery.robot.status).toBe("not_accepted");
  h.clock.advance(60_000);
  await dispatcher.run();
  expect(robot).toHaveBeenCalledTimes(2);
  expect(h.providers.sms.callsOf("sendSubscribeFallback")).toHaveLength(2);
  expect(await h.prisma.staffMessage.count({ where: { staffId: adminId } })).toBe(1);
  h.clock.advance(14 * 60_000 - 1);
  await dispatcher.run();
  expect(robot).toHaveBeenCalledTimes(2);
  h.clock.advance(1);
  await dispatcher.run();
  expect(robot).toHaveBeenCalledTimes(3);
  await h.prisma.alertEvent.update({
    where: { id: row.id },
    data: { status: "acked", ackedAt: h.clock.now(), ackedByStaffId: adminId },
  });
  h.clock.advance(60 * 60_000 - 1);
  await dispatcher.run();
  expect(robot).toHaveBeenCalledTimes(3);
  h.clock.advance(1);
  await dispatcher.run();
  expect(robot).toHaveBeenCalledTimes(4);
});

it("同库两派发器并发不双发，未知不盲重发；取消/失租不写迟到受理", async () => {
  const one = setup(),
    two = setup(one.options);
  one.robot.mockResolvedValueOnce(unknown());
  const row = await breach();
  await Promise.all([one.dispatcher.run(), two.dispatcher.run()]);
  expect(one.robot).toHaveBeenCalledTimes(1);
  h.clock.advance(60_000);
  await two.dispatcher.run();
  expect(one.robot).toHaveBeenCalledTimes(1);
  expect((await state(row.id))._delivery.robot.status).toBe("unknown");
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let holder = "alert-test";
  const hanging = setup({
    holder: () => holder,
    robot: (_input) =>
      new Promise((resolve) => {
        entered();
        _input.signal!.addEventListener("abort", () => resolve(unknown()), { once: true });
      }),
  });
  const next = await breach("P1", "backup.failed", "cancel");
  const run = hanging.dispatcher.run();
  await ready;
  holder = "other";
  await hanging.dispatcher.close();
  await run;
  expect(
    (await h.prisma.alertEvent.findUniqueOrThrow({ where: { id: next.id } })).notifyCount,
  ).toBe(0);
  expect((await state(next.id))._delivery.robot.status).toBe("sending");
  await expect(hanging.dispatcher.run()).rejects.toThrow("关闭");

  await h.prisma.alertEvent.updateMany({ data: { status: "resolved", resolvedAt: h.clock.now() } });
  for (const change of ["upgrade", "recovery", "manual", "superseded"] as const) {
    let claimed!: () => void, release!: () => void;
    const committed = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let transactions = 0;
    const stale = setup({
      tx: {
        async run(action, options) {
          const transaction = ++transactions;
          const result = await h.tx.run(action, options);
          if (transaction === 2) {
            claimed();
            await gate;
          }
          return result;
        },
      },
    });
    const severity = change === "upgrade" ? "P2" : "P1";
    const alert = await breach(severity, "billing.unfulfilled", change);
    const sending = stale.dispatcher.run();
    await committed;
    let oldGeneration: unknown;
    try {
      const current = await h.prisma.alertEvent.findUniqueOrThrow({ where: { id: alert.id } });
      const value = current.lastValue as Record<string, unknown>;
      oldGeneration = (value._delivery as Record<string, unknown>).generation;
      const lastValue =
        change === "superseded"
          ? {
              ...value,
              _delivery: {
                ...(value._delivery as Record<string, unknown>),
                generation: "10000000-0000-4000-8000-000000000001",
                token: "10000000-0000-4000-8000-000000000002",
              },
            }
          : { ...value, ...(change === "recovery" ? { _recoveryReason: "normal" } : {}) };
      await h.prisma.$executeRawUnsafe(
        `UPDATE alert_event SET severity=$2,status=$3,resolved_at=$4,last_value=$5::jsonb WHERE id=$1::uuid`,
        alert.id,
        change === "upgrade" ? "P1" : severity,
        ["manual", "recovery"].includes(change) ? "resolved" : "open",
        ["manual", "recovery"].includes(change) ? h.clock.now() : null,
        JSON.stringify(lastValue),
      );
    } finally {
      release();
    }
    await sending;
    expect(
      stale.robot.mock.calls.filter(([input]) => input.content.startsWith(`告警 ${severity}`)),
      change,
    ).toHaveLength(0);
    expect(
      stale.sms.mock.calls.filter(([input]) => input.generation === oldGeneration),
      change,
    ).toHaveLength(0);
    const notices = await h.prisma.notification.findMany({ where: { bizId: alert.id } });
    expect(
      notices.filter((notice) => {
        const vars = notice.vars as Record<string, unknown>;
        return vars.severity === severity && vars.recovered === false;
      }),
      change,
    ).toHaveLength(0);
    await h.prisma.alertEvent.update({
      where: { id: alert.id },
      data: { status: "resolved", resolvedAt: h.clock.now(), lastValue: {} },
    });
  }
});

it("P2三次机器人失败仅升级一次SMS，升级立即发送，自动恢复与人工关闭区分", async () => {
  const { dispatcher, robot, sms } = setup();
  robot.mockResolvedValue(rejected());
  const row = await breach("P2");
  for (let n = 0; n < 3; n++) {
    await dispatcher.run();
    if (n < 2) h.clock.advance(60_000);
  }
  expect(robot).toHaveBeenCalledTimes(3);
  expect(sms).toHaveBeenCalledTimes(1);
  expect(sms.mock.calls[0]?.[0]).toMatchObject({ phase: "channel", title: "告警通道失效" });
  h.clock.advance(60_000);
  await dispatcher.run();
  expect(sms).toHaveBeenCalledTimes(1);
  robot.mockResolvedValue(notificationOk(undefined));
  await breach("P1");
  await dispatcher.run();
  expect(sms).toHaveBeenCalledTimes(2);
  for (let n = 0; n < 3; n++) {
    h.clock.advance(60_000);
    await h.tx.run((tx) =>
      writeHealthyProbeFact(
        tx,
        { rule: row.rule, dimension: "small" },
        h.clock.now(),
        h.clock.now(),
      ),
    );
  }
  await dispatcher.run();
  expect(robot.mock.calls.at(-1)?.[0].content).toContain("已恢复");
  expect((await state(row.id))._recoveryReason).toBe("normal");
  const manual = await breach("P2", "timer.failed", "manual");
  await h.prisma.alertEvent.update({
    where: { id: manual.id },
    data: { status: "resolved", resolvedAt: h.clock.now(), note: "测试人工关闭" },
  });
  const calls = robot.mock.calls.length;
  await dispatcher.run();
  expect(robot).toHaveBeenCalledTimes(calls);
  await breach("P3", "config.flag_changed", "flag");
  await dispatcher.run();
  expect(robot.mock.calls.at(-1)?.[0].content).toContain("config.flag_changed");
});

it("北京09:30汇总含非即时P2，铃铛成功不吞机器人失败；重启补当日、空心跳及零租约", async () => {
  const { dispatcher, robot, options } = setup({ config: { oncallPhones: [], p2Immediate: [] } });
  h.clock.set(new Date("2026-10-13T00:00:00Z"));
  await breach("P3", "cert.unconfigured", "daily");
  await breach("P2", "queue.backlog", "daily");
  h.clock.set(new Date("2026-10-14T01:29:00Z"));
  await dispatcher.run();
  expect(robot).not.toHaveBeenCalled();
  h.clock.advance(60_000);
  robot.mockResolvedValueOnce(rejected());
  await dispatcher.run();
  const heartbeat = await h.prisma.alertEvent.findFirstOrThrow({
    where: { fingerprint: "ops.channel_heartbeat:2026-10-14" },
  });
  expect(heartbeat.notifyCount).toBe(0);
  expect((await state(heartbeat.id))._delivery.bell.status).toBe("accepted");
  h.clock.advance(6 * 3600_000 + 1);
  await h.tx.run((tx) => resolveQuietEventFacts(tx, h.clock.now()));
  expect(
    (await h.prisma.alertEvent.findUniqueOrThrow({ where: { id: heartbeat.id } })).status,
  ).toBe("open");
  const reboot = setup(options);
  await reboot.dispatcher.run();
  expect(robot).toHaveBeenCalledTimes(2);
  expect(robot.mock.calls.at(-1)?.[0].content).toContain("2 条");
  await reboot.dispatcher.run();
  expect(robot).toHaveBeenCalledTimes(2);
  h.clock.set(new Date("2026-10-15T04:00:00Z"));
  await reboot.dispatcher.run();
  expect(robot.mock.calls.at(-1)?.[0].content).toContain("0 条");
  const inactive = setup({ holder: () => undefined });
  expect(await inactive.dispatcher.run()).toEqual({ inspected: 0, accepted: 0, unconfigured: 0 });
});
