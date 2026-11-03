import { beforeAll, describe, expect, it } from "vitest";
import { LaunchCalendarSchema } from "@liyoxi/contract";
import { runSeed } from "@liyoxi/services";
import { assertSnapshotsEqual, signInAsStaff, snapshotTables } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi();
let api: TestApi;
let publisher: SignedInStaff;
let prisma: Awaited<ReturnType<typeof handle.db.prisma>>;
let peer = 0;

beforeAll(async () => {
  api = await handle.start();
  prisma = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
});
beforeAll(async () => {
  publisher = await signInAsStaff(prisma, { roleKey: "publisher", now: api.clock.now() });
});

const tables = [
  "work_calendar_day",
  "delivery_ticket",
  "launch_task",
  "order_item",
  "audit_log",
  "outbox_event",
  "timer",
  "idempotency_record",
];

function request(path: string, headers: Record<string, string> = publisher.headers) {
  return api.request(`/api/v1${path}`, { headers, peer: `198.19.118.${++peer}` });
}

describe("W6-08 日历只读前置", () => {
  it("只有发布查看权也能读取实际日历，系统日历权限仍拒绝，GET零写", async () => {
    expect(api.api.mountedOperations).toContain("admin.launchCalendar.get");
    const rows = await prisma.workCalendarDay.findMany({
      where: {
        day: { gte: new Date("2026-01-01T00:00:00Z"), lt: new Date("2026-02-01T00:00:00Z") },
      },
    });
    expect(rows.length).toBeGreaterThan(0);
    const before = await snapshotTables(prisma, tables);
    const response = await request("/admin/launch-calendar?month=2026-01");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const calendar = LaunchCalendarSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
    expect(calendar.workCalendar.days).toHaveLength(31);
    for (const row of rows) {
      expect(calendar.workCalendar.days).toContainEqual({
        date: row.day.toISOString().slice(0, 10),
        kind: row.kind,
        isWorkday: row.isWorkday,
        name: row.kind === "holiday" || row.kind === "adjusted_workday" ? (row.note ?? "") : null,
      });
    }
    expect(calendar.workCalendar).not.toHaveProperty("workHours");
    expect(calendar.workCalendar).not.toHaveProperty("source");
    const system = await request("/admin/calendar-days?year=2026");
    expect(system.status).toBe(403);
    expect(await system.json()).toMatchObject({ error: "PERMISSION_DENIED" });
    assertSnapshotsEqual(before, await snapshotTables(prisma, tables));
  });

  it("未登录不读取；空年度返回缺失事实且不补种", async () => {
    const before = await snapshotTables(prisma, tables);
    expect((await request("/admin/launch-calendar?month=2026-01", {})).status).toBe(401);
    const response = await request("/admin/launch-calendar?month=2099-02");
    expect(response.status, await response.clone().text()).toBe(200);
    const calendar = LaunchCalendarSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
    expect(calendar.workCalendar.years).toEqual([{ year: 2099, importedAt: null }]);
    expect(calendar.workCalendar.days).toHaveLength(28);
    expect(
      calendar.workCalendar.days.every(
        (day) => day.kind === null && day.isWorkday === null && day.name === null,
      ),
    ).toBe(true);
    assertSnapshotsEqual(before, await snapshotTables(prisma, tables));
  });
});
