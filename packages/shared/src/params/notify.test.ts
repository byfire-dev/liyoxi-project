import { expect, it } from "vitest";
import { paramDef, validateParamValue } from "./index.js";

it("拒绝冷却至少七天，单次请求不超过平台五模板上限", () => {
  const cooldown = paramDef("notify.wx.ask_cooldown_days");
  const maxPerAsk = paramDef("notify.wx.max_per_ask");
  if (!cooldown || !maxPerAsk) throw new Error("缺少通知授权参数");
  expect(cooldown.default).toBe(7);
  expect(maxPerAsk.default).toBe(3);
  for (const n of [7, 14, 30]) expect(validateParamValue(cooldown, n)).toBeNull();
  for (const n of [0, 6, 31, 7.5, "7"]) expect(validateParamValue(cooldown, n)).not.toBeNull();
  for (const n of [1, 3, 5]) expect(validateParamValue(maxPerAsk, n)).toBeNull();
  for (const n of [0, 6, 3.5, "3"]) expect(validateParamValue(maxPerAsk, n)).not.toBeNull();
});
