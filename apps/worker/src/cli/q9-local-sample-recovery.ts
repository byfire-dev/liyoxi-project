import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  createQ9LocalSampleRecovery,
  createRuntime,
  isAppError,
  q9LocalSampleRecoveryEnv,
  Q9LocalSampleRecoveryInputSchema,
} from "@liyoxi/services";
import type { Runtime } from "@liyoxi/services";

const USAGE =
  "用法：q9-local-sample-recovery --store <UUID> --sample <UUID> --version <版本号> --staff <员工UUID> --config-staff <超管UUID> --reason <10–200字原因> --quality-file <绝对路径.json> --idempotency-key <键> [--apply]（默认只读预检）";
export async function runQ9LocalSampleRecoveryCommand(
  options: {
    argv?: readonly string[];
    source?: Readonly<Record<string, string | undefined>>;
    signal?: AbortSignal;
    out?: (line: string) => void;
    err?: (line: string) => void;
  } = {},
): Promise<number> {
  const out = options.out ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const err = options.err ?? ((line: string) => void process.stderr.write(`${line}\n`));
  let input, env;
  try {
    const { values, tokens } = parseArgs({
      args: [...(options.argv ?? process.argv.slice(2))],
      strict: true,
      allowPositionals: false,
      tokens: true,
      options: {
        store: { type: "string" },
        sample: { type: "string" },
        version: { type: "string" },
        staff: { type: "string" },
        "config-staff": { type: "string" },
        reason: { type: "string" },
        "quality-file": { type: "string" },
        "idempotency-key": { type: "string" },
        apply: { type: "boolean", default: false },
      },
    });
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.kind !== "option") continue;
      if (seen.has(token.name)) throw new Error("DUPLICATE_OPTION");
      seen.add(token.name);
    }
    // Reject nonlocal configuration before runtime construction or reading any input file.
    env = q9LocalSampleRecoveryEnv(options.source ?? process.env);
    const filePath = values["quality-file"];
    if (
      !filePath ||
      !isAbsolute(filePath) ||
      !filePath.endsWith(".json") ||
      basename(filePath).startsWith(".env") ||
      !/^[1-9]\d*$/.test(values.version ?? "")
    )
      throw new Error("INVALID_INPUT");
    options.signal?.throwIfAborted();
    const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let quality: unknown;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 2 || stat.size > 16_384) throw new Error("INVALID_INPUT");
      const bytes = Buffer.alloc(16_385);
      const read = await file.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > 16_384) throw new Error("INVALID_INPUT");
      quality = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8"));
    } finally {
      await file.close();
    }
    input = Q9LocalSampleRecoveryInputSchema.parse({
      storeId: values.store,
      sampleId: values.sample,
      versionNo: Number(values.version),
      staffId: values.staff,
      configStaffId: values["config-staff"],
      reason: values.reason,
      idempotencyKey: values["idempotency-key"],
      quality,
      apply: values.apply,
    });
  } catch {
    err(USAGE);
    return 1;
  }
  let runtime: Runtime | undefined;
  let code = 0;
  try {
    options.signal?.throwIfAborted();
    runtime = createRuntime({ entry: "worker", env, version: "q9-local-recovery" });
    const result = await createQ9LocalSampleRecovery(runtime).run(input, options.signal);
    out(JSON.stringify(result));
    if (result.mode === "failed" || ("canApply" in result && !result.canApply)) code = 1;
  } catch (error) {
    err(
      isAppError(error)
        ? `Q9本地恢复拒绝：${error.error}`
        : options.signal?.aborted
          ? "Q9本地恢复已取消"
          : "Q9本地恢复失败",
    );
    code = isAppError(error) || options.signal?.aborted ? 1 : 2;
  } finally {
    try {
      await runtime?.close();
    } catch {
      err("Q9本地恢复连接关闭失败");
      code = 2;
    }
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  void runQ9LocalSampleRecoveryCommand({ signal: controller.signal })
    .then(
      (code) => {
        process.exitCode = code;
      },
      () => {
        process.stderr.write("Q9本地恢复失败\n");
        process.exitCode = 2;
      },
    )
    .finally(() => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    });
}
