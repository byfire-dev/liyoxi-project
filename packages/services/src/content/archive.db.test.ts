import { afterEach, expect, it } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { DramaUsagePort } from "./ports.js";
import { createContentMaintenance } from "./maintenance.js";
import { lifecycleWorld } from "./lifecycle.test-world.js";
import type { LifecycleWorld } from "./lifecycle.test-world.js";
const db = useSeededDatabase("services"),
  owned: LifecycleWorld[] = [];
afterEach(async () => {
  for (const h of owned.splice(0)) await h.close();
});
async function fixture() {
  const h = await lifecycleWorld(db);
  owned.push(h);
  const { drama, poster } = await h.draft(1);
  await h.masters(drama.id, [1]);
  await h.tx.run((tx) => h.content.list(tx, h.actor.identity, drama.id));
  await h.tx.run((tx) =>
    h.content.delist(tx, h.actor.identity, drama.id, { reasonCode: "ops_strategy" }),
  );
  h.clock.set(new Date("2028-01-01T16:00:00Z"));
  const service = createContentMaintenance({
    clock: h.clock,
    usage: h.assembly.port(DramaUsagePort),
    media: h.media,
  });
  const run = (signal = new AbortController().signal) =>
    service.archiveSweep({ scheduledFor: h.clock.now(), signal, runTx: h.tx.run });
  return { h, drama, poster, run };
}
it("归档止日按上海边界；原片与封面90天、法定证明止日次日加3年，重复不重写事实", async () => {
  const { h, drama, poster, run } = await fixture();
  const master = await h.prisma.dramaEpisodeMaster.findFirstOrThrow({
    where: { dramaId: drama.id },
  });
  const count = await h.prisma.statusTransition.count({ where: { subjectId: drama.id } });
  h.clock.set(new Date("2028-01-01T15:59:59.999Z"));
  expect(await run()).toEqual({ archived: 0 });
  h.clock.advance(1);
  expect(await run()).toEqual({ archived: 1 });
  const at = h.clock.now(),
    keep = new Date(at.getTime() + 90 * 86400000);
  expect(await h.prisma.drama.findUnique({ where: { id: drama.id } })).toMatchObject({
    status: "delisted",
    archivedAt: at,
  });
  expect(
    await h.prisma.fileRef.findFirst({ where: { refId: master.id, role: "main" } }),
  ).toMatchObject({ state: "released", keepUntil: keep });
  expect(
    await h.prisma.fileRef.findFirst({ where: { refId: drama.id, fileId: poster.id } }),
  ).toMatchObject({ state: "released", keepUntil: keep });
  const permits = await h.prisma.dramaPermit.findMany({ where: { dramaId: drama.id } });
  const revisions = await h.prisma.dramaCopyrightRevision.findMany({
    where: { dramaId: drama.id },
  });
  const proofRefs = await h.prisma.fileRef.findMany({
    where: {
      OR: [
        { refType: "drama_permit", refId: { in: permits.map((v) => v.id) } },
        { refType: "drama_copyright", refId: drama.id },
        { refType: "drama_copyright_revision", refId: { in: revisions.map((v) => v.id) } },
      ],
    },
  });
  expect(proofRefs).toHaveLength(3);
  for (const ref of proofRefs)
    expect(ref).toMatchObject({ state: "released", keepUntil: new Date("2031-01-01T16:00:00Z") });
  h.clock.advance(86400000);
  expect(await run()).toEqual({ archived: 0 });
  expect((await h.prisma.drama.findUniqueOrThrow({ where: { id: drama.id } })).archivedAt).toEqual(
    at,
  );
  expect(await h.prisma.statusTransition.count({ where: { subjectId: drama.id } })).toBe(count);
  expect(
    await h.prisma.auditLog.count({
      where: { targetId: drama.id, action: "content.drama.archive" },
    }),
  ).toBe(1);
});
it("仍有上线订单项不能归档，取消或结束前不释放任何当前引用", async () => {
  const { h, drama, run } = await fixture();
  await h.make.orderItem({ dramaId: drama.id, phase: "live" });
  expect(await run()).toEqual({ archived: 0 });
  expect(
    (await h.prisma.drama.findUniqueOrThrow({ where: { id: drama.id } })).archivedAt,
  ).toBeNull();
  expect(await h.prisma.fileRef.count({ where: { refId: drama.id, state: "released" } })).toBe(0);
});
it("失租取消发生在事务之前时不归档不释放，保留本轮失败", async () => {
  const { h, drama, run } = await fixture(),
    abort = new AbortController();
  abort.abort();
  await expect(run(abort.signal)).rejects.toThrow();
  expect(
    (await h.prisma.drama.findUniqueOrThrow({ where: { id: drama.id } })).archivedAt,
  ).toBeNull();
});
it("旧已释放180天引用与其他剧的live同文件引用均不缩短或清掉", async () => {
  const { h, drama, run } = await fixture();
  const old = await h.prisma.dramaEpisodeMaster.findFirstOrThrow({ where: { dramaId: drama.id } });
  await h.masters(drama.id, [1]);
  const original = await h.prisma.fileRef.findFirstOrThrow({
    where: { refId: old.id, role: "main" },
  });
  const other = await h.make.drama({ status: "draft", totalEpisodes: 1 });
  const copied = await h.prisma.dramaEpisodeMaster.create({
    data: {
      id: uuidv7(),
      dramaId: other.id,
      episodeNo: 1,
      revNo: 1,
      fileId: old.fileId,
      state: "ready",
      isCurrent: true,
      createdByStaffId: h.employee.id,
      activatedAt: h.clock.now(),
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  await h.tx.run((tx) =>
    h.media.link(tx, {
      fileId: old.fileId,
      entityId: null,
      storeId: null,
      refType: "drama_episode_master",
      refId: copied.id,
      role: "main",
    }),
  );
  await run();
  expect(await h.prisma.fileRef.findUnique({ where: { id: original.id } })).toMatchObject({
    state: "released",
    keepUntil: original.keepUntil,
  });
  expect(await h.prisma.fileRef.findFirst({ where: { refId: copied.id } })).toMatchObject({
    state: "live",
  });
  expect(
    (await h.prisma.fileObject.findUniqueOrThrow({ where: { id: old.fileId } })).purgeAfter,
  ).toBeNull();
});
