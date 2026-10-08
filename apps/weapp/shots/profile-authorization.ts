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
    failNextRedirect() {
      const redirect = Taro.redirectTo;
      Taro.redirectTo = () => {
        Taro.redirectTo = redirect;
        return Promise.reject(new Error("离线演练：跳转失败"));
      };
    },
    async settle() {
      if (!resolve) throw new Error("演练授权未发起");
      enabled = false;
      resolve({});
      resolve = null;
      await new Promise((done) => setTimeout(done, 0));
    },
    leave: () => Taro.redirectTo({ url: "/sub/profile/review/index" }),
    hide: () => Taro.navigateTo({ url: "/sub/profile/review/index" }),
    back: () => Taro.navigateBack(),
    refresh() {
      // H5 样张没有原生下拉动画；直接触发页面登记的同一个刷新生命周期。
      const page = Taro.getCurrentPages().at(-1);
      if (!page?.onPullDownRefresh) throw new Error("演练页面未登记下拉刷新");
      if (typeof Taro.stopPullDownRefresh !== "function")
        Taro.stopPullDownRefresh = () => Promise.resolve({ errMsg: "stopPullDownRefresh:ok" });
      page.onPullDownRefresh();
    },
    enter: (page: "profile" | "basic" | "store" | "service" | "cert" = "cert") =>
      Taro.redirectTo({ url: `/sub/profile/${page}/index` }),
  };
}
