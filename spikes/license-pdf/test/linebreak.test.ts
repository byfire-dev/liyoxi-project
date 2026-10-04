import { describe, expect, it } from "vitest";

import {
  hyphenationCallback,
  MAX_LATIN_RUN,
  NBSP,
  noBreakSpaces,
  segment,
} from "../src/linebreak.ts";

describe("并段：段内不换行", () => {
  it("句号、逗号、顿号、右引号、右括号并进前一段，不会落在行首", () => {
    expect(segment("授权、转让。（完）”好")).toEqual(["授", "权、", "转", "让。", "（完）”", "好"]);
  });

  it("左引号、左括号、左书名号并进后一段，不会落在行尾", () => {
    expect(segment("见《协议》第“一”条")).toEqual(["见", "《协", "议》", "第", "“一”", "条"]);
  });

  it("全角标点连用：整串跟着前一个字", () => {
    expect(segment("为止。。。，，，……——好")).toEqual(["为", "止。。。，，，……——", "好"]);
  });

  it("24 个字符以内的西文与数字不拆：金额、日期、短编号保持完整", () => {
    expect(segment("共￥1,234,567.89元")).toEqual(["共", "￥1,234,567.89", "元"]);
    expect(segment("编号SQ2026092600018-1-DY。")).toEqual(["编", "号", "SQ2026092600018-1-DY。"]);
  });

  it("过长的西文串先在分隔符之后拆", () => {
    const url = "https://portal.example.com/v/AbCdEfGh12345678?from=license";
    const clusters = segment(url);
    expect(clusters.join("")).toBe(url);
    expect(clusters.every((cluster) => cluster.length <= MAX_LATIN_RUN)).toBe(true);
    expect(clusters).toContain("portal.");
  });

  it("没有分隔符的超长串逐字拆，不会撑出页边", () => {
    const long = "A".repeat(60);
    expect(segment(long)).toHaveLength(60);
  });

  it("西文的右括号、逗号跟着前一段；左括号跟着后一段", () => {
    expect(segment("甲(乙),丙")).toEqual(["甲", "(乙),", "丙"]);
  });

  it("不换行空格跟着前一段：空格不落在行首", () => {
    expect(segment(noBreakSpaces("共 80 集"))).toEqual([`共${NBSP}`, `80${NBSP}`, "集"]);
  });

  it("并段不丢字、不加字", () => {
    const text = "他说：“好的……（停顿）——真的吗？！”𬌗龘 Gross Volume 2026-10-04";
    expect(segment(text).join("")).toBe(text);
  });
});

describe("交给排版引擎的回调", () => {
  it("每一段后面跟一个空串", () => {
    expect(hyphenationCallback("授权书。")).toEqual(["授", "", "权", "", "书。", ""]);
  });

  it("空字符串返回空数组", () => {
    expect(hyphenationCallback("")).toEqual([]);
  });
});
