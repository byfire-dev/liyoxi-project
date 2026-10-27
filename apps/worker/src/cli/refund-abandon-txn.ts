import { refundAbandonTxnCommand } from "./refund-abandon-txn-command.js";
declare const __LYX_VERSION__: string | undefined;
const controller = new AbortController();
const interrupt = () => {
  controller.abort();
  process.stdin.destroy();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
refundAbandonTxnCommand
  .run({
    signal: controller.signal,
    version: typeof __LYX_VERSION__ === "string" ? __LYX_VERSION__ : "dev",
  })
  .then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("退款放弃失败\n");
      process.exitCode = 2;
    },
  )
  .finally(() => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  });
