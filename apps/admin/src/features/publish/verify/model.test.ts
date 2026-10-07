import { describe, expect, it } from "vitest";
import { approveBody, rejectBody, submittedLinks, verifySearch } from "./model";
import type { Template } from "./api";
const template = {
  versionNo: 8,
  items: [{ key: "link", label: "链接", required: true, allowNa: false, merchantVisible: false }],
} as Template;
const detail = {
  roundNo: 2,
  approval: { lockVersion: 4, confirmChecks: ["current_round"] },
  link: { reportedEpisodeCount: 3 },
};
describe("链接核验的真实请求边界", () => {
  it("清单、服务端确认项与集数边界全部满足，才提交当前round/version", () => {
    for (const count of [null, 0, 4, 1.5])
      expect(approveBody(detail, count, template, ["link", "confirm:current_round"])).toBeNull();
    expect(approveBody(detail, 2, template, ["link"])).toBeNull();
    expect(approveBody(detail, 2, template, ["link", "confirm:current_round"])).toEqual({
      lockVersion: 4,
      confirm: { roundNo: 2, reportedEpisodeCount: 3 },
      confirmChecks: ["current_round"],
      verifiedEpisodeCount: 2,
      checklistVersionNo: 8,
      results: [{ key: "link", result: "pass" }],
    });
  });
  it("退回原因及说明必须填写，严格使用已合契约两字段", () => {
    expect(rejectBody("", "说明")).toBeNull();
    expect(rejectBody("invalid", " ")).toBeNull();
    expect(rejectBody("invalid", "x".repeat(201))).toBeNull();
    expect(rejectBody("invalid", "  请补齐  ")).toEqual({
      reasonCodes: ["invalid"],
      note: "请补齐",
    });
  });
  it("只开放HTTPS提交链接，查询只保留本域参数", () => {
    for (const url of ["javascript:alert(1)", "http://example.test", "bad"])
      expect(
        submittedLinks({ link: { linkKind: "collection", collectionUrl: url, episodeUrls: [] } })[0]
          ?.safe,
      ).toBe(false);
    expect(
      submittedLinks({
        link: {
          linkKind: "episodes",
          collectionUrl: null,
          episodeUrls: [{ episodeNo: 2, url: "https://example.test/2" }],
        },
      })[0]?.safe,
    ).toBe(true);
    expect(verifySearch({ tab: "delivering", q: "x".repeat(45), page: 4 })).toEqual({
      tab: "todo",
      q: "x".repeat(30),
      id: undefined,
    });
  });
});
