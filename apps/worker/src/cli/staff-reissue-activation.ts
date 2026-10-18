import { staffReissueActivationCommand } from "./staff-reissue-activation-command.js";
declare const __LYX_VERSION__: string | undefined;
staffReissueActivationCommand
  .run({ version: typeof __LYX_VERSION__ === "string" ? __LYX_VERSION__ : "dev" })
  .then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("补发失败\n");
      process.exitCode = 2;
    },
  );
