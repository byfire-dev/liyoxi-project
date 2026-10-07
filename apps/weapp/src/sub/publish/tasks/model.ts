import type { Submit } from "../../order/components/delivery-api";
export interface LinkForm {
  kind: "collection" | "episodes";
  collection: string;
  episodes: string;
  count: string;
  date: string;
}
export function submitBody(form: LinkForm): Submit {
  const count = Number(form.count);
  if (!Number.isInteger(count) || count < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(form.date))
    throw new Error("请填写已发布集数和实际上线日期");
  if (form.kind === "collection") {
    if (!form.collection.trim()) throw new Error("请填写合集链接");
    return {
      linkKind: "collection",
      collectionUrl: form.collection.trim(),
      reportedEpisodeCount: count,
      actualLaunchDate: form.date,
    };
  }
  const episodeUrls = form.episodes
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match || Number(match[1]) < 1) throw new Error("请填写各集的集号和链接");
      return { episodeNo: Number(match[1]), url: match[2]!.trim() };
    });
  if (
    !episodeUrls.length ||
    new Set(episodeUrls.map((e) => e.episodeNo)).size !== episodeUrls.length
  )
    throw new Error("请填写不重复的逐集链接");
  return {
    linkKind: "episodes",
    episodeUrls,
    reportedEpisodeCount: count,
    actualLaunchDate: form.date,
  };
}
export { mergeTaskPages } from "../components/merge-task-pages";
