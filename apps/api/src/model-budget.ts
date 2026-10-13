import { Redis } from "ioredis";
import type { AppEnv, RuntimeOptions } from "@liyoxi/services";
import { testRedisKeyPrefix } from "./cli/test-redis-prefix.js";

/** 复用worker已接受的预算Redis选项；独立连接、不离线排队、不重放、不自动重连。
 * 构造零IO；首次调用只发起有界连接，未就绪仍保守拒绝，本意图不自动重试。
 */
export function createApiModelBudgetTransport(input: {
  readonly redisUrl: string;
  readonly appEnv: AppEnv;
  readonly testKeyPrefix?: string;
  readonly onError: () => void;
}) {
  const keyPrefix = testRedisKeyPrefix(input.appEnv, input.testKeyPrefix);
  const client = new Redis(input.redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    connectTimeout: 250,
    commandTimeout: 250,
    ...(keyPrefix ? { keyPrefix } : {}),
  });
  client.on("error", () => {
    try {
      input.onError();
    } catch {
      /* 日志故障不改变准入 */
    }
  });
  let closed = false,
    closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const transport: NonNullable<RuntimeOptions["modelBudgetTransport"]> = {
    eval(script, keys, argv) {
      if (closed) return Promise.reject(new Error("预算连接已关闭"));
      if (client.status === "wait") void client.connect().catch(() => undefined);
      if (client.status !== "ready") return Promise.reject(new Error("预算连接尚未就绪"));
      const running = client.eval(script, keys.length, ...keys, ...argv);
      pending.add(running);
      void running.then(
        () => pending.delete(running),
        () => pending.delete(running),
      );
      return running;
    },
  };
  return {
    transport,
    close() {
      closed = true;
      return (closing ??= (async () => {
        try {
          await Promise.allSettled([...pending]);
          if (client.status === "ready") await client.quit();
        } finally {
          client.disconnect();
        }
      })());
    },
  };
}
