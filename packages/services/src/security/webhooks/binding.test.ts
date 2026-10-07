import { it, expect } from "vitest";
import { bindWebhooks, boundWebhooks } from "./binding.js";
import type { Webhooks } from "./types.js";
it("解绑按作用域身份：乱序/重复清理不拆新实例，重复同对象也保持栈", () => {
  const a = {} as Webhooks,
    b = {} as Webhooks;
  expect(() => boundWebhooks()).toThrow("未绑定");
  const aa = bindWebhooks(a),
    ab = bindWebhooks(a),
    bb = bindWebhooks(b);
  expect(boundWebhooks()).toBe(b);
  aa();
  aa();
  expect(boundWebhooks()).toBe(b);
  bb();
  expect(boundWebhooks()).toBe(a);
  ab();
  ab();
  expect(() => boundWebhooks()).toThrow("未绑定");
});
