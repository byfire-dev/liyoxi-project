import { probeTrialApi, trialConfigErrors } from "./trial-config.mjs";

const errors = trialConfigErrors(process.env);
if (errors.length) {
  errors.forEach((message) => console.error(message));
  process.exitCode = 2;
} else {
  console.log("体验版构建参数检查通过（不代表微信后台配置或真机验收通过）");
  if (process.argv.includes("--probe")) {
    for (const result of await probeTrialApi(
      process.env.WEAPP_API_BASE_URL,
      fetch,
      process.env.WEAPP_VERSION || "0.1.0",
    )) {
      console.log(`${result.name}：${result.ok ? "通过" : "未通过，请检查部署、网络与数据"}`);
      if (!result.ok) process.exitCode = 1;
    }
  }
}
