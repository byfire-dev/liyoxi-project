#!/usr/bin/env node
// 所有真实页面共用完整入口；缺省现场准备合法媒体，不能漏跑制作或批次用例。
import { runLiveOutputBatch } from "./live-output-batch.mjs";

runLiveOutputBatch().catch((error) => {
  console.error(`真实后台验收失败：${error.message}`);
  process.exitCode = 1;
});
