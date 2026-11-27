import { parseArgs } from "node:util";
import {
  createRuntime,
  loadEnv,
  LegacyRecoveryInputSchema,
  recoverLegacyDailySnapshot,
  resolveLegacyRecoveryFindings,
} from "@liyoxi/services";

export async function runLegacySnapshotRecovery(options: {
  argv?: readonly string[];
  source?: Readonly<Record<string, string | undefined>>;
  version: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}): Promise<number> {
  const out =
    options.out ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const err =
    options.err ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });
  let env,
    input,
    resolveFindings = false;
  try {
    const { values, tokens } = parseArgs({
      args: [...(options.argv ?? process.argv.slice(2))],
      tokens: true,
      options: {
        "event-id": { type: "string" },
        "authorizing-staff-id": { type: "string" },
        operator: { type: "string" },
        reason: { type: "string" },
        "source-sha": { type: "string" },
        "evidence-hash": { type: "string" },
        "payload-hash": { type: "string" },
        apply: { type: "boolean", default: false },
        "resolve-history-findings": { type: "boolean", default: false },
      },
    });
    const names = tokens.filter((t) => t.kind === "option").map((t) => t.name);
    if (new Set(names).size !== names.length) throw new Error("duplicate");
    env = loadEnv(options.source ?? process.env);
    if (env.APP_ENV !== "stg" && env.APP_ENV !== "test" && env.APP_ENV !== "local")
      throw new Error("environment");
    input = LegacyRecoveryInputSchema.parse({
      eventId: values["event-id"],
      authorizedByStaffId: values["authorizing-staff-id"],
      operator: values.operator,
      reason: values.reason,
      sourceSha: values["source-sha"],
      apply: values.apply,
      evidenceHash: values["evidence-hash"],
      payloadHash: values["payload-hash"],
    });
    if (
      env.APP_ENV === "stg" &&
      options.version !== `sha-${input.sourceSha.slice(0, 12)}` &&
      options.version !== input.sourceSha
    )
      throw new Error("version");
    if (input.apply && (!input.evidenceHash || !input.payloadHash)) throw new Error("hashes");
    resolveFindings = values["resolve-history-findings"] ?? false;
    if (resolveFindings && !input.apply) throw new Error("resolution_requires_apply");
  } catch {
    err(
      "恢复参数/环境无效：仅指定旧事件，默认预览；实际追加必须带预览证据和候选指纹、真实授权员工/执行者/原因及匹配构建的完整源码 SHA。生产环境禁用。",
    );
    return 1;
  }
  const runtime = createRuntime({
    entry: "worker",
    env: { ...env, LOG_LEVEL: "error" },
    version: options.version,
  });
  try {
    const result = await runtime.tx.run(async (tx) =>
      resolveFindings
        ? resolveLegacyRecoveryFindings(tx, input, runtime.clock.now())
        : recoverLegacyDailySnapshot(tx, input, runtime.clock.now()),
    );
    out(JSON.stringify(result));
    return 0;
  } catch (error) {
    const code =
      error instanceof Error && /^LEGACY_RECOVERY_[A-Z_]+(?::[a-z_]+)?$/.test(error.message)
        ? error.message
        : "LEGACY_RECOVERY_FAILED";
    err(code);
    return 2;
  } finally {
    await runtime.close();
  }
}
