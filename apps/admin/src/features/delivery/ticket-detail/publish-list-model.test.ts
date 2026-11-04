import { expect, it } from "vitest";
import { publishInput } from "./publish-list-model";
import type { PublishList } from "./publish-api";
it("完整逐集替换保留null、空数组、空字符串与显式覆盖，不携带只读渲染/AI字段", () => {
  const view = {
    lockVersion: 7,
    collectionName: null,
    cover: { fileId: "cover" },
    titleTemplate: "{剧名}{集数}",
    topics: ["门店"],
    intro: "",
    isAiDeclarationRequired: true,
    episodes: [
      {
        episodeNo: 1,
        highlight: null,
        title: null,
        topics: null,
        intro: null,
        renderedTitle: "第一集",
        changedInReleaseNo: 1,
      },
      {
        episodeNo: 2,
        highlight: "",
        title: "自定义",
        topics: [],
        intro: "",
        renderedTitle: "自定义",
        changedInReleaseNo: 2,
      },
    ],
  } as PublishList;
  const result = publishInput(view);
  expect(result).toEqual({
    lockVersion: 7,
    collectionName: null,
    coverFileId: "cover",
    titleTemplate: "{剧名}{集数}",
    topics: ["门店"],
    intro: "",
    episodes: [
      { episodeNo: 1, highlight: null, title: null, topics: null, intro: null },
      { episodeNo: 2, highlight: "", title: "自定义", topics: [], intro: "" },
    ],
  });
  result.topics.push("新的话题");
  expect(view.topics).toEqual(["门店"]);
});
