import type { PublishList, PublishReplace } from "./publish-api";
export function publishInput(view: PublishList): PublishReplace {
  return {
    lockVersion: view.lockVersion,
    collectionName: view.collectionName,
    coverFileId: view.cover?.fileId ?? null,
    titleTemplate: view.titleTemplate,
    topics: [...view.topics],
    intro: view.intro,
    episodes: view.episodes.map(({ episodeNo, highlight, title, topics, intro }) => ({
      episodeNo,
      highlight,
      title,
      topics: topics === null ? null : [...topics],
      intro,
    })),
  };
}
export const splitTopics = (value: string) =>
  value
    .split(/[\n,，]/)
    .map((v) => v.trim())
    .filter(Boolean);
export const nullableText = (value: string) => (value === "" ? null : value);
export const lockReason = {
  links_submitted: "商家已经提交上线链接，清单已锁定",
  ticket_paused: "工单已暂停",
  ticket_step: "当前工单步骤不可编辑",
};
