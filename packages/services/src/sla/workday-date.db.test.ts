import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, expect, it } from "vitest";
import { createTxRunner } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { seedWorkCalendar, useTestDatabase } from "../testing/index.js";
import { CALENDAR_FALLBACK_RULE } from "./index.js";
import { HOURS, sampleSla } from "./__fixtures__/calendar.js";

const db = useTestDatabase("services"),
  { sla, ports } = sampleSla();
let prisma: PrismaClient, tx: TxRunner;
beforeAll(async () => {
  prisma = await db.prisma();
  tx = createTxRunner({ prisma, appEnv: "test" });
}, 120000);

it("日期下限缺行按周一至周五兜底并只告警一次，不额外对齐普通周日", async () => {
  const result = await tx.run((t) =>
    sla.nthWorkdayAfter(t, {
      policy: "plan.launch_min",
      from: "2026-10-18",
      amount: 7,
      workHours: HOURS,
    }),
  );
  expect(result.date).toBe("2026-10-27");
  expect(result.usedFallback).toBe(true);
  expect(result.fallbackDates).toEqual([
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
    "2026-10-23",
    "2026-10-24",
    "2026-10-25",
    "2026-10-26",
    "2026-10-27",
  ]);
  expect(ports.alerts).toEqual([
    {
      rule: CALENDAR_FALLBACK_RULE,
      severity: "P2",
      detail: { policy: "plan.launch_min", count: 9, dates: result.fallbackDates },
    },
  ]);
});

it("长假超出首个读取窗口时扩大日历，不把已导入日期报成缺行", async () => {
  const holidays = Array.from({ length: 53 }, (_, index) =>
    new Date(Date.UTC(2027, 1, 1 + index)).toISOString().slice(0, 10),
  );
  await seedWorkCalendar(prisma, { from: "2027-01-01", to: "2027-12-31", holidays });
  ports.alerts.length = 0;
  const result = await tx.run((t) =>
    sla.nthWorkdayAfter(t, {
      policy: "plan.launch_min",
      from: "2027-01-29",
      amount: 1,
      workHours: HOURS,
    }),
  );
  expect(result).toEqual({ date: "2027-03-26", usedFallback: false, fallbackDates: [] });
  expect(ports.alerts).toEqual([]);
});
