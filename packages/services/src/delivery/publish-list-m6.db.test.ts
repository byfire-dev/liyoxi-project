import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { createIdempotencyContext, uuidv7 } from "../kernel/index.js";
import { createPublishLists } from "./publish-list-service.js";
import { prefillPublishList } from "./publish-list.js";
import { ticketOf } from "./repo.js";
import { findDeliveryViolations } from "./invariants.js";
import { m5Harness, released } from "./__fixtures__/m5.js";
import type { M5Harness } from "./__fixtures__/m5.js";

const db = useSeededDatabase("services", { max: 2 });
let h: M5Harness;
let pushed: Awaited<ReturnType<typeof released>>;
beforeAll(async () => {
  h = m5Harness(await db.prisma());
  pushed = await released(h);
}, 120_000);
afterAll(() => h?.close());
const service = () => createPublishLists(h.deps);
async function editing(episodeCount = 3) {
  const poster = await h.make.fileObject();
  const o = await h.order(true, 1, poster.id, episodeCount),
    a = await h.staff();
  const t = await h.prisma.deliveryTicket.findUniqueOrThrow({
    where: { orderItemId: o.items[0]!.id },
  });
  // Historical delivering input isolates content editing; the pushed fixture above exercises the real producer.
  await h.prisma.deliveryTicket.update({ where: { id: t.id }, data: { step: "delivering" } });
  await h.tx.run(async (tx) => prefillPublishList(tx, h.deps, await ticketOf(tx, t.id)));
  const input = {
    lockVersion: 0,
    collectionName: "发布合集",
    coverFileId: poster.id,
    titleTemplate: "{剧名} 第{集数}集 {看点}",
    topics: ["#悬疑"],
    intro: "发布简介",
    episodes: [],
  };
  return { o, a, t, input };
}
const snapshot = async (id: string) => ({
  list: await h.prisma.publishList.findUnique({ where: { deliveryTicketId: id } }),
  rows: await h.prisma.publishListEpisode.findMany({
    where: { deliveryTicketId: id },
    orderBy: { episodeNo: "asc" },
  }),
  events: await h.prisma.outboxEvent.count({
    where: {
      eventType: "publish_list.updated",
      payload: { path: ["deliveryTicketId"], equals: id },
    },
  }),
});

