import { describe, expect, it } from "vitest";
import { PublishFailure, type Template } from "../patrol/api";
import { batchBody, batchRejections, checkBody, offlineScope, offlineSearch } from "./model";
import type { CheckBody } from "./api";
const template = {
  code: "takedown.absence_check",
  versionNo: 2,
  items: [
    { key: "absent", label: "未发现作品", required: true, allowNa: false, merchantVisible: false },
  ],
} as Template;
const body: CheckBody = {
  checklistCode: "takedown.absence_check",
  checklistVersionNo: 2,
  results: [{ key: "absent", result: "pass" }],
  evidenceFileIds: ["file-a", "file-b"],
};
describe("下架正式核查边界", () => {
  it("summary 保留列表全部范围且不带tab/id，未知依据不透传", () => {
    const search = offlineSearch({
      tab: "checked",
      q: "作品",
      basis: "live",
      isOverdue: "true",
      dueFrom: "2026-11-01",
      dueTo: "2026-11-05",
    });
    expect(offlineScope(search)).toMatchObject({
      q: "作品",
      basis: "live",
      isOverdue: "true",
      dueFrom: "2026-11-01",
      dueTo: "2026-11-05",
    });
    expect(offlineScope(search)).not.toHaveProperty("tab");
    expect(offlineScope(search)).not.toHaveProperty("id");
    expect(offlineSearch({ basis: "verified_live", tab: "unknown" })).toMatchObject({
      basis: undefined,
      tab: "pending",
    });
  });
  it("按 expectedChecklistCode 和当前 actions 核查，缺任一清单或第二张证据不能提交", () => {
    const detail = { expectedChecklistCode: "takedown.absence_check" as const, actions: ["check"] };
    expect(checkBody(detail, template, ["absent"], ["file-a", "file-b"])).toEqual(body);
    expect(checkBody(detail, template, ["absent"], ["file-a"])).toBeNull();
    expect(checkBody(detail, template, [], ["file-a", "file-b"])).toBeNull();
    expect(
      checkBody({ ...detail, actions: [] }, template, ["absent"], ["file-a", "file-b"]),
    ).toBeNull();
    expect(
      checkBody(
        { ...detail, expectedChecklistCode: "takedown.check" },
        template,
        ["absent"],
        ["file-a", "file-b"],
      ),
    ).toBeNull();
  });
  it("原子批次1–50项，每项有独立证据；不把409错误项当成功清单", () => {
    expect(batchBody([], {})).toBeNull();
    expect(batchBody(["a", "a"], { a: body })).toBeNull();
    expect(batchBody(["a", "b"], { a: body, b: null })).toBeNull();
    expect(
      batchBody(
        Array.from({ length: 51 }, (_, i) => String(i)),
        {},
      ),
    ).toBeNull();
    const second = { ...body, evidenceFileIds: ["file-c", "file-d"] };
    expect(batchBody(["b", "a"], { a: body, b: second })?.items).toEqual([
      { takedownTaskId: "b", ...second },
      { takedownTaskId: "a", ...body },
    ]);
    expect(
      batchRejections(
        new PublishFailure("整批拒绝", "TAKEDOWN_BATCH_REJECTED", {
          items: [
            { index: 1, takedownTaskId: "b", error: "STATE_NOT_ALLOWED", message: "任务已变化" },
            { index: "bad" },
          ],
        }),
      ),
    ).toEqual([
      { index: 1, takedownTaskId: "b", error: "STATE_NOT_ALLOWED", message: "任务已变化" },
    ]);
    expect(batchRejections(new PublishFailure("无权限", "PERMISSION_DENIED"))).toEqual([]);
  });
});
