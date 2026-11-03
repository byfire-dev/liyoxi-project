import { describe, expect, it } from "vitest";
import { AppError } from "../kernel/index.js";
import { parsePublishListImport } from "./publish-list-import.js";
import type { PublishListImportIssue } from "./publish-list-import.js";

function invalid(content: string, episodeCount = 3, format: "csv" | "tsv" = "csv") {
  try {
    parsePublishListImport(content, format, episodeCount);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ error: "PUBLISH_LIST_IMPORT_INVALID" });
    return ((error as AppError).details as { rows: PublishListImportIssue[] }).rows;
  }
  throw new Error("预期整批拒绝，解析却返回了可写入行");
}

describe("发布清单 CSV/TSV 整批导入解析", () => {
  it("仅返回表头对应覆盖列，空单元格清空，省略集号不补写", () => {
    expect(parsePublishListImport("集号,标题,话题\n1,第一集,#短剧 #故事\n3,,", "csv", 3)).toEqual({
      rows: [
        { rowNo: 2, episodeNo: 1, title: "第一集", topics: ["短剧", "故事"] },
        { rowNo: 3, episodeNo: 3, title: null, topics: [] },
      ],
    });
  });

  it("接受 BOM、CRLF、引号内分隔符/换行/双引号，并保留单元格原文", () => {
    const content =
      '\uFEFF集号,标题,简介\r\n1,"你好,世界","第一行\r\n第二行"\r\n2,"他说""好""",\r\n';
    expect(parsePublishListImport(content, "csv", 2)).toEqual({
      rows: [
        { rowNo: 2, episodeNo: 1, title: "你好,世界", intro: "第一行\r\n第二行" },
        { rowNo: 4, episodeNo: 2, title: '他说"好"', intro: null },
      ],
    });
  });

  it("TSV 使用制表符分列，话题空格与井号均可分隔", () => {
    expect(
      parsePublishListImport('集号\t看点\t话题\n2\t"剧情\t反转"\t#剧情#反转 短剧', "tsv", 3),
    ).toEqual({
      rows: [{ rowNo: 2, episodeNo: 2, highlight: "剧情\t反转", topics: ["剧情", "反转", "短剧"] }],
    });
  });

  it.each([
    ["标题\n标题", "集号"],
    ["集号\n1", "header"],
    ["集号,未知\n1,内容", "未知"],
    ["集号,标题,标题\n1,甲,乙", "标题"],
    ["集号,集号,标题\n1,1,甲", "集号"],
  ])("拒绝不完整、未知或重复表头：%s", (content, column) => {
    expect(invalid(content)).toEqual(
      expect.arrayContaining([expect.objectContaining({ rowNo: 1, column })]),
    );
  });

  it.each(['集号,标题\n1,"未闭合', '集号,标题\n1,错"引号', '集号,标题\n1,"闭合后"多余'])(
    "拒绝损坏的引用语法：%s",
    (content) => {
      expect(invalid(content)).toEqual([
        expect.objectContaining({ rowNo: 2, episodeNo: null, column: "content" }),
      ]);
    },
  );

  it("保留真实物理行号并一次报告全部行级错误，不返回前面的合法补丁", () => {
    const issues = invalid(
      '集号,标题,简介\n1,合法,"两行\n简介"\n2,' + "长".repeat(101) + ",\n4,越界,\n1,重复,",
      3,
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rowNo: 2,
          episodeNo: 1,
          column: "集号",
          message: "集号不能重复",
        }),
        expect.objectContaining({ rowNo: 4, episodeNo: 2, column: "标题" }),
        expect.objectContaining({ rowNo: 5, episodeNo: 4, column: "集号" }),
        expect.objectContaining({
          rowNo: 6,
          episodeNo: 1,
          column: "集号",
          message: "集号不能重复",
        }),
      ]),
    );
  });

  it.each(["0", "-1", "1.5", "1e0", "", "9007199254740992"])("拒绝非法集号 %s", (episode) => {
    expect(invalid(`集号,标题\n${episode},标题`)).toEqual([
      expect.objectContaining({ rowNo: 2, column: "集号" }),
    ]);
  });

  it("拒绝空数据、空白数据行、缺列和多列", () => {
    expect(invalid("集号,标题\n")).toEqual([
      expect.objectContaining({ rowNo: 1, column: "content" }),
    ]);
    expect(invalid("集号,标题\n1,标题\n\n2,标题")).toEqual(
      expect.arrayContaining([expect.objectContaining({ rowNo: 3, column: "集号" })]),
    );
    expect(invalid("集号,标题\n1\n2,标题,多余")).toEqual([
      expect.objectContaining({ rowNo: 2, column: "content" }),
      expect.objectContaining({ rowNo: 3, column: "content" }),
    ]);
  });

  it("按 UTF-8 字节限制 200 KB，不能用字符数代替", () => {
    const content = `集号,简介\n1,${"中".repeat(70_000)}`;
    expect(content.length).toBeLessThan(200 * 1024);
    expect(invalid(content)).toEqual([expect.objectContaining({ rowNo: 1, column: "content" })]);
  });

  it("文本上限可取等号，越界和话题数/长度/重复分别拒绝", () => {
    const accepted = `集号,看点,标题,话题,简介\n1,${"点".repeat(30)},${"题".repeat(100)},${"签".repeat(20)},${"简".repeat(200)}`;
    expect(parsePublishListImport(accepted, "csv", 1).rows).toHaveLength(1);
    expect(invalid(`集号,看点,简介\n1,${"点".repeat(31)},${"简".repeat(201)}`)).toEqual([
      expect.objectContaining({ rowNo: 2, column: "看点" }),
      expect.objectContaining({ rowNo: 2, column: "简介" }),
    ]);
    for (const topics of [
      Array.from({ length: 11 }, (_, i) => `标签${i}`).join(" "),
      "长".repeat(21),
      "#重复 重复",
    ]) {
      expect(invalid(`集号,话题\n1,${topics}`)).toEqual([
        expect.objectContaining({ rowNo: 2, column: "话题" }),
      ]);
    }
  });
});
