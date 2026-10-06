import Taro from "@tarojs/taro";
import { createSubscribe } from "../src/lib/subscribe";

/** 明确 profile H5 样张：原生授权依赖可控，冻结的订阅封装与页面生命周期照常执行。 */
export function profileAuthorizationProbe() {
  let enabled = false;
  let resolve: ((value: Record<string, unknown>) => void) | null = null;
  let count = 0;
  const subscribe = createSubscribe({
    requestSubscribe: () => {
      count++;
      return new Promise((done) => {
        resolve = done;
      });
    },
    getPlan: () => ({
      enabled,
      plan: [
        {
          point: "profile_submit",
          slots: [{ slotKey: "lyxtest-profile", tmplId: "lyxtest-profile" }],
        },
      ],
      maxPerAsk: 1,
      cooldownDays: 7,
    }),
    storage: { get: () => null, set: () => {}, remove: () => {} },
    clock: {
      now: () => Date.now(),
      sleep: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
    },
    uuid: () => "lyxtest-subscribe",
  });
  return {
    withSubscribe: subscribe.withSubscribe,
    defer() {
      if (enabled) throw new Error("前一次演练授权尚未结束");
      count = 0;
      enabled = true;
    },
    asks: () => count,
    async settle() {
      if (!resolve) throw new Error("演练授权未发起");
      enabled = false;
      resolve({});
      resolve = null;
      await new Promise((done) => setTimeout(done, 0));
    },
    leave: () => Taro.redirectTo({ url: "/sub/profile/review/index" }),
    enter: () => Taro.redirectTo({ url: "/sub/profile/cert/index" }),
  };
}
