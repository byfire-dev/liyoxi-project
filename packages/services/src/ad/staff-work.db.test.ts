import { afterEach, beforeEach, expect, it } from "vitest";
import { createFactories, useSeededDatabase, useTestRedis } from "../testing/index.js";
import { lockRows } from "../kernel/index.js";
import { adStaffWork } from "./staff-work.js";
import { adFixture } from "./__fixtures__/lifecycle.js";
const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
let active: Awaited<ReturnType<typeof adFixture>> | undefined;
beforeEach(() => db.reset(), 120_000);
afterEach(async () => {
  await active?.close();
  active = undefined;
});
async function setup() {
  const p = await db.prisma();
  const f = (active = await adFixture(p, {
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  }));
  return { p, f, make: createFactories({ db: p, clock: f.clock }) };
}
it(
  "正式员工在办计数包含真实已扣广告；禁用移交同事务改负责人和历史，原SLA保持",
  { timeout: 120_000 },
  async () => {
    const { p, f, make } = await setup(),
      to = await make.staff({ staffRoleKey: "editor" }),
      id = f.created.adId;
    const before = await p.ad.findUniqueOrThrow({ where: { id } });
    const timers = await p.timer.findMany({ where: { subjectType: "ad", subjectId: id } });
    expect(await p.assignmentHistory.count({ where: { subjectType: "ad", subjectId: id } })).toBe(
      0,
    );
    const service = f.runtime.staffManagement,
      actor = f.adminActor;
    const workload = await service.openWork(actor.staff, f.editorId);
    expect(workload.bySource).toContainEqual({
      source: "ad_editor",
      subjectType: "ad",
      count: 1,
      samples: [{ subjectId: id, label: before.adNo }],
    });
    const editor = await p.staff.findUniqueOrThrow({ where: { id: f.editorId } });
    await expect(
      service.disable(actor.staff, actor.ctx, editor.id, {
        reason: "resigned",
        handoverToStaffId: to.id,
        confirm: { staffNo: editor.staffNo, openWorkCount: workload.total + 1 },
      }),
    ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
    const result = await service.disable(actor.staff, actor.ctx, editor.id, {
      reason: "resigned",
      handoverToStaffId: to.id,
      confirm: { staffNo: editor.staffNo, openWorkCount: workload.total },
    });
    expect(result.staff.status).toBe("disabled");
    expect(await p.ad.findUniqueOrThrow({ where: { id } })).toMatchObject({
      editorId: to.id,
      dueAt: before.dueAt,
      firstDueAt: before.firstDueAt,
      slaSnapshot: before.slaSnapshot,
      capturedAt: before.capturedAt,
    });
    expect(await p.timer.findMany({ where: { subjectType: "ad", subjectId: id } })).toEqual(timers);
    expect(
      await p.assignmentHistory.findMany({ where: { subjectType: "ad", subjectId: id } }),
    ).toMatchObject([
      { source: "ad_editor", fromStaffId: editor.id, toStaffId: to.id, batchId: result.batchId },
    ]);
    expect(
      (await service.openWork(actor.staff, editor.id)).bySource.some(
        (x) => x.source === "ad_editor",
      ),
    ).toBe(false);
    expect(
      (await service.openWork(actor.staff, to.id)).bySource.find((x) => x.source === "ad_editor")
        ?.count,
    ).toBe(1);
  },
);
it(
  "双客户端移交只改一次；锁后旧归属不会覆盖新负责人，错角色目标拒绝",
  { timeout: 120_000 },
  async () => {
    const { p, f, make } = await setup(),
      a = await make.staff({ staffRoleKey: "editor" }),
      b = await make.staff({ staffRoleKey: "editor" });
    const item = (
      await f.runtime.tx.run((tx) =>
        adStaffWork.listOpen(tx, { staffId: f.editorId, now: f.clock.now() }),
      )
    )[0]!;
    const input = {
      fromStaffId: f.editorId,
      toStaffId: f.adminActor.staff.staff.id,
      items: [item],
      ctx: f.adminActor.ctx,
      now: f.clock.now(),
    };
    await expect(
      f.runtime.tx.run(async (tx) => {
        await lockRows(tx, "staff", [input.toStaffId, input.fromStaffId]);
        await lockRows(tx, "ad", [item.subjectId]);
        return adStaffWork.reassign(tx, input);
      }),
    ).rejects.toMatchObject({ error: "ASSIGNEE_INVALID" });
    await Promise.all(
      [a, b].map((to) =>
        f.runtime.staffManagement.handover(f.adminActor.staff, f.adminActor.ctx, f.editorId, {
          handoverToStaffId: to.id,
          reason: "reassigned",
        }),
      ),
    );
    const after = await p.ad.findUniqueOrThrow({ where: { id: f.created.adId } });
    expect([a.id, b.id]).toContain(after.editorId);
    expect(
      await p.assignmentHistory.count({ where: { subjectType: "ad", subjectId: after.id } }),
    ).toBe(1);
    expect(
      await f.runtime.tx.run(async (tx) => {
        await lockRows(tx, "staff", [f.editorId, b.id]);
        await lockRows(tx, "ad", [item.subjectId]);
        return adStaffWork.reassign(tx, { ...input, toStaffId: b.id });
      }),
    ).toEqual([]);
    expect((await p.ad.findUniqueOrThrow({ where: { id: after.id } })).editorId).toBe(
      after.editorId,
    );
  },
);
