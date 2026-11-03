import { AppError, uuidv7 } from "../kernel/index.js";
import { renderPublishListEpisode } from "@liyoxi/shared/publish-list";
import type { Tx } from "../kernel/index.js";
import type { DeliveryCoreDeps } from "./context.js";
import type { TicketRow } from "./repo.js";
export async function prefillPublishList(tx: Tx, deps: DeliveryCoreDeps, t: TicketRow) {
  if (await tx.publishList.findUnique({ where: { deliveryTicketId: t.id } })) return;
  const drama = await tx.drama.findUniqueOrThrow({ where: { id: t.dramaId } }),
    shot = t.orderItem.dramaSnapshot as {
      title?: string;
      posterFileId?: string;
      genreCodes?: string[];
    };
  const title = shot.title ?? drama.title,
    cover = shot.posterFileId ?? drama.posterFileId,
    genres = await tx.dictItem.findMany({
      where: { dictTypeKey: "genre", code: { in: shot.genreCodes ?? drama.genreCodes } },
    }),
    now = deps.clock.now();
  const p = await tx.publishList.create({
    data: {
      id: uuidv7(),
      entityId: t.entityId,
      storeId: t.storeId,
      deliveryTicketId: t.id,
      collectionName: `${title}（全 ${t.orderItem.episodeCount} 集）`,
      coverFileId: cover,
      titleTemplate: "{剧名} 第{集数}集",
      topics: genres.length ? genres.map((g) => g.name) : [title],
      intro: drama.synopsis?.slice(0, 200) ?? null,
      isAiDeclarationRequired: drama.isAiGenerated,
      createdAt: now,
      updatedAt: now,
    },
  });
  await tx.publishListEpisode.createMany({
    data: Array.from({ length: t.orderItem.episodeCount }, (_, index) => ({
      deliveryTicketId: t.id,
      episodeNo: index + 1,
      topics: [],
      createdAt: now,
      updatedAt: now,
    })),
  });
  if (cover) {
    if (!deps.media) throw new AppError("INTERNAL", { message: "发布清单封面引用尚未装配" });
    await deps.media.link(tx, {
      fileId: cover,
      entityId: null,
      storeId: null,
      refType: "publish_list",
      refId: p.id,
      role: "cover",
    });
  }
}
export async function publishListFacts(tx: Tx, t: TicketRow) {
  const p = await tx.publishList.findUnique({ where: { deliveryTicketId: t.id } }),
    rows = await tx.publishListEpisode.findMany({ where: { deliveryTicketId: t.id } }),
    title = (t.orderItem.dramaSnapshot as { title: string }).title;
  const episodes = Array.from({ length: t.orderItem.episodeCount }, (_, i) => {
    const r = rows.find((r) => r.episodeNo === i + 1);
    return renderPublishListEpisode({
      dramaTitle: title,
      episodeNo: i + 1,
      titleTemplate: p?.titleTemplate ?? null,
      topics: p?.topics ?? [],
      intro: p?.intro ?? null,
      ...(r ? { override: r } : {}),
    });
  });
  const untitledEpisodeNos = episodes.filter((e) => !e.title.trim()).map((e) => e.episodeNo);
  const missing: Array<"collection_name" | "cover" | "intro" | "topics" | "episode_titles"> = [];
  if (!p?.collectionName?.trim()) missing.push("collection_name");
  if (!p?.coverFileId) missing.push("cover");
  if (!p?.intro?.trim()) missing.push("intro");
  if (episodes.some((e) => !e.topics.length)) missing.push("topics");
  if (untitledEpisodeNos.length) missing.push("episode_titles");
  const complete = missing.length === 0;
  return {
    p,
    rows,
    episodes,
    complete,
    completeness: { isComplete: complete, missing, untitledEpisodeNos },
    text: p
      ? [
          p.collectionName,
          `话题：${p.topics.join(" ")}`,
          p.intro,
          ...episodes.map(
            (e) => `${e.episodeNo}. ${e.title}\n${e.topics.join(" ")}\n${e.intro ?? ""}`,
          ),
        ].join("\n")
      : null,
  };
}
