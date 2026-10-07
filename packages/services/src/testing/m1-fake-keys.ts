// 无 Vitest 的公知测试密钥；原 staff 支架转导同一个函数，值与语义不变。
import type { AuthKeysConfig, BidxKeysConfig, DataKeysConfig } from "../kernel/index.js";
const fill = (byte: number): Buffer => Buffer.alloc(32, byte);
export const fakeKeyEnv = (): {
  DATA_KEYS: DataKeysConfig;
  BIDX_KEYS: BidxKeysConfig;
  AUTH_KEYS: AuthKeysConfig;
} => {
  const b64 = (byte: number): string => fill(byte).toString("base64");
  return {
    DATA_KEYS: { current: "test", keys: { test: b64(0x51) } },
    BIDX_KEYS: { phone: b64(0x52), uscc: b64(0x53) },
    AUTH_KEYS: {
      ticket: b64(0x71),
      device: b64(0x72),
      mfa: { current: "t1", keys: { t1: b64(0x73) } },
    },
  };
};
