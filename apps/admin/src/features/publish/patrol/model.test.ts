import { describe, expect, it } from "vitest";
import { abnormalBody, checkedBody, patrolQuery, patrolScope, patrolSearch } from "./model";
import type { Template } from "./api";
export const template = {
  code: "patrol.check",
  versionNo: 4,
  items: [
    { key: "play", label: "实际播放", required: true, allowNa: false, merchantVisible: true },
  ],
} as Template;
const id = "019a0000-0000-7000-8000-000000000001";
describe("巡检范围与正式证据", () => {
  it("列表/summary 同范围，summary 不发送页签页码；非法周一和来源不透传", () => {
    const search = patrolSearch({
      tab: "abnormal",
      q: "门店",
      weekStartDate: "2026-11-02",
      source: "reissue",
      openOnly: "true",
      storeId: id,
      page: 3,
      pageSize: 50,
    });
    const { tab: _tab, page: _page, pageSize: _size, ...scope } = patrolQuery(search)!;
    expect(scope).toEqual(patrolScope(search));
    expect(scope).toMatchObject({
      weekStartDate: "2026-11-02",
      storeId: id,
      openOnly: "true",
      source: "reissue",
    });
    expect(
      patrolSearch({
        weekStartDate: "2026-11-03",
        source: "invented",
        storeId: "bad",
        openOnly: "yes",
      }).filters,
    ).toEqual({});
  });
  it("正常与恢复必须当前清单全过、1–9 张不同证据，不能沿旧模板默认勾选", () => {
    expect(checkedBody(undefined, ["play"], [id])).toBeNull();
    expect(checkedBody(template, [], [id])).toBeNull();
    expect(checkedBody(template, ["play"], [])).toBeNull();
    expect(checkedBody(template, ["play"], [id, id])).toBeNull();
    expect(
      checkedBody(
        template,
        ["play"],
        Array.from({ length: 10 }, (_, i) => `file${i}`),
      ),
    ).toBeNull();
    expect(checkedBody(template, ["play"], [id])).toEqual({
      checklistVersionNo: 4,
      results: [{ key: "play", result: "pass" }],
      evidenceFileIds: [id],
    });
  });
  it("异常仅提交实际编码、必填说明与证据，不捏造正常清单结果", () => {
    expect(abnormalBody("", "异常", [id])).toBeNull();
    expect(abnormalBody("issue", " ", [id])).toBeNull();
    expect(abnormalBody("issue", "x".repeat(201), [id])).toBeNull();
    expect(abnormalBody("issue", " 实际无法播放 ", [id])).toEqual({
      abnormalKindCode: "issue",
      note: "实际无法播放",
      evidenceFileIds: [id],
    });
  });
});
