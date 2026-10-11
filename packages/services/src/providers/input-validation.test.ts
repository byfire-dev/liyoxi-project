import { describe, expect, it } from "vitest";
import { isAsrQueryTaskId, isAsrSubmitUrl, isLlmDigestInput, isLlmVisionInput } from "./types.js";
import { taskId } from "./asr/parse.js";

const url = "https://example.invalid/audio.m4a?signature=fixture";
const vocabulary = () => ({
  content: [{ code: "food", label: "餐饮" }],
  usage: [{ code: "detail", label: "细节" }],
  timeliness: [{ code: "daily", label: "日常" }],
});
const digest = () => ({ text: "真实的虚构测试正文", vocabulary: vocabulary() });
const vision = () => ({ imageUrls: [url] });
const urlOfLength = (length: number) => {
  const prefix = "https://example.invalid/";
  return prefix + "a".repeat(length - prefix.length);
};

// 对照已固定的真实 user content 封装，验证总字节边界而非仅 URL 长度之和。
function visionBytes(imageUrls: string[]) {
  return Buffer.byteLength(
    JSON.stringify([
      {
        type: "text",
        text: "Describe these images in order using only visible facts. Never identify people or infer identity.",
      },
      ...imageUrls.map((value) => ({ type: "image_url", image_url: { url: value } })),
    ]),
  );
}
function visionAtBytes(bytes: number) {
  const imageUrls = [...Array<string>(7).fill(urlOfLength(8192)), url];
  imageUrls[7] += "a".repeat(bytes - visionBytes(imageUrls));
  return imageUrls;
}

