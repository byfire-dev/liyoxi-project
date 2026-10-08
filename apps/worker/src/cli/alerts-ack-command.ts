// W2-23：只调用服务公开人工用例；参数、输出和退出码不暴露环境或失败载荷。
import { parseArgs } from "node:util";

import { createRuntime, isAppError, isUuid, loadEnv } from "@liyoxi/services";

export interface AlertsAckOptions {
  readonly argv?: readonly string[];
  readonly source?: Readonly<Record<string, string | undefined>>;
  readonly version?: string;
  readonly signal?: AbortSignal;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

const USAGE =
  "用法：alerts-ack <ack|close|reset-webhook> --staff <员工UUID> --alert-id <告警UUID>（回调用 --webhook-event-id）--note <5–200字原因>";
type Command = "ack" | "close" | "reset-webhook";

function input(argv: readonly string[]) {
  const { values, positionals, tokens } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    tokens: true,
    options: {
      staff: { type: "string" },
      "alert-id": { type: "string" },
      "webhook-event-id": { type: "string" },
      note: { type: "string" },
    },
  });
  const command = positionals[0];
  if (positionals.length !== 1 || !["ack", "close", "reset-webhook"].includes(command ?? ""))
    throw new Error("INVALID_COMMAND");
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error("DUPLICATE_OPTION");
    seen.add(token.name);
  }
  const targetId = command === "reset-webhook" ? values["webhook-event-id"] : values["alert-id"];
  const otherId = command === "reset-webhook" ? values["alert-id"] : values["webhook-event-id"];
  const staffId = values.staff;
  const note = values.note?.trim();
  if (
    !staffId ||
    !isUuid(staffId) ||
    !targetId ||
    !isUuid(targetId) ||
    otherId !== undefined ||
    !note ||
    Array.from(note).length < 5 ||
    Array.from(note).length > 200
  )
    throw new Error("INVALID_TARGET_OR_REASON");
  return { staffId, command: command as Command, targetId, note };
}

export const alertsAckCommand = { name: "alerts_ack", run: runAlertsAckCommand } as const;

export async function runAlertsAckCommand(options: AlertsAckOptions = {}): Promise<number> {
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
    err("流程运维取消");
    return 1;
  }
  let runtime;
  try {
    const env = loadEnv(options.source ?? process.env);
    runtime = createRuntime({
      entry: "worker",
      env: { ...env, LOG_LEVEL: "fatal" },
      version: options.version ?? "dev",
    });
  } catch {
    err("流程运维环境不可用");
    return 2;
  }
  let code = 0;
  let result;
  try {
    if (options.signal?.aborted) {
      err("流程运维取消");
      code = 1;
    } else {
      // 已进入的单次原子事务等待真实结果，再关闭连接；中途信号不伪称写入已取消。
      result = await runtime.alertActions.runCli(parsed);
    }
  } catch (error) {
    err(isAppError(error) ? `流程运维拒绝：${error.error}` : "流程运维失败");
    code = isAppError(error) ? 1 : 2;
  } finally {
    try {
      await runtime.close();
    } catch {
      err("流程运维连接关闭失败");
      code = 2;
    }
  }
  if (code === 0 && result)
    out(
      JSON.stringify({ command: result.command, targetId: result.targetId, status: result.status }),
    );
  return code;
}
