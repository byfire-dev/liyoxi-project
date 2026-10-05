// 四种故障注入工具（W0-05b；计划 第 5.4 节“故障注入”行）：重复投递、进程中断、Redis 不可用、外部调用前中后中断。
// 只交工具与工具自测；拿它们去压内核是 W0-13、W0-20、W0-23、W0-30 的事。

export * from "./call.js";
export * from "./crash.js";
export * from "./delivery.js";
export * from "./redis-outage.js";
