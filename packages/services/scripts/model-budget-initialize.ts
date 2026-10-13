import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Redis } from "ioredis";
import { loadEnv, systemClock } from "../src/kernel/index.js";
import { createModelBudgetInitializer } from "../src/ops/index.js";

/** 只允许明确建账；check零环境/IO，无任意目标、额度或脚本参数。 */
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  let initialize: boolean;
  try {
    const { values } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: { check: { type: "boolean" }, initialize: { type: "boolean" } },
    });
    if (!!values.check === !!values.initialize) throw new Error();
    initialize = !!values.initialize;
  } catch {
    process.stderr.write(
      "用法：model-budget:initialize --check 或 --initialize；不接受目标/额度/写入内容\n",
    );
    return 2;
  }
  if (!initialize) return 0;
  let client: Redis | undefined,
    initializer: ReturnType<typeof createModelBudgetInitializer> | undefined;
  try {
    const env = loadEnv();
    client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      connectTimeout: 250,
      commandTimeout: 250,
    });
    client.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error()), 250);
      void client!.connect().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          reject(new Error());
        },
      );
    });
    initializer = createModelBudgetInitializer({
      appEnv: env.APP_ENV,
      clock: systemClock,
      transport: {
        eval: (script, keys, argv) => client!.eval(script, keys.length, ...keys, ...argv),
      },
    });
    const result = await initializer.initialize(new AbortController().signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === "initialized" ? 0 : 1;
  } catch {
    process.stderr.write("模型预算建账不可用；写入结果可能未知，请先只读诊断，勿清空重置\n");
    return 1;
  } finally {
    await initializer?.close();
    if (client) {
      const active = client;
      try {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250);
          void Promise.resolve()
            .then(() => (active.status === "ready" ? active.quit() : undefined))
            .then(
              () => {
                clearTimeout(timer);
                resolve();
              },
              () => {
                clearTimeout(timer);
                resolve();
              },
            );
        });
      } finally {
        active.disconnect();
      }
    }
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("模型预算建账失败，写入结果可能未知\n");
      process.exitCode = 1;
    },
  );
