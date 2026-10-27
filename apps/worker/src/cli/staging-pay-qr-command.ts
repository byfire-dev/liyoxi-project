import { open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createRuntime, isAppError, loadEnv } from "@liyoxi/services";
import type { Runtime } from "@liyoxi/services";

interface Options {
  argv?: readonly string[];
  source?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  version?: string;
  runtime?: () => Runtime;
  stdin?: AsyncIterable<Uint8Array | string>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

async function readInput(stream: AsyncIterable<Uint8Array | string>, signal?: AbortSignal) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16_384) throw new Error("INPUT_TOO_LARGE");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_INPUT");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => key !== "request" && key !== "outputFile") ||
    typeof input.outputFile !== "string" ||
    !isAbsolute(input.outputFile) ||
    !input.request ||
    typeof input.request !== "object"
  )
    throw new Error("INVALID_INPUT");
  return { request: input.request, outputFile: input.outputFile };
}

/** 仅stdin接收现时会话与显式购买意图；输出不含会话、openid或预支付签名。 */
export async function runStagingPayQrCommand(options: Options = {}): Promise<number> {
  const out = options.out ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const err = options.err ?? ((line: string) => void process.stderr.write(`${line}\n`));
  if ((options.argv ?? process.argv.slice(2)).length) {
    err("用法：stg:pay-qr（仅stdin JSON，输出文件须为不存在的绝对路径）");
    return 1;
  }
  let input: Awaited<ReturnType<typeof readInput>>;
  try {
    input = await readInput(options.stdin ?? process.stdin, options.signal);
    options.signal?.throwIfAborted();
  } catch {
    err("预发支付输入无效或已取消");
    return 1;
  }
  let runtime: Runtime | undefined, file: FileHandle | undefined;
  let saved = false,
    code = 0;
  try {
    // 在业务创建/小程序码外呼之前独占文件；不覆盖、跟随或清除已有文件。
    file = await open(input.outputFile, "wx", 0o600);
    runtime =
      options.runtime?.() ??
      createRuntime({
        entry: "worker",
        env: { ...loadEnv(options.source ?? process.env), LOG_LEVEL: "fatal" },
        version: options.version ?? "dev",
      });
    const { image, ...receipt } = await runtime.stagingPay.create(input.request, options.signal);
    options.signal?.throwIfAborted();
    await file.writeFile(image);
    await file.sync();
    saved = true;
    out(
      JSON.stringify({
        ...receipt,
        outputFile: input.outputFile,
        next: "扫码体验版后，使用本主体老板账号在原付款页确认并发起微信支付；此命令未付款或标记成功。",
      }),
    );
  } catch (error) {
    err(
      isAppError(error)
        ? `预发支付入口拒绝：${error.error}`
        : "预发支付入口失败或输出不可用；请保留原body与幂等键重试",
    );
    code = isAppError(error) ? 1 : 2;
  } finally {
    const closing = await Promise.allSettled([file?.close(), runtime?.close()]);
    if (closing.some((result) => result.status === "rejected")) {
      err("预发支付入口连接关闭失败");
      code = 2;
    }
    if (file && !saved) {
      try {
        await unlink(input.outputFile);
      } catch {
        code = 2;
      }
    }
  }
  return code;
}
