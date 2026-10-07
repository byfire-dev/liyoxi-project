import { describe, expect, it } from "vitest";
import {
  createWriteIntent,
  episodeProblem,
  firstEpisode,
  historyTicketId,
  qualityProblem,
} from "./model";
import type { Template } from "./api";
describe("交付详情输入与意图", () => {
  it("只接受匹配单号的导航 id", () => {
    const ticketId = "01950000-0000-7000-8000-000000000001";
    expect(historyTicketId({ lyxTicket: { ticketNo: "LYT1", ticketId } }, "LYT1")).toBe(ticketId);
    expect(historyTicketId({ lyxTicket: { ticketNo: "LYT2", ticketId } }, "LYT1")).toBeUndefined();
    expect(
      historyTicketId({ lyxTicket: { ticketNo: "LYT1", ticketId: "LYT1" } }, "LYT1"),
    ).toBeUndefined();
  });
  it("集号按第一个数字预填，重复、越界和未上传均不登记", () => {
    expect(firstEpisode("剧第002集-1.mp4")).toBe(2);
    expect(firstEpisode("成片.mp4")).toBeUndefined();
    expect(episodeProblem([{ episodeNo: 1, fileId: null }], 2)).toContain("上传");
    expect(episodeProblem([{ episodeNo: 3, fileId: "a" }], 2)).toContain("整数");
    expect(episodeProblem([{ episodeNo: 1.5, fileId: "a" }], 2)).toContain("整数");
    expect(
      episodeProblem(
        [
          { episodeNo: 1, fileId: "a" },
          { episodeNo: 1, fileId: "b" },
        ],
        2,
      ),
    ).toContain("重复");
    expect(
      episodeProblem(
        [
          { episodeNo: 1, fileId: "a" },
          { episodeNo: 2, fileId: "b" },
        ],
        2,
      ),
    ).toBeNull();
  });
  const template = {
    items: [
      { key: "picture", label: "画面", allowNa: false },
      { key: "audio", label: "声音", allowNa: true },
    ],
  } as Template;
  it("QC 要全清单，失败项说明和总原因，不适用遵守模板", () => {
    expect(qualityProblem(template, [{ key: "picture", result: "pass" }], "")).toContain("逐项");
    expect(
      qualityProblem(
        template,
        [
          { key: "picture", result: "na" },
          { key: "audio", result: "pass" },
        ],
        "",
      ),
    ).toContain("不允许");
    expect(
      qualityProblem(
        template,
        [
          { key: "picture", result: "fail" },
          { key: "audio", result: "na" },
        ],
        "原因",
      ),
    ).toContain("说明");
    expect(
      qualityProblem(
        template,
        [
          { key: "picture", result: "fail", note: "画面失焦" },
          { key: "audio", result: "na" },
        ],
        " ",
      ),
    ).toContain("原因");
    expect(
      qualityProblem(
        template,
        [
          { key: "picture", result: "fail", note: "画面失焦" },
          { key: "audio", result: "na" },
        ],
        "需重做",
      ),
    ).toBeNull();
  });
  it("同步双点只发一次，失败重试保持键，内容修改换键", async () => {
    let count = 0,
      release!: () => void;
    const intent = createWriteIntent(() => `write-${++count}`),
      keys: string[] = [];
    const first = intent({ version: 1 }, async (key) => {
      keys.push(key);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error("timeout");
    });
    expect(await intent({ version: 1 }, async () => "duplicate")).toBeNull();
    release();
    await expect(first).rejects.toThrow("timeout");
    await intent({ version: 1 }, async (key) => {
      keys.push(key);
      return {};
    });
    await intent({ version: 2 }, async (key) => {
      keys.push(key);
      return {};
    });
    expect(keys).toEqual(["write-1", "write-1", "write-2"]);
  });
});
