import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DramaBasicBodySchema,
  DramaCreateBodySchema,
  PublishListReplaceBodySchema,
} from "@liyoxi/contract";
import type { PublishListAdminView } from "@liyoxi/contract";
import { createM5DeliveryFixture, useSeededDatabase } from "../testing/index.js";
import type { M5DeliveryFixture } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { prefillPublishList } from "./publish-list.js";
import { createPublishLists } from "./publish-list-service.js";
import { ticketOf } from "./repo.js";

const db = useSeededDatabase("services", { max: 2 });
let h: M5DeliveryFixture;
beforeAll(async () => {
  h = createM5DeliveryFixture(await db.prisma());
});
afterAll(async () => {
  await h?.close();
});

async function editing(title: string, genreCodes: string[] = []) {
  const poster = await h.make.fileObject(),
    drama = await h.make.drama({
      title,
      genreCodes,
      posterFileId: poster.id,
      synopsis: "虚构发布清单简介",
    }),
    order = await h.order(true, 1, poster.id, 1, drama.id),
    staff = await h.staff(),
    item = order.items[0]!;
  const ticket = await h.prisma.deliveryTicket.findUniqueOrThrow({
    where: { orderItemId: item.id },
  });
  // As in the existing content-editing regression, delivering is historical
  // input. Prefill and every list read/write below use their actual owners.
  await h.prisma.deliveryTicket.update({ where: { id: ticket.id }, data: { step: "delivering" } });
  await h.tx.run(async (tx) => prefillPublishList(tx, h.deps, await ticketOf(tx, ticket.id)));
  return { ticket, item, staff, lists: createPublishLists(h.deps) };
}

const snapshot = async (ticketId: string) => {
  const list = await h.prisma.publishList.findUniqueOrThrow({
    where: { deliveryTicketId: ticketId },
  });
  return {
    list,
    episodes: await h.prisma.publishListEpisode.findMany({
      where: { deliveryTicketId: ticketId },
      orderBy: { episodeNo: "asc" },
    }),
    refs: await h.prisma.fileRef.findMany({
      where: { refType: "publish_list", refId: list.id },
      orderBy: { id: "asc" },
    }),
    events: await h.prisma.outboxEvent.count(),
    audits: await h.prisma.auditLog.count(),
  };
};
const saveBody = (view: PublishListAdminView) =>
  PublishListReplaceBodySchema.parse({
    lockVersion: view.lockVersion,
    collectionName: view.collectionName,
    coverFileId: view.cover?.fileId ?? null,
    titleTemplate: view.titleTemplate,
    topics: view.topics,
    intro: view.intro,
    episodes: view.episodes.map(({ episodeNo, highlight, title, topics, intro }) => ({
      episodeNo,
      highlight,
      title,
      topics,
      intro,
    })),
  });

describe("发布清单首次预填的真实保存边界", () => {
  it("合法emoji剧名首次预填可按GET原值保存，GET前后清单与写入记录不变", async () => {
    const title = "😀".repeat(11);
    expect(DramaCreateBodySchema.parse({ title })).toEqual({ title });
    const f = await editing(title),
      beforeRead = await snapshot(f.ticket.id),
      initial = await f.lists.get(f.staff.staff, f.ticket.id);
    expect(initial).toMatchObject({
      collectionName: `${title}（全 1 集）`,
      topics: ["😀".repeat(10)],
      lockVersion: 0,
      savedAt: null,
      episodes: [{ episodeNo: 1, title: null, renderedTitle: `${title} 第1集` }],
    });
    expect(await snapshot(f.ticket.id)).toEqual(beforeRead);
    const body = saveBody(initial);
    const saved = await f.lists.replace(f.staff.ctx, f.staff.staff, f.ticket.id, body);
    expect(saved.lockVersion).toBe(1);
    expect(saveBody(saved)).toEqual({ ...body, lockVersion: 1 });
    expect(saveBody(await f.lists.get(f.staff.staff, f.ticket.id))).toEqual({
      ...body,
      lockVersion: 1,
    });
  });

  it("多题材按快照顺序归一化去空去重并限制10项，初始结果可直接保存", async () => {
    const names = [
      "#预填题材",
      "预填题材",
      " ",
      "#",
      "边".repeat(20),
      ...Array.from({ length: 11 }, (_, i) => `预填分类${i + 1}`),
    ];
    const genres = names.map((name, index) => ({
      id: uuidv7(),
      dictTypeKey: "genre",
      code: `PD${String(index + 1).padStart(2, "0")}`,
      name,
      position: index,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    }));
    await h.prisma.dictItem.createMany({ data: [...genres].reverse() });
    const genreCodes = genres.map((genre) => genre.code);
    expect(DramaBasicBodySchema.parse({ lockVersion: 0, genreCodes }).genreCodes).toEqual(
      genreCodes,
    );
    const f = await editing("题材边界", genreCodes),
      initial = await f.lists.get(f.staff.staff, f.ticket.id);
    expect(initial.topics).toEqual(["预填题材", "边".repeat(20), ...names.slice(5, 13)]);
    const saved = await f.lists.replace(f.staff.ctx, f.staff.staff, f.ticket.id, saveBody(initial));
    expect(saved.topics).toEqual(initial.topics);
    expect(saved.lockVersion).toBe(1);
  });

  it("重进保留用户保存的完整边界值，也不自动修补既有未保存清单", async () => {
    const f = await editing("已有清单"),
      initial = await f.lists.get(f.staff.staff, f.ticket.id);
    const body = {
      ...saveBody(initial),
      collectionName: "用户".repeat(30),
      topics: ["自".repeat(20)],
      intro: "用户保留简介",
      episodes: [
        { episodeNo: 1, title: "用户逐集标题", highlight: null, topics: null, intro: null },
      ],
    };
    await f.lists.replace(f.staff.ctx, f.staff.staff, f.ticket.id, body);
    const saved = await snapshot(f.ticket.id);
    h.clock.advance(1000);
    await h.tx.run(async (tx) => prefillPublishList(tx, h.deps, await ticketOf(tx, f.ticket.id)));
    expect(await snapshot(f.ticket.id)).toEqual(saved);

    const old = await editing("历史清单");
    // Explicit legacy persisted input: reads/reentry must not silently rewrite it.
    await h.prisma.publishList.update({
      where: { deliveryTicketId: old.ticket.id },
      data: { collectionName: "旧".repeat(61), topics: ["旧".repeat(21)] },
    });
    const legacy = await snapshot(old.ticket.id);
    expect(legacy.list.savedAt).toBeNull();
    await h.tx.run(async (tx) => prefillPublishList(tx, h.deps, await ticketOf(tx, old.ticket.id)));
    const read = await old.lists.get(old.staff.staff, old.ticket.id);
    expect(read.collectionName).toBe(legacy.list.collectionName);
    expect(read.topics).toEqual(legacy.list.topics);
    await expect(
      old.lists.replace(old.staff.ctx, old.staff.staff, old.ticket.id, {
        ...body,
        lockVersion: read.lockVersion,
        collectionName: read.collectionName,
        coverFileId: read.cover?.fileId ?? null,
        topics: read.topics,
      }),
    ).rejects.toMatchObject({
      name: "ZodError",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["collectionName"] }),
        expect.objectContaining({ path: ["topics"] }),
      ]),
    });
    expect(await snapshot(old.ticket.id)).toEqual(legacy);
  });
});
