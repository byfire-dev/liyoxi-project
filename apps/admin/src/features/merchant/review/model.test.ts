import { describe, expect, it, vi } from "vitest";
import {
  createDecisionIntent,
  decisionResult,
  reviewSearch,
  reviewListQuery,
  approveBody,
  rejectBody,
} from "./model";

const detail = { roundNo: 2, approval: { lockVersion: 7 } };
describe("资质审核意图与当前服务端事实", () => {
  it("APPROVAL_NOT_PENDING 按冲突刷新下一条，其他业务拒绝留在当前条", () => {
    for (const error of ["APPROVAL_NOT_PENDING", "VERSION_CONFLICT", "STATE_NOT_ALLOWED"])
      expect(decisionResult({ error, message: "已处理" })).toEqual({ outcome: "conflict" });
    expect(decisionResult({ error: "CONFIRM_MISMATCH", message: "轮次已变更" })).toEqual({
      outcome: "failed",
      message: "轮次已变更",
    });
  });
  it("URL 只保留自身页签，搜索按接口30字；未知页签回待审", () => {
    expect(reviewSearch({ tab: "done_today", id: "one", q: "门店" })).toEqual({
      tab: "done_today",
      id: "one",
      q: "门店",
    });
    expect(reviewSearch({ tab: "all", q: "a".repeat(50) })).toMatchObject({
      tab: "todo",
      q: "a".repeat(30),
    });
  });
  it("真实审批列表保留100条页容量，id只在UI而非API查询里", () => {
    expect(reviewListQuery({ id: "UI-only", tab: "done_today", q: "门店" }, 2)).toEqual({
      kind: "qualification",
      tab: "done_today",
      q: "门店",
      page: 2,
      pageSize: 100,
      sort: "due",
    });
  });
  it("通过用审批版本与轮次，驳回必须原因和说明，保持M1非终局", () => {
    expect(approveBody(detail, ["name"])).toEqual({
      lockVersion: 7,
      mode: "normal",
      confirm: { roundNo: 2 },
      confirmChecks: ["name"],
    });
    expect(rejectBody(detail, "", "原因", [])).toBeNull();
    expect(rejectBody(detail, "R01", " ", [])).toBeNull();
    expect(rejectBody(detail, "R01", "补正原图", ["doc"])).toEqual({
      reasonCodes: ["R01"],
      note: "补正原图",
      rejectedDocIds: ["doc"],
      isFinal: false,
      confirm: { roundNo: 2 },
    });
  });
  it("同步双击只发一个请求、失败重试沿键、内容改变换键", async () => {
    let finish!: (value: string) => void;
    const keys: string[] = [],
      newKey = vi.fn().mockReturnValueOnce("one").mockReturnValueOnce("two");
    const intent = createDecisionIntent(newKey);
    const first = intent({ note: "a" }, (key) => {
      keys.push(key);
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    expect(await intent({ note: "a" }, async () => "duplicate")).toBeNull();
    finish("failed");
    await first;
    await intent({ note: "a" }, async (key) => {
      keys.push(key);
      return "retry";
    });
    await intent({ note: "b" }, async (key) => {
      keys.push(key);
      return "changed";
    });
    expect(keys).toEqual(["one", "one", "two"]);
  });
});
