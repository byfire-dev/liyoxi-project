import { expect, it } from "vitest";
import { PARAM_DEFS, paramDef, validateParamValue } from "./index.js";

it.each(["notify.wx.ask_cooldown_days", "notify.wx.max_per_ask"])(
  "%s 只有一条定义，避免合流后后项覆盖前项的范围",
  (key) => {
    expect(PARAM_DEFS.filter((definition) => definition.key === key)).toHaveLength(1);
  },
);

it("拒绝冷却至少七天，单次请求不超过平台五模板上限", () => {
  const cooldown = paramDef("notify.wx.ask_cooldown_days");
  const maxPerAsk = paramDef("notify.wx.max_per_ask");
  if (!cooldown || !maxPerAsk) throw new Error("缺少通知授权参数");
  expect(cooldown).toMatchObject({ default: 7, min: 7, max: 30 });
  expect(maxPerAsk).toMatchObject({ default: 3, min: 1, max: 5 });
  for (const n of [7, 14, 30]) expect(validateParamValue(cooldown, n)).toBeNull();
  for (const n of [0, 6, 31, 365, 7.5, "7"]) {
    expect(validateParamValue(cooldown, n)).not.toBeNull();
  }
  for (const n of [1, 3, 5]) expect(validateParamValue(maxPerAsk, n)).toBeNull();
  for (const n of [0, 6, 3.5, "3"]) expect(validateParamValue(maxPerAsk, n)).not.toBeNull();
});
