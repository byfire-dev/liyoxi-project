import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createRuntime, EnvError, isAppError, isUuid, loadEnv, notify } from "@liyoxi/services";

export interface SmsInitCommandOptions {
  argv?: readonly string[];
  source?: Readonly<Record<string, string | undefined>>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  version?: string;
}
export async function runSmsInitCommand(options: SmsInitCommandOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const err = options.err ?? ((line: string) => void process.stderr.write(`${line}\n`));
  let values;
  try {
    ({ values } = parseArgs({
      args: [...(options.argv ?? process.argv.slice(2))],
      options: {
        config: { type: "string" },
        "staff-id": { type: "string" },
        apply: { type: "boolean" },
      },
    }));
  } catch {
    err("用法：sms-init --config <明确配置文件> --staff-id <超级管理员ID> [--apply]");
    return 1;
  }
  if (!values.config || !values["staff-id"] || !isUuid(values["staff-id"])) {
    err("短信初始化参数不合规");
    return 1;
  }
  let config: unknown;
  try {
    const file = await open(values.config, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65_536) {
        err("短信配置文件超过允许范围");
        return 1;
      }
      // 实际读取也有界，不依赖 stat 与读之间文件未变化。
      const bytes = Buffer.alloc(65_537);
      const read = await file.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > 65_536) {
        err("短信配置文件超过允许范围");
        return 1;
      }
      config = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8"));
    } finally {
      await file.close();
    }
  } catch {
    err("短信配置文件无法读取或不是合法JSON");
    return 1;
  }
  if (!notify.SmsInitSchema.safeParse(config).success) {
    err("短信配置不合固定清单或审批事实");
    return 1;
  }
  let env;
  try {
    env = loadEnv(options.source ?? process.env);
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    err(error.message);
    return 2;
  }
  if ((env.APP_ENV === "stg" || env.APP_ENV === "prod") && !values.apply) {
    err("远端环境必须明确 --apply 才写入短信配置");
    return 1;
  }
  let runtime: ReturnType<typeof createRuntime>;
  try {
    runtime = createRuntime({
      entry: "worker",
      env: { ...env, LOG_LEVEL: "warn" },
      version: options.version ?? "dev",
    });
  } catch {
    err("短信初始化装配失败");
    return 2;
  }
  try {
    const result = await runtime.smsInit({ staffId: values["staff-id"], config });
    out(`短信模板初始化完成：变更 ${result.changed} 项`);
    return 0;
  } catch (error) {
    if (isAppError(error)) {
      err("短信初始化被服务守卫拒绝");
      return 1;
    }
    err("短信初始化失败：环境或存储不可用");
    return 2;
  } finally {
    await runtime.close().catch(() => undefined);
  }
}
