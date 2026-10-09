import { beforeAll, afterAll, it, expect } from "vitest";
import { z } from "@liyoxi/contract";
import { useSeededDatabase } from "../testing/index.js";
import { revisionsWorld } from "./revisions.test-world.js";
import type { RevisionsWorld } from "./revisions.test-world.js";
import { findContentViolations } from "./invariants.js";
const firedTimer = <T extends { payload: unknown }>(row: T) => ({
  ...row,
  payload: z.record(z.string(), z.unknown()).nullable().parse(row.payload),
});
const db = useSeededDatabase("services");
let h: RevisionsWorld;
beforeAll(async () => {
  h = await revisionsWorld(db);
}, 180000);
afterAll(async () => {
  await h?.media.jobs.shutdown();
});
it("真实授权timer止日次日上海00:00，改期取消旧行；旧行/重复回调无下架", async () => {
  const { d } = await h.drama("listed");
  await h.tx.run((t) => h.license.rearm(t, d.id));
  const old = await h.prisma.timer.findFirstOrThrow({
    where: { subjectId: d.id, status: "scheduled" },
  });
  expect(old.fireAt.toISOString()).toBe("2027-12-31T16:00:00.000Z");
  expect(old.dedupeKey).toBe(`content.license_end:drama:${d.id}:2027-12-31`);
  await h.prisma.dramaCopyright.update({
    where: { dramaId: d.id },
    data: { licenseEndDate: new Date("2028-12-31T00:00:00Z") },
  });
  await h.tx.run((t) => h.license.rearm(t, d.id));
  expect((await h.prisma.timer.findUniqueOrThrow({ where: { id: old.id } })).status).toBe(
    "cancelled",
  );
  h.clock.set(new Date("2028-01-01T00:00:00Z"));
  expect(await h.tx.run((t) => h.license.handle(t, firedTimer(old)))).toBe("skipped");
  expect((await h.prisma.drama.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("listed");
});
it("到期真正flow下架：history/actor/原因/事件去重；重复timer无写", async () => {
  h.clock.set(new Date("2026-01-05T04:00:00Z"));
  const { d } = await h.drama("listed", "2026-01-06");
  await h.tx.run((t) => h.license.rearm(t, d.id));
  const timer = await h.prisma.timer.findFirstOrThrow({ where: { subjectId: d.id } });
  h.clock.set(new Date("2026-01-06T15:59:59.999Z"));
  expect(await h.tx.run((t) => h.license.handle(t, firedTimer(timer)))).toBe("skipped");
  h.clock.advance(1);
  expect(await h.tx.run((t) => h.license.handle(t, firedTimer(timer)))).toBe("fired");
  const after = await h.prisma.drama.findUniqueOrThrow({ where: { id: d.id } });
  expect(after).toMatchObject({
    status: "delisted",
    delistReasonCode: "license_expired",
    delistNote: null,
    updatedByStaffId: d.updatedByStaffId,
  });
  expect(
    await h.prisma.statusTransition.count({
      where: { subjectId: d.id, event: "drama.license_expire" },
    }),
  ).toBe(1);
  const event = await h.prisma.outboxEvent.findFirstOrThrow({
    where: { aggregateId: d.id, eventType: "drama.delisted" },
  });
  expect(event.dedupeKey).toBe(`tmr:${timer.dedupeKey}`);
  expect(await h.tx.run((t) => h.license.handle(t, firedTimer(timer)))).toBe("skipped");
  expect(await h.prisma.outboxEvent.count({ where: { aggregateId: d.id } })).toBe(1);
});
it("I3真实补登记/错误时间重排，I2真实自愈且不改firstListed/员工事实", async () => {
  h.clock.set(new Date("2026-01-05T04:00:00Z"));
  const { d } = await h.drama("listed", "2026-02-01");
  expect(
    (await h.tx.run((t) => findContentViolations(t, "I3", h.clock.now()))).some(
      (v) => v.subject && "id" in v.subject && v.subject.id === d.id,
    ),
  ).toBe(true);
  const found = await h.tx.run((t) => h.license.check(t, "I3", h.clock.now()));
  expect(
    found.some(
      (v) =>
        (v.subject && "id" in v.subject ? v.subject.id : null) === d.id &&
        v.healed?.action === "license_timer_rearmed",
    ),
  ).toBe(true);
  const timer = await h.prisma.timer.findFirstOrThrow({
    where: { subjectId: d.id, status: "scheduled" },
  });
  await h.prisma.timer.update({
    where: { id: timer.id },
    data: { fireAt: new Date("2026-01-08T00:00:00Z") },
  });
  expect(
    (await h.tx.run((t) => h.license.check(t, "I3", h.clock.now()))).some(
      (v) => (v.subject && "id" in v.subject ? v.subject.id : null) === d.id && v.healed,
    ),
  ).toBe(true);
  h.clock.set(new Date("2026-02-02T00:00:00Z"));
  expect(await h.tx.run((t) => h.license.handle(t, firedTimer(timer)))).toBe("skipped");
  expect((await h.prisma.drama.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("listed");
  expect(
    (await h.tx.run((t) => h.license.check(t, "I2", h.clock.now()))).some(
      (v) =>
        (v.subject && "id" in v.subject ? v.subject.id : null) === d.id &&
        v.healed?.action === "license_expire",
    ),
  ).toBe(true);
  const after = await h.prisma.drama.findUniqueOrThrow({ where: { id: d.id } });
  expect(after.firstListedAt).toEqual(d.firstListedAt);
  expect(after.updatedByStaffId).toBe(d.updatedByStaffId);
});
it("I3无法复活正式同key终态时只报告未愈，不伪造已重排事实", async () => {
  h.clock.set(new Date("2026-01-05T04:00:00Z"));
  const { d } = await h.drama("listed", "2026-02-01");
  await h.tx.run((t) => h.license.rearm(t, d.id));
  const timer = await h.prisma.timer.findFirstOrThrow({ where: { subjectId: d.id } });
  await h.prisma.timer.update({
    where: { id: timer.id },
    data: { status: "skipped", firedAt: h.clock.now() },
  });
  const found = (await h.tx.run((t) => h.license.check(t, "I3", h.clock.now()))).find(
    (v) => v.subject && "id" in v.subject && v.subject.id === d.id,
  );
  expect(found).toBeDefined();
  expect(found?.healed).toBeUndefined();
  expect(
    await h.prisma.timer.count({
      where: { subjectId: d.id, status: { in: ["scheduled", "dispatched"] } },
    }),
  ).toBe(0);
  expect((await h.prisma.timer.findUniqueOrThrow({ where: { id: timer.id } })).status).toBe(
    "skipped",
  );
});
it("delisted续期不自动上架、不登记；没有止日只报告不能伪heal", async () => {
  const { d } = await h.drama("delisted");
  await h.tx.run((t) => h.license.rearm(t, d.id));
  expect(await h.prisma.timer.count({ where: { subjectId: d.id, status: "scheduled" } })).toBe(0);
  const invalid = await h.drama("listed");
  await h.prisma.dramaCopyright.update({
    where: { dramaId: invalid.d.id },
    data: { licenseEndDate: null },
  });
  const violation = (await h.tx.run((t) => h.license.check(t, "I2", h.clock.now()))).find(
    (v) => (v.subject && "id" in v.subject ? v.subject.id : null) === invalid.d.id,
  );
  expect(violation).toMatchObject({ detail: { licenseEndDate: null } });
  expect(violation?.healed).toBeUndefined();
});
