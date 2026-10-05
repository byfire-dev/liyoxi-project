// Vitest 的 globalSetup（W0-05b）：每轮测试开始时建本会话的模板库。实现在 @liyoxi/db/testing/global-setup。
// 挂法：包的 vitest.config.ts 里写 globalSetup: ["@liyoxi/services/testing/global-setup"]；
// 本包自己写相对路径。应用层（api、worker）不直接引数据包，经这里拿。
export { default } from "@liyoxi/db/testing/global-setup";
