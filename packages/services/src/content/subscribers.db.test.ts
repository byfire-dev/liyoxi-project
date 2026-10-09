import { afterEach, expect, it } from "vitest";
import { z } from "@liyoxi/contract";
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
async function world() {
  const h = await lifecycleWorld(db);
  owned.push(h);
  return {
    h,
    service: createContentMaintenance({
      clock: h.clock,
      usage: h.assembly.port(DramaUsagePort),
      media: h.media,
    }),
  };
}
it("masters_changed只回填当前已提交批次，旧事件不能回退时长或重新置复核", async () => {
  const { h, service } = await world(),
    { drama } = await h.draft(1);
  const old = await h.masters(drama.id, [1], true),
    latest = await h.masters(drama.id, [1], false);
  const event = async (id: string) => {
    const row = await h.prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: "drama.masters_changed", dedupeKey: id },
    });
    return {
      id: row.id,
      type: row.eventType,
      payload: z.record(z.string(), z.unknown()).parse(row.payload),
    };
  };
  await h.prisma.dramaEpisodeMaster.updateMany({
    where: { uploadBatchId: latest.batch.id },
    data: { durationMs: 23456 },
  });
  await h.tx.run(async (tx) => service.onMastersChanged(tx, await event(latest.batch.id)));
  const before = await h.prisma.drama.findUniqueOrThrow({ where: { id: drama.id } });
  await h.tx.run(async (tx) => service.onMastersChanged(tx, await event(old.batch.id)));
  expect(await h.prisma.dramaEpisode.findFirst({ where: { dramaId: drama.id } })).toMatchObject({
    durationMs: 23456,
  });
  expect(await h.prisma.drama.findUnique({ where: { id: drama.id } })).toMatchObject({
    lockVersion: before.lockVersion,
    isPermitRecheckRequired: false,
  });
});
it("实际当前changed批次置复核，未提交与错剧批次载荷不能改变父聚合", async () => {
  const { h, service } = await world(),
    { drama } = await h.draft(1),
    current = await h.masters(drama.id, [1], true);
  const payload = {
    v: 1,
    dramaId: drama.id,
    uploadBatchId: current.batch.id,
    episodeNos: [1],
    isContentChanged: false,
  };
  await h.tx.run((tx) =>
    service.onMastersChanged(tx, { id: uuidv7(), type: "drama.masters_changed", payload }),
  );
  expect(await h.prisma.drama.findUnique({ where: { id: drama.id } })).toMatchObject({
    isPermitRecheckRequired: true,
  });
  const before = await h.prisma.drama.findUniqueOrThrow({ where: { id: drama.id } });
  await h.tx.run((tx) =>
    service.onMastersChanged(tx, {
      id: uuidv7(),
      type: "drama.masters_changed",
      payload: { ...payload, uploadBatchId: uuidv7() },
    }),
  );
  expect(await h.prisma.drama.findUnique({ where: { id: drama.id } })).toMatchObject({
    lockVersion: before.lockVersion,
  });
});
it("trailer_ready只有当前target与current相同的真实ready资产能刷新版本", async () => {
  const { h, service } = await world(),
    { drama } = await h.draft(1),
    file = await h.make.fileObject({
      category: "trailer_src",
      bucket: "media",
      mime: "video/mp4",
      ext: "mp4",
    });
  const asset = await h.prisma.playableAsset.create({
    data: {
      id: uuidv7(),
      kind: "trailer",
      ownerType: "drama",
      ownerId: drama.id,
      sourceFileId: file.id,
      state: "ready",
      specVersion: 1,
      readyAt: h.clock.now(),
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  await h.prisma.dramaTrailer.create({
    data: {
      dramaId: drama.id,
      targetPlayableAssetId: asset.id,
      currentPlayableAssetId: asset.id,
      setByStaffId: h.employee.id,
      setAt: h.clock.now(),
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  const before = await h.prisma.drama.findUniqueOrThrow({ where: { id: drama.id } });
  await h.tx.run((tx) =>
    service.onTrailerReady(tx, {
      id: uuidv7(),
      type: "drama.trailer_ready",
      payload: { v: 1, dramaId: drama.id, playableAssetId: uuidv7() },
    }),
  );
  expect((await h.prisma.drama.findUniqueOrThrow({ where: { id: drama.id } })).lockVersion).toBe(
    before.lockVersion,
  );
  await h.tx.run((tx) =>
    service.onTrailerReady(tx, {
      id: uuidv7(),
      type: "drama.trailer_ready",
      payload: { v: 1, dramaId: drama.id, playableAssetId: asset.id },
    }),
  );
  expect((await h.prisma.drama.findUniqueOrThrow({ where: { id: drama.id } })).lockVersion).toBe(
    before.lockVersion + 1,
  );
});
