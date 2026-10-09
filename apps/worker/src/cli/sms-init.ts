import { runSmsInitCommand } from "./sms-init-command.js";
declare const __LYX_VERSION__: string;
process.exitCode = await runSmsInitCommand({
  version: typeof __LYX_VERSION__ === "undefined" ? "dev" : __LYX_VERSION__,
});
