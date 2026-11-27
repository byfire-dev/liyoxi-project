import { runLegacySnapshotRecovery } from "./legacy-snapshot-recovery-command.js";
declare const __LYX_VERSION__: string | undefined;
runLegacySnapshotRecovery({
  version: typeof __LYX_VERSION__ === "string" ? __LYX_VERSION__ : "dev",
}).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stderr.write("LEGACY_RECOVERY_FAILED\n");
    process.exitCode = 2;
  },
);