describe("Provider 纯输入公口", () => {
  describe("结构化摘要与实际发送规则一致", () => {
    it.each([
      ["null", null],
      ["缺词表", { text: "正文" }],
      ["空正文", { ...digest(), text: " \n\t" }],
      ["错误正文类型", { ...digest(), text: 123 }],
      ["未知顶层键", { ...digest(), budget: true }],
      ["缺词表维度", { text: "正文", vocabulary: { content: [] } }],
      ["未知词表维度", { text: "正文", vocabulary: { ...vocabulary(), extra: [] } }],
      [
        "空标签",
        { text: "正文", vocabulary: { ...vocabulary(), content: [{ code: "x", label: "" }] } },
      ],
      [
        "非法编码",
        { text: "正文", vocabulary: { ...vocabulary(), content: [{ code: ".", label: "x" }] } },
      ],
      [
        "标签字段越界",
        {
          text: "正文",
          vocabulary: { ...vocabulary(), content: [{ code: "x", label: "x", extra: true }] },
        },
      ],
      [
        "跨维重复编码",
        { text: "正文", vocabulary: { ...vocabulary(), usage: [{ code: "food", label: "用途" }] } },
      ],
      ["伪signal", { ...digest(), signal: {} }],
    ])("拒绝%s", (_name, input) => {
      expect(isLlmDigestInput(input)).toBe(false);
    });

    it("正文和真实三维词表可用，标签保留原Zod的20/21码点边界", () => {
      const input = digest();
      input.vocabulary.content[0]!.label = "😀".repeat(20);
      expect(isLlmDigestInput(input)).toBe(true);
      input.vocabulary.content[0]!.label += "x";
      expect(isLlmDigestInput(input)).toBe(false);
    });

    it("每维256条合法且全局唯一，257条拒绝", () => {
      const input = digest();
      for (const dimension of ["content", "usage", "timeliness"] as const)
        input.vocabulary[dimension] = Array.from({ length: 256 }, (_, index) => ({
          code: `${dimension}_${index}`,
          label: "x",
        }));
      expect(isLlmDigestInput(input)).toBe(true);
      input.vocabulary.content.push({ code: "overflow", label: "x" });
      expect(isLlmDigestInput(input)).toBe(false);
    });

    it("实际evidence和词表JSON恰好65536字节可用，多1字节拒绝", () => {
      const input = digest();
      input.text = "";
      const overhead = Buffer.byteLength(
        JSON.stringify({ evidence: input.text, vocabulary: input.vocabulary }),
      );
      input.text = "a".repeat(65536 - overhead);
      expect(
        Buffer.byteLength(JSON.stringify({ evidence: input.text, vocabulary: input.vocabulary })),
      ).toBe(65536);
      expect(isLlmDigestInput(input)).toBe(true);
      expect(isLlmDigestInput({ ...input, text: input.text + "a" })).toBe(false);
    });

    it("JSON转义后过大也拒绝，不能只检查原正文UTF8", () => {
      const input = { ...digest(), text: "\n".repeat(33000) + "正文" };
      expect(Buffer.byteLength(input.text)).toBeLessThan(65536);
      expect(isLlmDigestInput(input)).toBe(false);
    });
  });

  describe("多图视觉与真实封装一致", () => {
    it.each([
      ["null", null],
      ["空图", { imageUrls: [] }],
      ["15图", { imageUrls: Array<string>(15).fill(url) }],
      ["错误集合", { imageUrls: url }],
      ["非字符串图", { imageUrls: [1] }],
      ["未知键", { ...vision(), sourceHash: "fixture" }],
      ["伪signal", { ...vision(), signal: {} }],
    ])("拒绝%s", (_name, input) => {
      expect(isLlmVisionInput(input)).toBe(false);
    });

    it.each([
      "http://example.invalid/a",
      "https://user:password@example.invalid/a",
      "https://example.invalid/a#",
      "https://example.invalid/a#fragment",
      " https://example.invalid/a",
      "https://example.invalid/a\n",
      "https://example.invalid/a\u007f",
    ])("拒绝原视觉URL非法值%j", (value) => {
      expect(isLlmVisionInput({ imageUrls: [value] })).toBe(false);
    });

    it("1图和14图可用，每URL8192 UTF8边界不改变", () => {
      expect(isLlmVisionInput(vision())).toBe(true);
      expect(isLlmVisionInput({ imageUrls: Array<string>(14).fill(url) })).toBe(true);
      expect(isLlmVisionInput({ imageUrls: [urlOfLength(8192)] })).toBe(true);
      expect(isLlmVisionInput({ imageUrls: [urlOfLength(8193)] })).toBe(false);
      expect(
        isLlmVisionInput({ imageUrls: ["https://example.invalid/" + "中".repeat(3000)] }),
      ).toBe(false);
    });

    it("固定提示与节点计入65536字节，绝不静默丢图", () => {
      const imageUrls = visionAtBytes(65536);
      expect(imageUrls).toHaveLength(8);
      expect(imageUrls.every((value) => Buffer.byteLength(value) <= 8192)).toBe(true);
      expect(visionBytes(imageUrls)).toBe(65536);
      expect(isLlmVisionInput({ imageUrls })).toBe(true);
      expect(isLlmVisionInput({ imageUrls: [...imageUrls.slice(0, 7), imageUrls[7] + "a"] })).toBe(
        false,
      );
    });
  });

  describe("ASR保留原字段判定", () => {
    it.each([
      null,
      123,
      "",
      "http://example.invalid/a",
      "ftp://example.invalid/a",
      "https://user@example.invalid/a",
      "https://user:password@example.invalid/a",
      "https://example.invalid/a#fragment",
      urlOfLength(8193),
    ])("提交URL拒绝%j", (value) => {
      expect(isAsrSubmitUrl(value)).toBe(false);
    });

    it.each([
      url,
      urlOfLength(8192),
      " \nhttps://example.invalid/a\t",
      "https://example.invalid/a#",
    ])("提交URL保留原合法值%j", (value) => {
      expect(isAsrSubmitUrl(value)).toBe(true);
    });

    it("ASR原JS长度与视觉UTF8长度是不同既有规则", () => {
      const value = "https://example.invalid/" + "中".repeat(3000);
      expect(value.length).toBeLessThan(8192);
      expect(Buffer.byteLength(value)).toBeGreaterThan(8192);
      expect(isAsrSubmitUrl(value)).toBe(true);
      expect(isLlmVisionInput({ imageUrls: [value] })).toBe(false);
    });

    it.each(["0", "1", "9007199254740993", "18446744073709551615"])(
      "查询保持原uint64字符串%j",
      (value) => {
        expect(isAsrQueryTaskId(value)).toBe(true);
      },
    );

    it.each([
      null,
      0,
      123,
      18446744073709551615n,
      "",
      "01",
      "+1",
      "-1",
      "1e3",
      " 1",
      "1 ",
      "18446744073709551616",
    ])("查询拒绝%s", (value) => {
      expect(isAsrQueryTaskId(value)).toBe(false);
    });

    it.each(["1\n", "1\r", "1\r\n", "1\u2028", "1\u2029"])(
      "末尾行终止符%j严格等价原解析，不新增空白规范",
      (value) => {
        expect(isAsrQueryTaskId(value)).toBe(taskId(value) !== undefined);
      },
    );

    it("响应可接受安全整数，查询公口不能接受number", () => {
      expect(taskId(Number.MAX_SAFE_INTEGER)).toBe(String(Number.MAX_SAFE_INTEGER));
      expect(isAsrQueryTaskId(Number.MAX_SAFE_INTEGER)).toBe(false);
      expect(taskId(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
    });
  });

  it("校验不修改调用者快照，已取消的真实signal仍只按数据类型判定", () => {
    const controller = new AbortController();
    controller.abort();
    const input = digest();
    for (const entries of Object.values(input.vocabulary)) {
      for (const item of entries) Object.freeze(item);
      Object.freeze(entries);
    }
    Object.freeze(input.vocabulary);
    const textInput = Object.freeze({ ...input, signal: controller.signal });
    const imageUrls = Object.freeze([url]);
    const imageInput = Object.freeze({ imageUrls, signal: controller.signal });
    const before = JSON.stringify({ input, imageUrls });
    expect(isLlmDigestInput(textInput)).toBe(true);
    expect(isLlmVisionInput(imageInput)).toBe(true);
    expect(JSON.stringify({ input, imageUrls })).toBe(before);
    expect(textInput.signal).toBe(controller.signal);
    expect(imageInput.signal.aborted).toBe(true);
  });
});
