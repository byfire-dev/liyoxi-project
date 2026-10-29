import { runSampleWatermarkCommand } from "./sample-watermark-command.js";
declare const __LYX_VERSION__: string | undefined;
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
runSampleWatermarkCommand({
  signal: controller.signal,
  version: typeof __LYX_VERSION__ === "string" ? __LYX_VERSION__ : "dev",
})
  .then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("样片水印补排失败\n");
      process.exitCode = 2;
    },
  )
  .finally(() => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  });
