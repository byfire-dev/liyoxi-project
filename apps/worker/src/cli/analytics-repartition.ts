import { analyticsRepartitionCommand } from "./analytics-repartition-command.js";
declare const __LYX_VERSION__: string | undefined;
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
analyticsRepartitionCommand
  .run({
    signal: controller.signal,
    version: typeof __LYX_VERSION__ === "string" ? __LYX_VERSION__ : "dev",
  })
  .then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("埋点分区修复失败\n");
      process.exitCode = 2;
    },
  )
  .finally(() => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  });
