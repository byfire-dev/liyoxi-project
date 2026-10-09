import { afterEach, expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { useSeededDatabase } from "../testing/index.js";
import { lifecycleWorld } from "./lifecycle.test-world.js";
import type { LifecycleWorld } from "./lifecycle.test-world.js";
const db = useSeededDatabase("services"),
  owned: LifecycleWorld[] = [];
afterEach(async () => {
  for (const h of owned.splice(0)) await h.close();
});
async function world() {
  const h = await lifecycleWorld(db);
  owned.push(h);
  return h;
}
it("首次上架与重新上架保留首次时间、仅一initial，历史/事件/到期timer真实一致", async () => {
  const h = await world(),
    { drama } = await h.draft();
  await h.masters(drama.id, [1, 2]);
  const first = await h.tx.run((tx) => h.content.list(tx, h.actor.identity, drama.id));
  expect(first.status).toBe("listed");
  expect(first.firstListedAt).toEqual(h.clock.now());
  await h.tx.run((tx) =>
    h.content.delist(tx, h.actor.identity, drama.id, {
      reasonCode: "ops_strategy",
      note: "暂时下架",
    }),
  );
  expect(await h.prisma.timer.count({ where: { subjectId: drama.id, status: "scheduled" } })).toBe(
    0,
  );
  h.clock.advance(1000);
  const relisted = await h.tx.run((tx) => h.content.list(tx, h.actor.identity, drama.id));
  expect(relisted.firstListedAt).toEqual(first.firstListedAt);
  expect(relisted.listedAt).toEqual(h.clock.now());
  expect(
    await h.prisma.dramaCopyrightRevision.count({
      where: { dramaId: drama.id, changeKind: "initial" },
    }),
  ).toBe(1);
  expect(await h.prisma.statusTransition.count({ where: { subjectId: drama.id } })).toBe(4);
  const events = await h.prisma.outboxEvent.findMany({
    where: { aggregateId: drama.id, eventType: "drama.listed" },
    orderBy: { seq: "asc" },
  });
  expect(
    events.map((v) => EVENT_PAYLOAD_SCHEMAS["drama.listed"].parse(v.payload).isRelist),
  ).toEqual([false, true]);
  expect(await h.prisma.timer.count({ where: { subjectId: drama.id, status: "scheduled" } })).toBe(
    1,
  );
});
it("已上架保存阻断整笔回滚；L12只挡上下架，不阻挡合法保存", async () => {
  const h = await world(),
    { drama } = await h.draft();
  await h.masters(drama.id, [1, 2]);
  let row = await h.tx.run((tx) => h.content.list(tx, h.actor.identity, drama.id));
  const logs = await h.prisma.auditLog.count({ where: { targetId: drama.id } });
  await expect(
    h.tx.run((tx) =>
      h.content.saveBasic(tx, h.actor.identity, drama.id, {
        lockVersion: row.lockVersion,
        synopsis: null,
      }),
    ),
  ).rejects.toMatchObject({ error: "LISTING_CHECK_FAILED" });
  expect(await h.prisma.drama.findUnique({ where: { id: drama.id } })).toMatchObject({
    synopsis: "测试完整基础信息",
    lockVersion: row.lockVersion,
  });
  expect(await h.prisma.auditLog.count({ where: { targetId: drama.id } })).toBe(logs);
  await h.prisma.drama.update({ where: { id: drama.id }, data: { isPermitRecheckRequired: true } });
  row = await h.tx.run((tx) =>
    h.content.saveBasic(tx, h.actor.identity, drama.id, {
      lockVersion: row.lockVersion,
      title: "合法标题修改",
    }),
  );
  expect(row.isPermitRecheckRequired).toBe(true);
});
it("集数扩大补齐，已有当前原片不能缩，已上架即便无删除集也不可变更", async () => {
  const h = await world(),
    { drama } = await h.draft(3);
  await h.masters(drama.id, [3]);
  await expect(
    h.tx.run((tx) =>
      h.content.saveBasic(tx, h.actor.identity, drama.id, {
        lockVersion: drama.lockVersion,
        totalEpisodes: 2,
      }),
    ),
  ).rejects.toMatchObject({ error: "EPISODE_HAS_MASTER" });
  expect(await h.prisma.dramaEpisode.count({ where: { dramaId: drama.id } })).toBe(3);
  await h.masters(drama.id, [1, 2]);
  const listed = await h.tx.run((tx) => h.content.list(tx, h.actor.identity, drama.id));
  await expect(
    h.tx.run((tx) =>
      h.content.saveBasic(tx, h.actor.identity, drama.id, {
        lockVersion: listed.lockVersion,
        totalEpisodes: 4,
      }),
    ),
  ).rejects.toMatchObject({ error: "TOTAL_EPISODES_LOCKED" });
});
it("上架后许可号冻结，换号先退旧再建新；单独停必备行必须回滚", async () => {
  const h = await world(),
    { drama, permit, proof } = await h.draft();
  await h.masters(drama.id, [1, 2]);
  const listed = await h.tx.run((tx) => h.content.list(tx, h.actor.identity, drama.id));
  await expect(
    h.tx.run((tx) =>
      h.content.updatePermit(tx, h.actor.identity, permit.id, {
        dramaLockVersion: listed.lockVersion,
        permitNo: "ILLEGAL-CHANGE",
      }),
    ),
  ).rejects.toMatchObject({ error: "PERMIT_FROZEN" });
  await expect(
    h.tx.run((tx) =>
      h.content.retirePermit(tx, h.actor.identity, permit.id, { retireReason: "停用" }),
    ),
  ).rejects.toMatchObject({ error: "LISTING_CHECK_FAILED" });
  const replacement = await h.tx.run((tx) =>
    h.content.createPermit(tx, h.actor.identity, drama.id, {
      platform: "all",
      permitKind: "program_no",
      permitNo: "NEW-002",
      scanFileIds: [proof.id],
      replacesDramaPermitId: permit.id,
      retireReason: "换号",
    }),
  );
  expect(replacement.status).toBe("active");
  expect(await h.prisma.dramaPermit.findUnique({ where: { id: permit.id } })).toMatchObject({
    status: "retired",
    retireReason: "换号",
  });
  expect(
    await h.prisma.fileRef.findFirst({ where: { refType: "drama_permit", refId: permit.id } }),
  ).toMatchObject({ state: "live" });
});
it("剧集仅改标题并共享父CAS，不允许伪造时长/原片旁路，过期CAS零审计", async () => {
  const h = await world(),
    { drama } = await h.draft();
  const episode = await h.prisma.dramaEpisode.findFirstOrThrow({ where: { dramaId: drama.id } });
  const first = await h.tx.run((tx) =>
    h.content.updateEpisode(tx, h.actor.identity, episode.id, {
      dramaLockVersion: drama.lockVersion,
      title: "新的集名",
    }),
  );
  expect(first.durationMs).toBe(episode.durationMs);
  await expect(
    h.tx.run((tx) =>
      h.content.updateEpisode(tx, h.actor.identity, episode.id, {
        dramaLockVersion: drama.lockVersion,
        title: "覆盖",
      }),
    ),
  ).rejects.toMatchObject({ error: "VERSION_CONFLICT" });
  await expect(
    h.tx.run((tx) =>
      h.content.updateEpisode(tx, h.actor.identity, episode.id, {
        dramaLockVersion: drama.lockVersion + 1,
        title: "覆盖",
        durationMs: 1,
      }),
    ),
  ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
  expect(
    await h.prisma.auditLog.count({
      where: { targetId: drama.id, action: "content.drama.episode_update" },
    }),
  ).toBe(1);
});
it("归档剧所有写入口明确拒绝，不把归档伪造第四状态", async () => {
  const h = await world(),
    { drama, permit } = await h.draft();
  await h.masters(drama.id, [1, 2]);
  await h.tx.run((tx) => h.content.list(tx, h.actor.identity, drama.id));
  await h.tx.run((tx) =>
    h.content.delist(tx, h.actor.identity, drama.id, { reasonCode: "ops_strategy" }),
  );
  await h.prisma.drama.update({ where: { id: drama.id }, data: { archivedAt: h.clock.now() } });
  for (const action of [
    () =>
      h.tx.run((tx) =>
        h.content.saveRoles(tx, h.actor.identity, drama.id, {
          lockVersion: drama.lockVersion,
          roles: [],
        }),
      ),
    () =>
      h.tx.run((tx) =>
        h.content.retirePermit(tx, h.actor.identity, permit.id, { retireReason: "停用" }),
      ),
    () => h.tx.run((tx) => h.content.replaceTrailer(tx, h.actor.identity, drama.id, drama.id)),
  ])
    await expect(action()).rejects.toMatchObject({ error: "DRAMA_ARCHIVED" });
  expect((await h.prisma.drama.findUniqueOrThrow({ where: { id: drama.id } })).status).toBe(
    "delisted",
  );
});
