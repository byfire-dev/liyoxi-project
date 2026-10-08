import { parseArgs } from "node:util";
import { createRuntime, isAppError, isUuid, loadEnv } from "@liyoxi/services";
import type { AppEnv } from "@liyoxi/services";

export interface AnalyticsRepartitionOptions {
  readonly argv?: readonly string[];
  readonly source?: Readonly<Record<string, string | undefined>>;
  readonly version?: string;
  readonly signal?: AbortSignal;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}
const USAGE =
  "用法：analytics-repartition <YYYY-MM> --env <local|test|stg|prod> --staff <员工UUID> --note <5–200字原因>";
function input(argv: readonly string[]) {
  const { values, positionals, tokens } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    tokens: true,
    options: { env: { type: "string" }, staff: { type: "string" }, note: { type: "string" } },
  });
  const seen = new Set<string>();
  for (const token of tokens)
    if (token.kind === "option") {
      if (seen.has(token.name)) throw new Error("DUPLICATE_OPTION");
      seen.add(token.name);
    }
  const month = positionals[0],
    appEnv = values.env,
    staffId = values.staff,
    note = values.note?.trim();
  if (
    positionals.length !== 1 ||
    !month ||
    !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
    !appEnv ||
    !["local", "test", "stg", "prod"].includes(appEnv) ||
    !staffId ||
    !isUuid(staffId) ||
    !note ||
    Array.from(note).length < 5 ||
    Array.from(note).length > 200
  )
    throw new Error("INVALID_INPUT");
  return { month, appEnv: appEnv as AppEnv, staffId, note };
}
export const analyticsRepartitionCommand = {
  name: "analytics_repartition",
  run: runAnalyticsRepartitionCommand,
} as const;
export async function runAnalyticsRepartitionCommand(
  options: AnalyticsRepartitionOptions = {},
): Promise<number> {
  const out = options.out ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const err = options.err ?? ((line: string) => void process.stderr.write(`${line}\n`));
  let parsed;
  try {
    parsed = input(options.argv ?? process.argv.slice(2));
  } catch {
    err(USAGE);
    return 1;
  }
  if (options.signal?.aborted) {
    err("埋点分区修复取消");
    return 1;
  }
  let runtime;
  try {
    const env = loadEnv(options.source ?? process.env);
    if (env.APP_ENV !== parsed.appEnv) {
      err("埋点分区修复拒绝：环境不匹配");
      return 1;
    }
    runtime = createRuntime({
      entry: "worker",
      env: { ...env, LOG_LEVEL: "fatal" },
      version: options.version ?? "dev",
    });
  } catch {
    err("埋点分区修复环境不可用");
    return 2;
  }
  let code = 0,
    result;
  try {
    if (options.signal?.aborted) {
      err("埋点分区修复取消");
      code = 1;
    } else result = await runtime.analyticsPartitions.repartition(parsed, options.signal);
  } catch (error) {
    err(isAppError(error) ? `埋点分区修复拒绝：${error.error}` : "埋点分区修复失败");
    code = isAppError(error) || options.signal?.aborted ? 1 : 2;
  } finally {
    try {
      await runtime.close();
    } catch {
      err("埋点分区修复连接关闭失败");
      code = 2;
    }
  }
  if (code === 0 && result) out(JSON.stringify(result));
  return code;
}
