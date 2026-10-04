// @liyoxi/services/testing：测试支撑设施的出口（D7 第 10.1 节）。只给测试用，不进生产装配。
// 各包只往这里加自己的导出行：W0-19 的 Provider 替身在 ./providers；测试库支架、可拨时钟、故障注入属 W0-05b。

export * from "./providers/index.js";
