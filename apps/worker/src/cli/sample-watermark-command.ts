import { parseArgs } from "node:util";
import {
  createRuntime,
  createSampleWatermarkActions,
  isAppError,
  isUuid,
  loadEnv,
} from "@liyoxi/services";

export interface SampleWatermarkOptions {
  readonly argv?: readonly string[];
  readonly source?: Readonly<Record<string, string | undefined>>;
  readonly version?: string;
  readonly signal?: AbortSignal;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}
const USAGE =
  "用法：sample-watermark --database <本机数据库名> --staff <员工UUID> --sample-id <样片UUID> --note <5–200字原因>";
function input(argv: readonly string[]) {
  const { values, tokens } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      database: { type: "string" },
      staff: { type: "string" },
      "sample-id": { type: "string" },
      note: { type: "string" },
    },
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error("DUPLICATE_OPTION");
    seen.add(token.name);
  }
  const database = values.database,
    staffId = values.staff,
    sampleId = values["sample-id"],
    note = values.note?.trim();
  if (
    !database ||
    !/^[a-zA-Z0-9_]+$/.test(database) ||
    !staffId ||
    !isUuid(staffId) ||
    !sampleId ||
    !isUuid(sampleId) ||
    !note ||
    Array.from(note).length < 5 ||
    Array.from(note).length > 200
  )
    throw new Error("INVALID_INPUT");
  return { database, staffId, sampleId, note };
}
export async function runSampleWatermarkCommand(
  options: SampleWatermarkOptions = {},
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
    err("样片水印补排取消");
    return 1;
  }
  let runtime;
  try {
    const env = loadEnv(options.source ?? process.env);
    const database = new URL(env.DATABASE_URL);
    const production = env.MEDIA_PRODUCTION;
    if (
      !["local", "test"].includes(env.APP_ENV) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) ||
      decodeURIComponent(database.pathname.slice(1)) !== parsed.database ||
      !production ||
      !("mode" in production) ||
      production.mode !== "local_sample_watermark"
    ) {
      err("样片水印补排仅允许显式本机库及本地水印配置");
      return 1;
    }
    runtime = createRuntime({
      entry: "worker",
      env: { ...env, LOG_LEVEL: "fatal" },
      version: options.version ?? "dev",
    });
  } catch {
    err("样片水印补排环境不可用");
    return 2;
  }
  let code = 0,
    result;
  try {
    if (options.signal?.aborted) {
      err("样片水印补排取消");
      code = 1;
    } else {
      // 已开始的原子事务等待真实结果；关闭前不将已提交任务伪称为取消。
      result = await createSampleWatermarkActions(runtime).runCli({
        staffId: parsed.staffId,
        sampleId: parsed.sampleId,
        note: parsed.note,
      });
    }
  } catch (error) {
    err(isAppError(error) ? `样片水印补排拒绝：${error.error}` : "样片水印补排失败");
    code = isAppError(error) ? 1 : 2;
  } finally {
    try {
      await runtime.close();
    } catch {
      err("样片水印补排连接关闭失败");
      code = 2;
    }
  }
  if (code === 0 && result) out(JSON.stringify(result));
  return code;
}
