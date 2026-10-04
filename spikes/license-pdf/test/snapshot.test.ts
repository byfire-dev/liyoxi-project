import { describe, expect, it } from "vitest";

import { canonicalJson, contentFingerprint } from "../src/snapshot.ts";
import { loadSample } from "./helpers.ts";

describe("内容指纹", () => {
  it("规范化 JSON：键排序、无空白、数组保持原序", () => {
    expect(canonicalJson({ b: 1, a: "中", c: [3, { z: null, y: true }] })).toBe(
      '{"a":"中","b":1,"c":[3,{"y":true,"z":null}]}',
    );
  });

  it("键的书写顺序不影响指纹", () => {
    const snapshot = loadSample("short");
    const reordered = Object.fromEntries(Object.entries(snapshot).reverse()) as typeof snapshot;
    expect(contentFingerprint(reordered)).toBe(contentFingerprint(snapshot));
  });

  it("改一个字指纹就变", () => {
    const snapshot = loadSample("short");
    const changed = { ...snapshot, revNo: snapshot.revNo + 1 };
    expect(contentFingerprint(changed)).not.toBe(contentFingerprint(snapshot));
  });

  // 期望值用另一套实现算出：python3 的 json.dumps(sort_keys=True, separators=(",", ":"),
  // ensure_ascii=False) 再取 sha256
  it.each([
    ["short", "1726788383e7708e7e153f1ea20152b7f59cde7e1bacb2cbfaade7ddb21e43ac"],
    ["long", "aec8f94a69bb92490bf79fdf0553468897c181c9a4c945ae3c88c92942889e45"],
    ["extreme", "ec712944cbcae346eb6a8ace8dffb3acd8b416fb9d68fb797362f1b068fe16c1"],
  ] as const)("样张 %s 的指纹与另一套实现算出的一致", (name, expected) => {
    expect(contentFingerprint(loadSample(name))).toBe(expected);
  });
});
