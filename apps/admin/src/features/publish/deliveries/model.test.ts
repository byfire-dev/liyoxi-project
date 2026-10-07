import { describe, expect, it } from "vitest";
import { createIntent, deliverySearch, pushBody } from "./model";
import type { Template } from "./api";
const template = {
  versionNo: 7,
  items: [
    { key: "complete", label: "完整", required: true, allowNa: false, merchantVisible: false },
  ],
} as Template;
describe("成片交付的提交边界", () => {
  it("只有完整清单且异常账号单独确认才能交付，保留服务端版本", () => {
    expect(pushBody(undefined, ["complete"])).toBeNull();
    expect(pushBody(template, [])).toBeNull();
    expect(pushBody(template, ["complete"], true)).toBeNull();
    expect(pushBody(template, ["complete", "ack:abnormal"], true)).toEqual({
      ackAbnormalAccount: true,
      precheck: { checklistVersionNo: 7, results: [{ key: "complete", result: "pass" }] },
    });
  });
  it("同一网络重试保留键，详情版本和输入变化换键，并阻止并发重复提交", async () => {
    let n = 0;
    const keys: string[] = [],
      intent = createIntent(() => `key${++n}`);
    const send = async (key: string) => {
      keys.push(key);
      throw new Error("network");
    };
    await expect(intent({ id: "a", version: 1 }, send)).rejects.toThrow("network");
    await expect(intent({ id: "a", version: 1 }, send)).rejects.toThrow("network");
    await expect(intent({ id: "a", version: 2 }, send)).rejects.toThrow("network");
    expect(keys).toEqual(["key1", "key1", "key2"]);
    let release!: (value: number) => void;
    const first = intent(
      { id: "b" },
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    expect(await intent({ id: "b" }, async () => 2)).toBeNull();
    release(1);
    expect(await first).toBe(1);
    await intent({ id: "b", checked: true }, async (key) => {
      keys.push(key);
      return 3;
    });
    expect(keys.at(-1)).toBe("key4");
  });
  it("队列查询不接纳跨域页签与分页，并限制搜索长度", () => {
    expect(deliverySearch({ tab: "todo", q: "x".repeat(70), page: 9 })).toEqual({
      tab: "delivering",
      q: "x".repeat(40),
      id: undefined,
    });
  });
});
