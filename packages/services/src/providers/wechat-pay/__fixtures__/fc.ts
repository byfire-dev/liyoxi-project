// 性质测试（fast-check）的种子与轮次：PR 上用固定种子、每个性质 200 轮（D7 第 10.2 节；与 packages/shared 同一口径）。
// 要跑大轮次或复现某个种子时用环境变量改，例：
//   LYX_FC_RUNS=5000 LYX_FC_SEED=42 pnpm exec vitest run packages/services/src/providers/wechat-pay -t property
// 性质用例失败时 fast-check 会打印种子与最小化后的反例：把反例固化成固定用例再修。

function envInteger(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} 必须是不小于 ${min} 的整数，收到 ${raw}`);
  }
  return value;
}

export const FC_RUNS = envInteger("LYX_FC_RUNS", 200, 1);
export const FC_SEED = envInteger("LYX_FC_SEED", 20261004, Number.MIN_SAFE_INTEGER);

/** 传给 fc.assert 的参数 */
export const FC_PARAMS = { numRuns: FC_RUNS, seed: FC_SEED } as const;

/** 写进用例名：证据里看得到这一轮用的种子与轮次 */
export const FC_LABEL = `种子 ${FC_SEED}，${FC_RUNS} 轮`;

/** 性质用例的超时：按轮次放宽（一轮里可能有几次 RSA 签名），免得大轮次或慢机器上被默认的 5 秒掐掉 */
export const FC_TIMEOUT_MS = Math.max(60_000, FC_RUNS * 300);
