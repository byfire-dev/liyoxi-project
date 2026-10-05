// 密钥环（W0-14；D4 第 9.2 节）：数据加密密钥可以多把，按 kid 取，加密用“当前”那把；盲索引密钥一个用途一把。
// 密钥只从 loadEnv 读出来的两份文件内容来（keyringFromEnv）；测试里用固定字节现造（createKeyring）。
// 密钥字节收在闭包里：打印、序列化密钥环都带不出密钥。报错只说哪一项不合格，不带任何密钥内容。
import type { BidxKeysConfig, DataKeysConfig } from "../kernel/index.js";

/** 盲索引的用途。新用途由用到它的包往末尾加；密钥文件里要有同名的一项 */
export const BIDX_PURPOSES = ["phone", "uscc"] as const;
export type BidxPurpose = (typeof BIDX_PURPOSES)[number];

export type SecurityErrorCode =
  | "keyring_missing" // 没有配置密钥文件
  | "keyring_invalid" // 密钥环不合格：长度、kid、当前密钥、用途、重复
  | "plaintext_invalid" // 明文不是合法的 Unicode 文本（有不成对的代理项）
  | "ciphertext_format" // 密文不是 v1:<kid>:<base64url> 的写法
  | "unknown_kid" // 密文用的那把密钥不在密钥环里
  | "decrypt_failed" // 认证失败：密文被改过、换过列（AAD 不符），或密钥不对
  | "selfcheck_failed";

/** 加解密与密钥环的错误。message 里没有明文、密文、密钥 */
export class SecurityError extends Error {
  readonly code: SecurityErrorCode;

  constructor(code: SecurityErrorCode, message: string) {
    super(message);
    this.name = "SecurityError";
    this.code = code;
  }
}

export interface Keyring {
  /** 当前 kid：新密文都用它 */
  readonly currentKid: string;
  /** 密钥环里的全部 kid */
  readonly kids: readonly string[];
  /** 按 kid 取数据密钥；没有这把返回 undefined。只给本目录用 */
  dataKey(kid: string): Buffer | undefined;
  /** 取一个用途的盲索引密钥。只给本目录用 */
  bidxKey(purpose: BidxPurpose): Buffer;
}

type KeyMaterial = string | Uint8Array;
export interface KeyringInput {
  /** current 是当前 kid；keys 是 kid → 32 字节（字节，或 base64、base64url 文本） */
  data: { current: string; keys: Readonly<Record<string, KeyMaterial>> };
  /** 用途 → 32 字节 */
  bidx: Readonly<Record<string, KeyMaterial>>;
}

/** kid 进密文的第二段，不得带冒号 */
const KID = /^[A-Za-z0-9_-]{1,32}$/;
const invalid = (reason: string): never => {
  throw new SecurityError("keyring_invalid", `密钥环不合格：${reason}`);
};

function toKey(material: KeyMaterial, what: string): Buffer {
  const key =
    typeof material === "string" ? Buffer.from(material, "base64") : Buffer.from(material);
  return key.length === 32 ? key : invalid(`${what} 不是 32 字节`);
}

/** 造一个密钥环；不合格即抛 SecurityError（keyring_invalid） */
export function createKeyring(input: KeyringInput): Keyring {
  const data = new Map<string, Buffer>();
  for (const [kid, material] of Object.entries(input.data.keys)) {
    if (!KID.test(kid)) invalid("kid 只能用字母、数字、下划线、连字符，不超过 32 个字符");
    data.set(kid, toKey(material, `数据密钥 ${kid}`));
  }
  const currentKid = input.data.current;
  if (!data.has(currentKid)) invalid("当前 kid 不在密钥环里");

  const bidx = new Map<BidxPurpose, Buffer>();
  for (const purpose of BIDX_PURPOSES) {
    const material = input.bidx[purpose];
    if (material === undefined) invalid(`缺盲索引密钥 ${purpose}`);
    else bidx.set(purpose, toKey(material, `盲索引密钥 ${purpose}`));
  }
  // 各把密钥互不相同：两种用途共用一把，等值的手机号与信用代码会算出同一个盲索引（D4 第 9.2 节）
  const all = [...data.values(), ...bidx.values()].map((key) => key.toString("hex"));
  if (new Set(all).size !== all.length)
    invalid("有两把密钥相同：数据密钥、各用途的盲索引密钥要互不相同");

  return Object.freeze({
    currentKid,
    kids: Object.freeze([...data.keys()]),
    dataKey: (kid: string) => data.get(kid),
    bidxKey: (purpose: BidxPurpose) => bidx.get(purpose) ?? invalid(`缺盲索引密钥 ${purpose}`),
  });
}

/** 由 loadEnv 的结果造密钥环。两份密钥文件没配即抛 SecurityError（keyring_missing） */
export function keyringFromEnv(env: {
  readonly DATA_KEYS?: DataKeysConfig;
  readonly BIDX_KEYS?: BidxKeysConfig;
}): Keyring {
  if (env.DATA_KEYS === undefined || env.BIDX_KEYS === undefined) {
    throw new SecurityError(
      "keyring_missing",
      "没有配置密钥：DATA_KEYS_FILE、BIDX_KEYS_FILE 两项都要给（写法见 .env.example）",
    );
  }
  return createKeyring({ data: env.DATA_KEYS, bidx: env.BIDX_KEYS });
}
