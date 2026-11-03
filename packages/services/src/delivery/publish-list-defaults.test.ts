import { describe, expect, it } from "vitest";
import { DramaCreateBodySchema, PublishListReplaceBodySchema } from "@liyoxi/contract";
import { publishListDefaults } from "./publish-list-defaults.js";

const defaults = (input: Partial<Parameters<typeof publishListDefaults>[0]> = {}) =>
  publishListDefaults({
    title: "夜巷疑云",
    episodeCount: 45,
    genreNames: ["悬疑", "都市"],
    synopsis: "一部虚构短剧的简介。",
    ...input,
  });
const body = (value: ReturnType<typeof defaults>) => ({
  lockVersion: 0,
  ...value,
  coverFileId: null,
  titleTemplate: "{剧名} 第{集数}集",
  episodes: [],
});

describe("首次发布清单的生成值", () => {
  it("保留普通默认值与有效20单位话题，生成结果满足原保存契约", () => {
    const value = defaults({ genreNames: ["悬疑", "都".repeat(20)] });
    expect(value).toEqual({
      collectionName: "夜巷疑云（全 45 集）",
      topics: ["悬疑", "都".repeat(20)],
      intro: "一部虚构短剧的简介。",
    });
    expect(PublishListReplaceBodySchema.parse(body(value))).toEqual(body(value));
  });

  it("合法emoji剧名回退为可保存话题，不截出半个代理对", () => {
    const title = "😀".repeat(11);
    expect(DramaCreateBodySchema.parse({ title })).toEqual({ title });
    expect(
      PublishListReplaceBodySchema.safeParse(body({ ...defaults(), topics: [title] })).success,
    ).toBe(false);
    const value = defaults({ title, genreNames: [] });
    expect(value.topics).toEqual(["😀".repeat(10)]);
    expect(value.collectionName).toBe(`${title}（全 45 集）`);
    expect(PublishListReplaceBodySchema.parse(body(value))).toEqual(body(value));
    expect(defaults({ genreNames: ["字".repeat(19) + "😀"] }).topics).toEqual(["字".repeat(19)]);
  });

  it("话题在规范化与截取后去空去重，再按输入顺序保留最多10个", () => {
    const names = [
      "",
      " # ",
      " # #悬疑 ",
      "悬疑",
      "长".repeat(20) + "甲",
      "长".repeat(20) + "乙",
      ...Array.from({ length: 11 }, (_, i) => `题材${i + 1}`),
    ];
    const value = defaults({ genreNames: names });
    expect(value.topics).toEqual(["悬疑", "长".repeat(20), ...names.slice(6, 14)]);
    expect(PublishListReplaceBodySchema.parse(body(value))).toEqual(body(value));
  });

  it("所有题材都为空才回退剧名；没有有效回退时保留待完善的空话题", () => {
    expect(defaults({ genreNames: ["", " ", "#", " # # "] }).topics).toEqual(["夜巷疑云"]);
    const value = defaults({ title: " # ", genreNames: ["#"] });
    expect(value.topics).toEqual([]);
    expect(PublishListReplaceBodySchema.parse(body(value))).toEqual(body(value));
  });

  it("历史超长剧名的防御性合集保留完整集数后缀与字符", () => {
    const suffix = "（全 999 集）";
    const title = "字".repeat(60 - suffix.length - 1) + "😀尾部";
    const value = defaults({ title, episodeCount: 999 });
    expect(value.collectionName).toBe("字".repeat(60 - suffix.length - 1) + suffix);
    expect(value.collectionName.length).toBe(59);
    expect(
      defaults({ title: "字".repeat(60 - suffix.length), episodeCount: 999 }).collectionName.length,
    ).toBe(60);
    expect(PublishListReplaceBodySchema.parse(body(value))).toEqual(body(value));
  });

  it("简介保留原200单位预算，边界不拆emoji，空值保持原义", () => {
    expect(defaults({ synopsis: "字".repeat(199) + "😀尾部" }).intro).toBe("字".repeat(199));
    expect(defaults({ synopsis: "字".repeat(200) }).intro).toBe("字".repeat(200));
    expect(defaults({ synopsis: null }).intro).toBeNull();
    expect(defaults({ synopsis: "" }).intro).toBe("");
  });
});