describe("M6发布清单真实内容事务", () => {
  it("预填N行且重进保留已保存内容；未进入交付的GET零写404", async () => {
    const f = await editing();
    expect((await snapshot(f.t.id)).rows).toHaveLength(3);
    await service().replace(f.a.ctx, f.a.staff, f.t.id, f.input);
    const before = await snapshot(f.t.id);
    await h.tx.run(async (tx) => prefillPublishList(tx, h.deps, await ticketOf(tx, f.t.id)));
    expect(await snapshot(f.t.id)).toEqual(before);
    const early = await h.order(true),
      t = await h.prisma.deliveryTicket.findUniqueOrThrow({
        where: { orderItemId: early.items[0]!.id },
      });
    await expect(service().get(f.a.staff, t.id)).rejects.toMatchObject({ error: "NOT_FOUND" });
    expect(await h.prisma.publishList.count({ where: { deliveryTicketId: t.id } })).toBe(0);
  });
  it("并行保存只有一个版本胜出；同键重放不重复事件且脱敏封面", async () => {
    const f = await editing();
    const calls = await Promise.allSettled(
      ["甲", "乙"].map((intro) =>
        service().replace(f.a.ctx, f.a.staff, f.t.id, { ...f.input, intro }),
      ),
    );
    expect(calls.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(calls.find((r) => r.status === "rejected")).toMatchObject({
      reason: { error: "VERSION_CONFLICT", details: { lockVersion: 1 } },
    });
    expect((await snapshot(f.t.id)).events).toBe(1);
    const key = uuidv7(),
      body = { ...f.input, lockVersion: 1 };
    const context = () =>
      createIdempotencyContext({
        mode: "required",
        scope: "admin.deliveryTicket.publishList.replace",
        actor: f.a.ctx.actor,
        key,
        request: { method: "PUT", body },
        redact: ["cover.url", "cover.expiresAt"],
      });
    await service().replace(f.a.ctx, f.a.staff, f.t.id, body, { idem: context() });
    const idem = context(),
      replay = await service().replace(f.a.ctx, f.a.staff, f.t.id, body, { idem });
    expect(replay.replayed).toBe(true);
    expect(replay.cover).toMatchObject({ url: null, expiresAt: null });
    expect((await snapshot(f.t.id)).events).toBe(2);
  });
  it("整表导入行错零写；只更新出现列与集号，遗漏覆盖保留", async () => {
    const f = await editing();
    const before = await snapshot(f.t.id);
    await expect(
      service().import(f.a.ctx, f.a.staff, f.t.id, {
        lockVersion: 0,
        format: "csv",
        content: "集号,标题\n1,正确\n4,越界",
      }),
    ).rejects.toMatchObject({ error: "PUBLISH_LIST_IMPORT_INVALID" });
    expect(await snapshot(f.t.id)).toEqual(before);
    const saved = await service().replace(f.a.ctx, f.a.staff, f.t.id, {
      ...f.input,
      episodes: [
        { episodeNo: 1, title: "保留标题", highlight: "看点", topics: ["追剧"], intro: "逐集简介" },
        { episodeNo: 2, title: "第二集", highlight: null, topics: null, intro: null },
      ],
    });
    const imported = await service().import(f.a.ctx, f.a.staff, f.t.id, {
      lockVersion: saved.lockVersion,
      format: "tsv",
      content: "集号\t看点\n1\t",
    });
    expect(imported.updatedEpisodeNos).toEqual([1]);
    expect(imported.publishList.episodes[0]).toMatchObject({
      title: "保留标题",
      highlight: null,
      topics: ["追剧"],
      intro: "逐集简介",
    });
    expect(imported.publishList.episodes[1]?.title).toBe("第二集");
    const replaced = await service().replace(f.a.ctx, f.a.staff, f.t.id, {
      ...f.input,
      lockVersion: imported.publishList.lockVersion,
    });
    expect(replaced.episodes.every((r) => r.title === null && r.highlight === null)).toBe(true);
  });
  it("整部集数越界与错误封面拒绝，内容事务全部回滚", async () => {
    const f = await editing(),
      before = await snapshot(f.t.id);
    await expect(
      service().replace(f.a.ctx, f.a.staff, f.t.id, {
        ...f.input,
        episodes: [{ episodeNo: 4, title: null, highlight: null, topics: null, intro: null }],
      }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    const wrong = await h.make.fileObject({ category: "evidence" });
    await expect(
      service().replace(f.a.ctx, f.a.staff, f.t.id, { ...f.input, coverFileId: wrong.id }),
    ).rejects.toMatchObject({ error: "FILE_NOT_USABLE" });
    expect(await snapshot(f.t.id)).toEqual(before);
  });
  it("真实推包后修订更新text并只失效ZIP，现行视频引用与下载授权保留", async () => {
    const view = await service().get(pushed.qc.staff, pushed.id);
    const refs = await h.prisma.fileRef.findMany({
      where: { refType: "delivery_release", refId: pushed.release.deliveryReleaseId },
    });
    expect(refs.length).toBeGreaterThan(0);
    const file = await h.make.fileObject({
      category: "package_zip",
      bucket: "media",
      scopeType: "store",
      entityId: pushed.o.entity.id,
      storeId: pushed.o.store.id,
      ext: "zip",
      mime: "application/zip",
      declaredMime: "application/zip",
    });
    const zip = await h.prisma.zipBundle.create({
      data: {
        id: uuidv7(),
        ownerType: "delivery_release",
        ownerId: pushed.release.deliveryReleaseId,
        zipState: "ready",
        zipGen: 1,
        zipFileId: file.id,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    // Existing ZIP cache is historical input; W6-07 owns its producer. The actual invalidator is exercised below.
    await h.prisma.fileRef.create({
      data: {
        id: uuidv7(),
        fileId: file.id,
        refType: "zip_bundle",
        refId: zip.id,
        role: "zip",
        state: "live",
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const grants = await h.prisma.downloadGrant.findMany({
      where: { orderItemId: pushed.item.id },
    });
    const saved = await service().replace(pushed.qc.ctx, pushed.qc.staff, pushed.id, {
      lockVersion: view.lockVersion,
      collectionName: view.collectionName,
      coverFileId: view.cover?.fileId ?? null,
      titleTemplate: view.titleTemplate,
      topics: view.topics,
      intro: "修订后的真实发布简介",
      episodes: [],
    });
    expect(saved.lockVersion).toBe(view.lockVersion + 1);
    expect(await h.prisma.zipBundle.findUnique({ where: { id: zip.id } })).toMatchObject({
      zipState: "none",
      zipGen: 2,
      zipFileId: null,
    });
    expect(
      await h.prisma.fileRef.findMany({
        where: { refType: "delivery_release", refId: pushed.release.deliveryReleaseId },
      }),
    ).toEqual(refs);
    expect(
      await h.prisma.downloadGrant.findMany({ where: { orderItemId: pushed.item.id } }),
    ).toEqual(grants);
    const merchant = await service().merchantGet(pushed.o.viewer, pushed.item.id);
    expect(merchant.text).toContain("修订后的真实发布简介");
    expect(
      await service().portalGet(
        { entityId: pushed.o.entity.id, storeId: pushed.o.store.id },
        pushed.item.id,
      ),
    ).toMatchObject({ text: merchant.text });
    await expect(
      service().portalGet({ entityId: pushed.o.entity.id, storeId: uuidv7() }, pushed.item.id),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
  });
  it("暂停与首次回填永久锁定；已有changedInReleaseNo不被清空", async () => {
    const f = await editing();
    await h.prisma.publishListEpisode.update({
      where: { deliveryTicketId_episodeNo: { deliveryTicketId: f.t.id, episodeNo: 1 } },
      data: { changedInReleaseNo: 2 },
    });
    expect(
      (await service().replace(f.a.ctx, f.a.staff, f.t.id, f.input)).episodes[0]
        ?.changedInReleaseNo,
    ).toBe(2);
    await h.prisma.deliveryTicket.update({
      where: { id: f.t.id },
      data: { pauseCount: 1, pausedAt: h.clock.now() },
    });
    await expect(
      service().replace(f.a.ctx, f.a.staff, f.t.id, { ...f.input, lockVersion: 1 }),
    ).rejects.toMatchObject({ error: "TICKET_ON_HOLD" });
    await h.prisma.deliveryTicket.update({
      where: { id: f.t.id },
      data: { pauseCount: 0, pausedAt: null },
    });
    await h.prisma.deliveryTicket.update({
      where: { id: f.t.id },
      data: { linksSubmittedAt: h.clock.now() },
    });
    await expect(
      service().replace(f.a.ctx, f.a.staff, f.t.id, { ...f.input, lockVersion: 1 }),
    ).rejects.toMatchObject({ error: "PUBLISH_LIST_LOCKED" });
    expect(await service().get(f.a.staff, f.t.id)).toMatchObject({
      isEditable: false,
      lockReason: "links_submitted",
    });
  });
  it("I16报告真实缺头和越界行，不自愈或静默忽略", async () => {
    const f = await editing(1);
    expect(await h.tx.run((tx) => findDeliveryViolations(tx, "I16"))).toEqual([]);
    await h.prisma.publishList.delete({ where: { deliveryTicketId: f.t.id } });
    await h.prisma.publishListEpisode.create({
      data: {
        deliveryTicketId: f.t.id,
        episodeNo: 2,
        topics: [],
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const found = (await h.tx.run((tx) => findDeliveryViolations(tx, "I16"))).filter(
      (r) => r.subject && "id" in r.subject && r.subject.id.startsWith(f.t.id),
    );
    expect(found).toHaveLength(2);
    expect(found[1]?.detail).toMatchObject({
      missingPublishList: true,
      episodeNo: 2,
      episodeCount: 1,
    });
    expect(await h.prisma.publishList.count({ where: { deliveryTicketId: f.t.id } })).toBe(0);
  });
});
