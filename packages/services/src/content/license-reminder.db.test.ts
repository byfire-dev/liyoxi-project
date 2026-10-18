import { afterAll, beforeAll, it, expect } from "vitest";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { notificationFixture, useSeededDatabase } from "../testing/index.js";
import { listDramasLicenseEndingOn } from "./index.js";
const db = useSeededDatabase("services");
let h: ReturnType<typeof notificationFixture>;
let creatorId: string;
beforeAll(async () => {
  h = notificationFixture(await db.prisma());
  creatorId = (await h.make.staff({ staffRoleKey: "finance" })).id;
}, 180000);
afterAll(async () => {
  await h?.service.close();
});
async function copyright(title: string, date: string, archived = false) {
  const row = await h.make.drama({
    title,
    status: archived ? "delisted" : "draft",
    archivedAt: archived ? h.clock.now() : null,
    createdByStaffId: creatorId,
    updatedByStaffId: creatorId,
  });
  await h.prisma.dramaCopyright.create({
    data: {
      dramaId: row.id,
      source: "licensed",
      platforms: ["douyin"],
      territory: "中国大陆",
      hasNetworkRight: true,
      canSublicense: true,
      canEditEmbed: true,
      canAdapt: true,
      licenseStartDate: new Date("2026-01-01T00:00:00Z"),
      licenseEndDate: new Date(`${date}T00:00:00Z`),
      proofFileIds: [],
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  return row;
}
it("R7真实current版权事实：09:05前零写，跨自然日90天精确，按员工/日聚合去重", async () => {
  h.clock.set(new Date("2026-10-08T01:04:59.999Z"));
  const date = addDays(calendarDate(h.clock.now()), 90),
    one = await h.make.staff({ staffRoleKey: "content_ops" }),
    two = await h.make.staff({ staffRoleKey: "super_admin" }),
    viewer = await h.make.staff({ staffRoleKey: "finance" }),
    inactive = await h.make.staff({
      staffRoleKey: "content_ops",
      status: "disabled",
      disabledAt: h.clock.now(),
      disabledReason: "other",
    });
  await copyright("目标一", date);
  await copyright("目标二", date);
  await copyright("明日到期目标", addDays(date, 1));
  await copyright("已归档目标", date, true);
  expect(await h.tx.run((tx) => listDramasLicenseEndingOn(tx, date))).toHaveLength(2);
  await h.service.remindScan({ scheduledFor: h.clock.now() });
  expect(await h.prisma.notification.count({ where: { sourceRule: "R7" } })).toBe(0);
  h.clock.advance(1);
  await h.service.remindScan({ scheduledFor: h.clock.now() });
  await h.service.remindScan({ scheduledFor: h.clock.now() });
  const rows = await h.prisma.notification.findMany({ where: { sourceRule: "R7" } });
  expect(rows.map((row) => row.staffId).sort()).toEqual([one.id, two.id].sort());
  for (const row of rows)
    expect(row).toMatchObject({
      dedupeKey: `copyright:${row.staffId}:2026-10-08`,
      node: "N0",
      notifySceneKey: "s.copyright_expiring",
    });
  expect(rows.some((row) => row.staffId === viewer.id || row.staffId === inactive.id)).toBe(false);
  const messages = await h.prisma.staffMessage.findMany({
    where: { staffId: { in: [one.id, two.id] } },
  });
  expect(messages).toHaveLength(2);
  for (const message of messages) {
    expect(message.body).toContain("2部短剧");
    expect(message.body).toContain(date);
    expect(message.body).toContain("目标一");
    expect(message.link).toEqual({ route: "drama.list", params: {} });
  }
});
it("R7改期只读current值、取消和超grace零提醒，不读取旧revision止日", async () => {
  h.clock.set(new Date("2026-11-09T01:05:00Z"));
  const date = addDays(calendarDate(h.clock.now()), 90),
    row = await copyright("已续约", date);
  await h.prisma.dramaCopyright.update({
    where: { dramaId: row.id },
    data: { licenseEndDate: new Date(`${addDays(date, 1)}T00:00:00Z`) },
  });
  const before = await h.prisma.notification.count({ where: { sourceRule: "R7" } });
  await h.service.remindScan({ scheduledFor: h.clock.now() });
  expect(await h.prisma.notification.count({ where: { sourceRule: "R7" } })).toBe(before);
  await copyright("节点目标", date);
  const abort = new AbortController();
  abort.abort();
  await h.service.remindScan({ scheduledFor: h.clock.now(), signal: abort.signal });
  expect(await h.prisma.notification.count({ where: { sourceRule: "R7" } })).toBe(before);
  h.clock.set(new Date("2026-11-09T14:00:00Z"));
  await h.service.remindScan({ scheduledFor: h.clock.now() });
  expect(await h.prisma.notification.count({ where: { sourceRule: "R7" } })).toBe(before);
});
it("R7发送端未配企业微信受控skipped，站内事实保留，不把未发送标成sent", async () => {
  h.clock.set(new Date("2026-11-10T01:05:00Z"));
  const date = addDays(calendarDate(h.clock.now()), 90),
    employee = await h.make.staff({ staffRoleKey: "content_ops" });
  await copyright("合法授权提醒", date);
  await h.prisma.notifyScene.update({
    where: { sceneKey: "s.copyright_expiring" },
    data: { extEnabled: true },
  });
  await h.service.remindScan({ scheduledFor: h.clock.now() });
  const row = await h.prisma.notification.findFirstOrThrow({
      where: { staffId: employee.id, sourceRule: "R7" },
    }),
    delivery = await h.prisma.notificationDelivery.findFirstOrThrow({
      where: { notificationId: row.id, channel: "wecom" },
    });
  await h.service.deliver({ deliveryId: delivery.id });
  expect(
    await h.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
  ).toMatchObject({ status: "skipped", reason: "no_target", callStartedAt: null });
  expect(h.providers.wecom.callsOf("sendAppMessage")).toHaveLength(0);
  expect(await h.prisma.staffMessage.count({ where: { notificationId: row.id } })).toBe(1);
});
