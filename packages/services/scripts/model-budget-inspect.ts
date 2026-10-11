import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Redis } from "ioredis";
import { loadEnv, systemClock } from "../src/kernel/index.js";
import { createModelBudgetInspector } from "../src/ops/index.js";

/** 导入与check零IO；只有明确inspect才读正式环境并打开独占连接。 */
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  let inspect: boolean;
  try {
    const { values } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: { check: { type: "boolean" }, inspect: { type: "boolean" } },
    });
    if (!!values.check === !!values.inspect) throw new Error();
    inspect = !!values.inspect;
  } catch {
    process.stderr.write("用法：model-budget:inspect --check 或 --inspect；不接受目标或写入参数\n");
    return 2;
  }
  if (!inspect) return 0;
  let client: Redis | undefined,
    inspector: ReturnType<typeof createModelBudgetInspector> | undefined;
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
    inspector = createModelBudgetInspector({
      appEnv: env.APP_ENV,
      clock: systemClock,
      transport: {
        eval: (script, keys, argv) => client!.eval(script, keys.length, ...keys, ...argv),
      },
    });
    const result = await inspector.inspect(new AbortController().signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === "unavailable" ? 1 : 0;
  } catch {
    process.stderr.write("模型预算诊断不可用；未执行写入或恢复\n");
    return 1;
  } finally {
    await inspector?.close();
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
      process.stderr.write("模型预算诊断失败\n");
      process.exitCode = 1;
    },
  );
