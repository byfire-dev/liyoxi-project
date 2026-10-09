import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "@liyoxi/contract";
import { createRuntime } from "../runtime.js";
import { createTxRunner, loadEnv, uuidv7 } from "../kernel/index.js";
import { createContentLicense } from "../content/index.js";
import {
  createClock,
  createFactories,
  createFakeProviders,
  fakeKeyEnv,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
const db = useSeededDatabase("services"),
  redis = useTestRedis();
const clockA = createClock(new Date("2026-01-05T15:59:59.999Z")),
  clockB = createClock(new Date("2026-01-05T16:00:00Z"));
let a: ReturnType<typeof createRuntime>, b: ReturnType<typeof createRuntime>;
beforeAll(async () => {
  const env = { ...loadEnv(), ...fakeKeyEnv(), DATABASE_URL: await db.url() };
  a = createRuntime({
    entry: "api",
    env,
    clock: clockA,
    version: "test",
    providers: createFakeProviders({ clock: clockA }),
    redisKeyPrefix: `${redis.prefix}a:`,
  });
  b = createRuntime({
    entry: "worker",
    env,
    clock: clockB,
    version: "test",
    providers: createFakeProviders({ clock: clockB }),
    redisKeyPrefix: `${redis.prefix}b:`,
  });
}, 180000);
afterAll(async () => {
  await Promise.all([a?.close(), b?.close()]);
});
it("API与worker两真实runtime的版权/计价闭包独立，关B不回退A、关A不回退B", async () => {
  const prisma = await db.prisma(),
    make = createFactories({ db: prisma, clock: clockA }),
    employee = await make.staff({ staffRoleKey: "content_ops" });
  const timers = [];
  for (const [runtime, clock] of [
    [a, clockA],
    [b, clockB],
  ] as const) {
    const row = await make.drama({
      status: "listed",
      heatTier: "A",
      createdByStaffId: employee.id,
      updatedByStaffId: employee.id,
    });
    await prisma.dramaCopyright.create({
      data: {
        dramaId: row.id,
        licenseEndDate: new Date("2026-01-05T00:00:00Z"),
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    const license = createContentLicense({ clock, flow: runtime.flow, timers: runtime.timers });
    await runtime.tx.run((tx) => license.rearm(tx, row.id));
    const timer = await prisma.timer.findFirstOrThrow({ where: { subjectId: row.id } });
    timers.push({
      ...timer,
      payload: z.record(z.string(), z.unknown()).nullable().parse(timer.payload),
    });
  }
  for (const runtime of [a, b]) {
    expect(runtime.assembly.timerHandler("content.license_end")).toBe(
      runtime.assembly.timerHandlers.find((v) => v.kind === "content.license_end"),
    );
    expect(runtime.assembly.timerHandler("pricing.drama_price_effective")).toBeDefined();
    expect(runtime.assembly.subscriber("billing.onTierChanged")).toBe(
      runtime.assembly.subscribers.find((v) => v.name === "billing.onTierChanged"),
    );
    expect(runtime.assembly.invariant("content.I2")?.heal).toBe("heal_and_alert");
    expect(runtime.assembly.invariant("content.I3")?.heal).toBe("heal_and_alert");
  }
  const first = timers[0]!,
    second = timers[1]!;
  expect(
    await a.tx.run((tx) => a.assembly.timerHandler("content.license_end")!.handle(tx, first)),
  ).toBe("skipped");
  expect(
    await b.tx.run((tx) => b.assembly.timerHandler("content.license_end")!.handle(tx, second)),
  ).toBe("fired");
  await b.close();
  await expect(
    a.tx.run((tx) => b.assembly.timerHandler("content.license_end")!.handle(tx, first)),
  ).rejects.toThrow("已经关闭");
  clockA.advance(1);
  expect(
    await a.tx.run((tx) => a.assembly.timerHandler("content.license_end")!.handle(tx, first)),
  ).toBe("fired");
  expect(
    await prisma.statusTransition.count({
      where: {
        event: "drama.license_expire",
        subjectId: { in: [first.subjectId!, second.subjectId!] },
      },
    }),
  ).toBe(2);
  await expect(
    a.tx.run((tx) =>
      b.assembly.subscriber("billing.onTierChanged")!.handle(tx, {
        id: uuidv7(),
        type: "drama.tier_changed",
        payload: { v: 1, dramaId: first.subjectId, fromTier: "A", toTier: "B" },
      }),
    ),
  ).rejects.toThrow("已经关闭");
  await a.close();
  const tx = createTxRunner({ prisma, appEnv: "test" });
  await expect(
    tx.run((t) => a.assembly.timerHandler("content.license_end")!.handle(t, first)),
  ).rejects.toThrow("已经关闭");
});
