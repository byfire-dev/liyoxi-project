// 镜像内受限入口：真实对象仍须单独运维授权，staff 由服务在本次事务读取。
import { alertsAckCommand } from "./alerts-ack-command.js";

declare const __LYX_VERSION__: string | undefined;

const controller = new AbortController();
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

alertsAckCommand
  .run({
    signal: controller.signal,
    version: typeof __LYX_VERSION__ === "string" ? __LYX_VERSION__ : "dev",
  })
  .then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("流程运维失败\n");
      process.exitCode = 2;
    },
  )
  .finally(() => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  });
