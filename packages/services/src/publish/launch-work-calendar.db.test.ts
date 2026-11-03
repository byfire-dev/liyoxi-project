import { beforeAll, describe, expect, it } from "vitest";
import { LaunchCalendarQuerySchema, LaunchCalendarSchema } from "@liyoxi/contract";
import type { LaunchCalendarQuery } from "@liyoxi/contract";
import { assembleServices } from "../assembly.js";
import { createEvents } from "../events/index.js";
import { createIdentityContext, createTxRunner } from "../kernel/index.js";
import { createCalendarAdmin } from "../sla/index.js";
import {
  createClock,
  createFactories,
  sampleStaffContext,
  useSeededDatabase,
} from "../testing/index.js";
import { createLaunchWorkbench } from "./launch-workbench.js";

const db = useSeededDatabase("services"),
  clock = createClock(new Date("2026-11-04T04:00:00.000Z"));
let prisma: Awaited<ReturnType<typeof db.prisma>>,
  workbench: ReturnType<typeof createLaunchWorkbench>,
  publisher: Awaited<ReturnType<typeof sampleStaffContext>>;

beforeAll(async () => {
  prisma = await db.prisma();
  const make = createFactories({ db: prisma, clock }),
    tx = createTxRunner({ prisma, appEnv: "test" });
  publisher = await sampleStaffContext(
    prisma,
    (await make.staff({ staffRoleKey: "publisher" })).id,
  );
  workbench = createLaunchWorkbench({ tx, clock });
  const admin = await make.staff({ staffRoleKey: "super_admin" }),
    assembly = assembleServices({ entry: "api", appEnv: "test" }),
    calendar = createCalendarAdmin({ tx, clock, events: createEvents({ assembly, tx, clock }) });
  // 未来年份仅为隔离测试输入，经原公共导入形成逐日事实，不作为真实节假日安排。
  await calendar.import(
    {
      staff: await sampleStaffContext(prisma, admin.id),
      identity: createIdentityContext({ actor: { type: "staff", id: admin.id, client: "admin" } }),
    },
    {
      year: 2096,
      source: "隔离测试日历依据",
      days: [
        { date: "2096-02-25", kind: "adjusted_workday", note: "测试调休" },
        { date: "2096-02-28", kind: "holiday", note: "测试节" },
        { date: "2096-02-29", kind: "holiday", note: "测试节" },
        { date: "2096-03-01", kind: "holiday", note: "范围外测试节" },
      ],
    },
  );
  // 单日缺行的历史损坏输入：读取应报告缺失，不能补行或重新判定星期。
  await prisma.workCalendarDay.delete({ where: { day: new Date("2096-02-20T00:00:00.000Z") } });
}, 120_000);

async function snapshot() {
  return {
    calendar: await prisma.workCalendarDay.findMany({ orderBy: { day: "asc" } }),
    audit: await prisma.auditLog.count(),
    events: await prisma.outboxEvent.count(),
    timers: await prisma.timer.count(),
    alerts: await prisma.alertEvent.count(),
  };
}
async function read(query: LaunchCalendarQuery) {
  const before = await snapshot();
  const result = LaunchCalendarSchema.parse(
    await workbench.calendar(publisher, LaunchCalendarQuerySchema.parse(query)),
  );
  expect(await snapshot()).toEqual(before);
  return result;
}

