// M3 只替换 Redis 命名空间/TIME 外部 IO，预算判定仍执行原生产 Lua。
import { assertNotInTransaction } from "../kernel/index.js";
import type { M1SupportOptions } from "./m1-types.js";

export async function m3ModelBudget(
  input: Parameters<NonNullable<M1SupportOptions["modelBudgetTransport"]>>[0],
  enabled: () => boolean,
) {
  const key = `${input.redisPrefix}model_budget:v1`,
    at = input.clock.now().getTime();
  assertNotInTransaction("m3.modelBudget.fixture");
  if (await input.redis.exists(key)) throw new Error("M3 本轮预算夹具已存在，拒绝覆盖");
  // 与模型准入真实 Redis 测试相同的合法历史夹具；不是生产 missing-only 建账演练。
  await input.redis.hset(key, {
    marker: "model_budget_v1",
    business: String(at - 1),
    redis: String(at - 1),
    day: String(Math.floor((at + 28_800_000) / 86_400_000)),
    closed: "0",
    head: "1",
    next: "1",
    cursor: "1",
  });
  return {
    async eval(script: string, keys: readonly string[], argv: readonly string[]): Promise<unknown> {
      assertNotInTransaction("m3.modelBudget.eval");
      if (keys.length !== 1 || keys[0] !== "lyx:test:model_budget:v1")
        throw new Error("M3 预算传输拒绝非本轮正式账本 key");
      if (!enabled()) return undefined;
      const now = input.clock.now().getTime();
      // 与既有午夜测试相同：仅模拟服务器时钟，保留原子脚本、阈值、去重和失效判断。
      const timed = script.replaceAll(
        "redis.call('TIME')",
        `{ '${Math.floor(now / 1000)}', '${(now % 1000) * 1000}' }`,
      );
      return input.redis.eval(timed, 1, key, ...argv);
    },
  };
}
