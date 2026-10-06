import { AppError, uuidv7 } from "../kernel/index.js";
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
    return {
      episodeNo: i + 1,
      title:
        r?.title ??
        p?.titleTemplate
          ?.replaceAll("{剧名}", title)
          .replaceAll("{集数}", String(i + 1))
          .replaceAll("{看点}", r?.highlight ?? "") ??
        "",
      topics: r?.topics.length ? r.topics : (p?.topics ?? []),
      intro: r?.intro ?? p?.intro ?? null,
    };
  });
  const complete =
    !!p?.collectionName?.trim() &&
    !!p.coverFileId &&
    !!p.intro?.trim() &&
    episodes.every((e) => !!e.title.trim() && e.topics.length > 0);
  return {
    p,
    episodes,
    complete,
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
