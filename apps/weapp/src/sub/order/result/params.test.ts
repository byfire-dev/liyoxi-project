import { expect, it } from "vitest";
import { paymentIdFromScene } from "./params";
it("支付入口scene仅接受32位小写UUIDv7；拒绝路径/URL/编码/其它UUID版本和变体", () => {
  expect(paymentIdFromScene("0199aabbccdd7eef8a01112233445566")).toBe(
    "0199aabb-ccdd-7eef-8a01-112233445566",
  );
  for (const invalid of [
    undefined,
    null,
    1,
    "",
    "0199aabb-ccdd-7eef-8a01-112233445566",
    "0199AABBCCDD7EEF8A01112233445566",
    "0199aabbccdd4eef8a01112233445566",
    "0199aabbccdd7eefca01112233445566",
    "0199aabbccdd7eef8a0111223344556",
    "0199aabbccdd7eef8a011122334455660",
    "https://example.invalid",
    "../result/index",
    "%300199aabbccdd7eef8a01112233445566",
    "0199aabbccdd7eef8a01112233445566\n",
  ])
    expect(paymentIdFromScene(invalid)).toBeNull();
});
