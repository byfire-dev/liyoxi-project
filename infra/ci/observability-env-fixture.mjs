// 仅供仓库层测试经既有 tsx 执行：显式自造 source，不读取 process.env 或实际 .env/凭据。
// 静态依赖保留正式解析器入口；infra tsc 不递归编译跨 rootDir 的工作区源码。
import { readFileSync } from "node:fs";
import { EnvError, loadEnv } from "../../packages/services/src/kernel/index.ts";

const sources = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(sources) || sources.length > 16) throw new Error("FIXTURE_INVALID");
const results = sources.map((source) => {
  try {
    const env = loadEnv(source);
    return {
      ok: true,
      clientErrors: env.CLIENT_ERROR_PROJECTS !== undefined,
      alerts: env.ALERTS !== undefined,
    };
  } catch (error) {
    // 不输出配置值、错误message、路径、SQL或stack；未知失败也不能伪装格式通过。
    return {
      ok: false,
      keys: error instanceof EnvError ? error.issues.map((issue) => issue.key) : ["INTERNAL"],
    };
  }
});
process.stdout.write(`${JSON.stringify(results)}\n`);
