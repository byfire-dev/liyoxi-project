// 小程序规则片段（D7 第 2.2 节 D9：小程序禁 window / document / localStorage / fetch）。

/** 小程序源码所在的路径 */
export const weappFiles = ["apps/weapp/src/**/*.{ts,tsx}"];

/** 小程序运行时自带的全局对象 */
export const weappGlobals = {
  wx: "readonly",
  getApp: "readonly",
  getCurrentPages: "readonly",
};

export const weappRules = {
  "no-restricted-globals": [
    "error",
    { name: "window", message: "小程序内禁用 window，请用 Taro API。" },
    { name: "document", message: "小程序内禁用 document，请用 Taro API。" },
    { name: "localStorage", message: "小程序内禁用 localStorage，请用 Taro.setStorageSync。" },
    { name: "fetch", message: "小程序内禁用 fetch，请用请求层。" },
  ],
};