describe("上线日历的真实工作日只读投影", () => {
  it("无业务事项仍裁剪节日、调休与普通日；limit不截断工作日事实", async () => {
    const result = await read({ from: "2026-01-02", to: "2026-01-05", limit: 1 });
    expect(result).toMatchObject({ total: 0, days: [], isTruncated: false });
    expect(result.workCalendar.days).toEqual([
      { date: "2026-01-02", kind: "holiday", isWorkday: false, name: "元旦" },
      { date: "2026-01-03", kind: "holiday", isWorkday: false, name: "元旦" },
      { date: "2026-01-04", kind: "adjusted_workday", isWorkday: true, name: "元旦调休" },
      { date: "2026-01-05", kind: "weekday", isWorkday: true, name: null },
    ]);
    expect(result.workCalendar.years).toHaveLength(1);
    expect(result.workCalendar.years[0]).toMatchObject({ year: 2026 });
    expect(result.workCalendar.years[0]!.importedAt).not.toBeNull();
  });

  it("跨年返回同批次与各年导入标记；铺底平日/周末不冒充已导入节假日", async () => {
    const result = await read({ from: "2026-12-31", to: "2027-01-03" });
    expect(result.workCalendar.years).toEqual([
      { year: 2026, importedAt: expect.any(String) },
      { year: 2027, importedAt: null },
    ]);
    expect(result.workCalendar.days).toEqual([
      { date: "2026-12-31", kind: "weekday", isWorkday: true, name: null },
      { date: "2027-01-01", kind: "weekday", isWorkday: true, name: null },
      { date: "2027-01-02", kind: "weekend", isWorkday: false, name: null },
      { date: "2027-01-03", kind: "weekend", isWorkday: false, name: null },
    ]);
    expect(result.workCalendar.calendarVersion).toBe(
      (await prisma.workCalendarDay.aggregate({ _max: { calendarVersion: true } }))._max
        .calendarVersion,
    );
  });

  it("跨年缺行逐日明确null，空闰月含29日而不自行推算工作日", async () => {
    const crossYear = await read({ from: "2027-12-31", to: "2028-01-02" });
    expect(crossYear.workCalendar.years).toEqual([
      { year: 2027, importedAt: null },
      { year: 2028, importedAt: null },
    ]);
    expect(crossYear.workCalendar.days).toEqual([
      { date: "2027-12-31", kind: "weekday", isWorkday: true, name: null },
      { date: "2028-01-01", kind: null, isWorkday: null, name: null },
      { date: "2028-01-02", kind: null, isWorkday: null, name: null },
    ]);
    const february = await read({ month: "2028-02" });
    expect(february.workCalendar.days).toHaveLength(29);
    expect(february.workCalendar.days.at(-1)).toEqual({
      date: "2028-02-29",
      kind: null,
      isWorkday: null,
      name: null,
    });
    expect(
      february.workCalendar.days.every((day) => day.kind === null && day.isWorkday === null),
    ).toBe(true);
    const fullRange = await read({ from: "2027-12-01", to: "2028-01-11", limit: 1 });
    expect(fullRange.workCalendar.days).toHaveLength(42);
    expect(fullRange.workCalendar.days.at(-1)!.date).toBe("2028-01-11");
  });

  it("已导入闰月从真实记录取名称，裁剪掉相邻月例外", async () => {
    const result = await read({ month: "2096-02" });
    expect(result.workCalendar.days).toHaveLength(29);
    expect(result.workCalendar.days.filter((day) => day.name !== null)).toEqual([
      { date: "2096-02-25", kind: "adjusted_workday", isWorkday: true, name: "测试调休" },
      { date: "2096-02-28", kind: "holiday", isWorkday: false, name: "测试节" },
      { date: "2096-02-29", kind: "holiday", isWorkday: false, name: "测试节" },
    ]);
    expect(result.workCalendar.years).toEqual([
      { year: 2096, importedAt: clock.now().toISOString() },
    ]);
    expect(result.workCalendar.days.find((day) => day.date === "2096-02-20")).toEqual({
      date: "2096-02-20",
      kind: null,
      isWorkday: null,
      name: null,
    });
  });

  it.each(["0000-01", "0001-01", "9999-12"])(
    "保持原查询可接受的%s年份，不收紧范围",
    async (month) => {
      const result = await read({ month });
      expect(result.workCalendar.days).toHaveLength(31);
      expect(result.workCalendar.days[0]!.date).toBe(`${month}-01`);
      expect(result.workCalendar.days.at(-1)!.date).toBe(`${month}-31`);
      expect(
        result.workCalendar.days.every((day) => day.kind === null && day.isWorkday === null),
      ).toBe(true);
    },
  );
});
