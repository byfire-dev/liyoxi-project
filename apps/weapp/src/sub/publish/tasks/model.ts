import type { Submit, TaskPage } from "../../order/components/delivery-api";
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
      if (!match || Number(match[1]) < 1)
        throw new Error("逐集链接请每行填写集号和链接，用空格分隔");
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
/** 翻页按任务 id 合并，订单与订单项的服务端聚合保持完整。 */
export function mergeTaskPages(previous: TaskPage, next: TaskPage): TaskPage {
  const groups = previous.items.map((g) => ({
    ...g,
    items: g.items.map((i) => ({ ...i, tasks: [...i.tasks] })),
  }));
  for (const group of next.items) {
    const target = groups.find((g) => g.orderId === group.orderId);
    if (!target) {
      groups.push(group);
      continue;
    }
    for (const item of group.items) {
      const old = target.items.find((i) => i.orderItemId === item.orderItemId);
      if (!old) {
        target.items.push(item);
        continue;
      }
      const byId = new Map(old.tasks.map((t) => [t.launchTaskId, t]));
      item.tasks.forEach((t) => byId.set(t.launchTaskId, t));
      Object.assign(old, item, { tasks: [...byId.values()] });
    }
  }
  return { ...next, items: groups };
}
