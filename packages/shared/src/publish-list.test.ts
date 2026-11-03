import { describe, expect, it } from "vitest";
import { renderPublishListEpisode } from "./publish-list.js";

describe("发布清单唯一渲染", () => {
  const input = {
    dramaTitle: "夜巷",
    episodeNo: 2,
    titleTemplate: "{剧名} 第{集数}集 {看点}",
    topics: ["悬疑"],
    intro: "简介",
  };
  it("展开中文占位符，缺看点为空，头部话题/简介回落", () => {
    expect(renderPublishListEpisode(input)).toEqual({
      episodeNo: 2,
      title: "夜巷 第2集 ",
      topics: ["悬疑"],
      intro: "简介",
    });
  });
  it("逐集覆盖优先；清空覆盖恢复模板与头部，不改变输入", () => {
    const override = { title: "逐集标题", highlight: "反转", topics: ["追剧"], intro: "逐集简介" };
    expect(renderPublishListEpisode({ ...input, override })).toEqual({
      episodeNo: 2,
      title: "逐集标题",
      topics: ["追剧"],
      intro: "逐集简介",
    });
    expect(
      renderPublishListEpisode({
        ...input,
        override: { title: "", highlight: "反转", topics: [], intro: null },
      }),
    ).toEqual({ episodeNo: 2, title: "夜巷 第2集 反转", topics: ["悬疑"], intro: "简介" });
    expect(override.topics).toEqual(["追剧"]);
  });
  it("没有模板与覆盖时标题为空，不虚构完整度", () => {
    expect(renderPublishListEpisode({ ...input, titleTemplate: null }).title).toBe("");
  });
});
