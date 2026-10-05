// 启动自检（W0-14；D4 第 9.2 节）：加密、解密、盲索引各走一遍，失败即拒绝启动。
// 接到 api、worker 的启动由 W0-22、W0-23 做（docs/plan/tasks/README.md 第 5 节移交表第 1 行）。
import { blindIndex } from "./bidx.js";
import { decryptField, encryptField } from "./crypto.js";
import { BIDX_PURPOSES, keyringFromEnv, SecurityError } from "./keyring.js";
import type { Keyring } from "./keyring.js";

const PROBE = "lyx-selfcheck-13800000000";
const COLUMN = "selfcheck.probe_enc";

/**
 * 自检一个密钥环：密钥环里每一把数据密钥都是 32 字节、当前密钥加密后解得回原文、
 * 每个用途的盲索引是稳定的 32 字节。不过即抛 SecurityError（selfcheck_failed）。
 */
export function selfCheck(keyring: Keyring): void {
  const fail = (what: string): never => {
    throw new SecurityError("selfcheck_failed", `字段加密的启动自检不过：${what}`);
  };
  try {
    for (const kid of keyring.kids) {
      if (keyring.dataKey(kid)?.length !== 32) fail(`数据密钥 ${kid} 不是 32 字节`);
    }
    if (decryptField(keyring, COLUMN, encryptField(keyring, COLUMN, PROBE)) !== PROBE) {
      fail("当前密钥加密后解不回原文");
    }
    for (const purpose of BIDX_PURPOSES) {
      const first = blindIndex(keyring, purpose, PROBE);
      if (first.length !== 32 || !first.equals(blindIndex(keyring, purpose, PROBE))) {
        fail(`盲索引 ${purpose} 不是稳定的 32 字节`);
      }
    }
  } catch (error) {
    if (error instanceof SecurityError && error.code === "selfcheck_failed") throw error;
    // 密钥长度不对时 node:crypto 抛的是 RangeError：统一成自检失败，原始错误留在 cause 里
    const failure = new SecurityError("selfcheck_failed", "字段加密的启动自检不过：加解密走不通");
    failure.cause = error;
    throw failure;
  }
}

/** 进程启动时调：由 loadEnv 的结果造密钥环并自检，返回可用的密钥环。密钥没配、不合格、自检不过都抛错 */
export function loadKeyring(env: Parameters<typeof keyringFromEnv>[0]): Keyring {
  const keyring = keyringFromEnv(env);
  selfCheck(keyring);
  return keyring;
}
