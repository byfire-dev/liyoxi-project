import { createRuntime, isAppError, loadEnv } from "@liyoxi/services";
import type { Runtime } from "@liyoxi/services";

interface Input {
  financeSession: string;
  administratorSession: string;
  refundTxnId: string;
  evidenceFileId: string;
  note: string;
  financeConfirm: { requestNo: string; outRefundNo: string };
  administratorConfirm: { requestNo: string; outRefundNo: string };
}
export interface RefundAbandonOptions {
  argv?: readonly string[];
  source?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  version?: string;
  /** 测试运输可注入真实隔离runtime；不替换认证或领域写者。 */
  runtime?: () => Runtime;
  stdin?: AsyncIterable<Uint8Array | string>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}
/** 凭证只从stdin接收；不进argv、history或输出。解析/业务错误只输出安全符号。 */
async function readInput(
  stream: AsyncIterable<Uint8Array | string>,
  signal?: AbortSignal,
): Promise<Input> {
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    if (signal?.aborted) throw new Error("CANCELLED");
    const part = Buffer.from(chunk);
    bytes += part.length;
    if (bytes > 16_384) throw new Error("INPUT_TOO_LARGE");
    parts.push(part);
  }
  const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_INPUT");
  const record = value as Record<string, unknown>;
  if (
    typeof record.financeSession !== "string" ||
    !record.financeSession ||
    typeof record.administratorSession !== "string" ||
    !record.administratorSession
  )
    throw new Error("INVALID_INPUT");
  // 全部领域字段由领域严格schema校验；这里仅读取opaque会话，不解释资金事实。
  return value as Input;
}
export const refundAbandonTxnCommand = {
  name: "refund_abandon_txn",
  run: runRefundAbandonTxnCommand,
} as const;
export async function runRefundAbandonTxnCommand(
  options: RefundAbandonOptions = {},
): Promise<number> {
  const out = options.out ?? ((line) => void process.stdout.write(`${line}\n`));
  const err = options.err ?? ((line) => void process.stderr.write(`${line}\n`));
  if ((options.argv ?? process.argv.slice(2)).length) {
    err("用法：refund-abandon-txn（仅从stdin读取JSON与两份现时会话）");
    return 1;
  }
  let input: Input;
  try {
    input = await readInput(options.stdin ?? process.stdin, options.signal);
  } catch {
    err("退款放弃输入无效或已取消");
    return 1;
  }
  if (options.signal?.aborted) {
    err("退款放弃已取消");
    return 1;
  }
  let runtime: Runtime;
  try {
    runtime =
      options.runtime?.() ??
      createRuntime({
        entry: "worker",
        env: { ...loadEnv(options.source ?? process.env), LOG_LEVEL: "fatal" },
        version: options.version ?? "dev",
      });
  } catch {
    err("退款放弃环境不可用");
    return 2;
  }
  let code = 0;
  try {
    const { financeSession, administratorSession, ...request } = input;
    const finance = await runtime.staffAuth.authenticate(financeSession);
    const administrator = await runtime.staffAuth.authenticate(administratorSession);
    if (options.signal?.aborted) throw new Error("CANCELLED");
    const result = await runtime.billing.refunds.abandon({ finance, administrator }, request);
    out(JSON.stringify(result));
  } catch (error) {
    err(isAppError(error) ? `退款放弃拒绝：${error.error}` : "退款放弃失败");
    code = isAppError(error) ? 1 : 2;
  } finally {
    try {
      await runtime.close();
    } catch {
      err("退款放弃连接关闭失败");
      code = 2;
    }
  }
  return code;
}
