import { parseArgs } from "node:util";
import { createRuntime, EnvError, isAppError, loadEnv } from "@liyoxi/services";

export interface StaffReissueOptions {
  readonly argv?: readonly string[];
  readonly source?: Readonly<Record<string, string | undefined>>;
  readonly version?: string;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}
export async function runStaffReissueActivation(
  options: StaffReissueOptions = {},
): Promise<number> {
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
  let values: { "staff-id"?: string; "confirm-staff-no"?: string; "allow-production"?: boolean };
  try {
    values = parseArgs({
      args: [...(options.argv ?? process.argv.slice(2))],
      options: {
        "staff-id": { type: "string" },
        "confirm-staff-no": { type: "string" },
        "allow-production": { type: "boolean" },
      },
    }).values;
  } catch {
    err("参数无效");
    return 1;
  }
  const id = values["staff-id"],
    number = Number(values["confirm-staff-no"]);
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    err("用法：--staff-id UUID --confirm-staff-no 工号；生产环境另需 --allow-production");
    return 1;
  }
  let env;
  try {
    env = loadEnv(options.source ?? process.env);
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    err("运行配置无效");
    return 2;
  }
  if (env.APP_ENV === "prod" && !values["allow-production"]) {
    err("生产补发必须显式授权");
    return 1;
  }
  const runtime = createRuntime({
    entry: "worker",
    env: { ...env, LOG_LEVEL: "error" },
    version: options.version ?? "dev",
  });
  try {
    const result = await runtime.staffAuth.reissueBootstrapActivation({
      staffId: id,
      confirmStaffNo: number,
    });
    out(`首位管理员（工号 ${result.staffNo}）激活码：${result.activationCode}`);
    out(`仅显示本次，${result.activationExpiresAt.toISOString()} 前有效。`);
    return 0;
  } catch (error) {
    err(isAppError(error) ? "补发被当前账号事实拒绝" : "补发失败，请核本地配置与连接");
    return isAppError(error) ? 1 : 2;
  } finally {
    await runtime.close();
  }
}
export const staffReissueActivationCommand = {
  name: "staff_reissue_activation",
  run: runStaffReissueActivation,
} as const;
