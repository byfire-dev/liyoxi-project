import { expect, it } from "vitest";
import { renderSms, renderWechat } from "./render.js";
import type { NotifyFact } from "./context.js";
const fact: NotifyFact = {
  bizType: "billing_order",
  bizId: "00000000-0000-4000-8000-000000000001",
  entityId: null,
  storeId: null,
  status: "paid",
  version: 0,
  name: "FK202610090001",
  amountFen: 1050,
  occurredAt: "2026-10-08T16:00:00.000Z",
};
it("付款字段取真实fen与上海时刻，不以可编辑label选择数据", () => {
  expect(
    renderWechat(
      "pay_result",
      [
        { name: "amount2", type: "amount", label: "任意标签" },
        { name: "time4", type: "time", label: "付款时间" },
      ],
      fact,
    ),
  ).toEqual({ amount2: "10.50", time4: "2026-10-09 00:00" });
  expect(
    renderWechat("pay_result", [{ name: "amount2", type: "amount" }], {
      ...fact,
      amountFen: undefined,
    }),
  ).toBeNull();
});
it("未知字段/类型错配/重复字段不会产生模板占位值", () => {
  expect(
    renderWechat("pay_result", [{ name: "thing999", type: "thing", label: "手机号" }], fact),
  ).toBeNull();
  expect(renderWechat("pay_result", [{ name: "amount2", type: "thing" }], fact)).toBeNull();
  expect(
    renderWechat(
      "pay_result",
      [
        { name: "amount2", type: "amount" },
        { name: "amount2", type: "amount" },
      ],
      fact,
    ),
  ).toBeNull();
  expect(renderWechat("future_unknown", [{ name: "thing1", type: "thing" }], fact)).toBeNull();
});
it("thing按Unicode码点截断，积分0是真值，欠缺实际数量不假造", () => {
  expect(
    renderWechat("order_result", [{ name: "thing1", type: "thing" }], {
      ...fact,
      name: "虚构😀".repeat(20),
    })?.thing1,
  ).toBe([..."虚构😀".repeat(20)].slice(0, 20).join(""));
  expect(
    renderWechat(
      "quota_change",
      [
        { name: "number2", type: "number" },
        { name: "number3", type: "number" },
      ],
      { ...fact, quantity: 0, balance: 0 },
    ),
  ).toEqual({ number2: "0", number3: "0" });
  expect(renderWechat("quota_change", [{ name: "number2", type: "number" }], fact)).toBeNull();
});
it("短信只接固定变量且真实执行maxLen，未知敏感变量受控拒绝", () => {
  expect(renderSms("sample_pending", [{ name: "item", maxLen: 1 }], fact, "待确认")).toEqual({
    item: "样",
  });
  expect(renderSms("generic_todo", [{ name: "phone", maxLen: 11 }], fact, "待确认")).toBeNull();
  expect(renderSms("generic_todo", [{ name: "item", maxLen: 0 }], fact, "待确认")).toBeNull();
  expect(renderSms("account_notice", [], fact, "账号安全通知")).toEqual({});
});
