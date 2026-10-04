// 微信支付的配置类型与成组校验（D7 第 7.5 节“启动校验”；ADR-039：未配置不崩溃）。
//
// 五项成组：商户号、商户 API 证书序列号、商户 API 私钥、APIv3 密钥、微信支付公钥 ID。
//   五项全缺            → 未配置（只剩对公转账），沿用 W0-19 的未配置实现
//   缺其中任一项        → 配置错误，指出缺哪几项
//   五项齐全            → 再核对驱动另外要的三项（公钥本体、小程序 AppID、支付回调地址），缺了同样是配置错误
//   填了的              → 逐项核对写法：私钥、公钥本体、两把 APIv3 密钥、并存的验签身份、回调地址。写错同样是配置错误
// 本文件不读环境变量：设置由装配处给（接进 loadEnv 与选择分支归 G4-A）。报错只写字段名与原因，不带任何值。

import { createPrivateKey } from "node:crypto";
import type { KeyObject } from "node:crypto";

import type { ApiV3Key, VerifierEntry } from "./keyring.js";
import { createVerifierTable, PUBLIC_KEY_ID_PREFIX } from "./keyring.js";

/** 装配处给的原始设置。密钥类的值由装配处从 *_FILE 指的文件里读出来再给 */
export interface WechatPaySettings {
  mchid?: string;
  merchantSerialNo?: string;
  merchantPrivateKeyPem?: string;
  apiV3Key?: string;
  publicKeyId?: string;
  /** 微信支付公钥本体（PEM） */
  publicKeyPem?: string;
  /** 小程序 AppID：下单与调起支付签名要用 */
  appid?: string;
  /** 支付结果通知的地址 */
  notifyUrl?: string;
  /** 退款结果通知的地址；不给则退款时不带 notify_url，微信按商户平台上配的地址通知 */
  refundNotifyUrl?: string;
  /** 当前 APIv3 密钥的版本，缺省 v1 */
  apiV3KeyId?: string;
  /** 轮换期保留的上一把 APIv3 密钥 */
  previousApiV3Key?: ApiV3Key;
  /**
   * 并存的其余验签身份。切换期的平台证书：序列号加证书 PEM。换微信支付公钥时并存的另一把公钥也放这里
   * （公钥 ID 加公钥 PEM；名字叫平台证书，验签身份表两种都认）。请求头里带的公钥 ID 只有 publicKeyId 一个
   */
  platformCertificates?: VerifierEntry[];
  baseUrl?: string;
  timeoutMs?: number;
}

export const WECHAT_PAY_GROUP = [
  "mchid",
  "merchantSerialNo",
  "merchantPrivateKeyPem",
  "apiV3Key",
  "publicKeyId",
] as const satisfies readonly (keyof WechatPaySettings)[];

const ALSO_REQUIRED = [
  "publicKeyPem",
  "appid",
  "notifyUrl",
] as const satisfies readonly (keyof WechatPaySettings)[];

/** 校验过的配置，驱动直接用 */
export interface WechatPayConfig {
  mchid: string;
  appid: string;
  merchantSerialNo: string;
  merchantPrivateKey: KeyObject;
  publicKeyId: string;
  apiV3Keys: { current: ApiV3Key; previous?: ApiV3Key };
  /** 验签身份：微信支付公钥在前，平台证书在后 */
  verifiers: VerifierEntry[];
  notifyUrl: string;
  refundNotifyUrl?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export type WechatPayConfigState =
  | { state: "unconfigured" }
  /** missing：缺的字段名；problems：填了但不合规的字段名与原因 */
  | { state: "invalid"; missing: string[]; problems: string[] }
  | { state: "configured"; config: WechatPayConfig };

const filled = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

export function resolveWechatPayConfig(settings: WechatPaySettings): WechatPayConfigState {
  const missingOfGroup = WECHAT_PAY_GROUP.filter((key) => !filled(settings[key]));
  if (missingOfGroup.length === WECHAT_PAY_GROUP.length) return { state: "unconfigured" };
  const missing = [...missingOfGroup, ...ALSO_REQUIRED.filter((key) => !filled(settings[key]))];
  if (missing.length > 0) return { state: "invalid", missing, problems: [] };

  const s = settings as Required<Pick<WechatPaySettings, (typeof WECHAT_PAY_GROUP)[number]>> &
    Required<Pick<WechatPaySettings, (typeof ALSO_REQUIRED)[number]>> &
    WechatPaySettings;
  const problems: string[] = [];
  let merchantPrivateKey: KeyObject | undefined;
  try {
    merchantPrivateKey = createPrivateKey(s.merchantPrivateKeyPem);
  } catch {
    problems.push("merchantPrivateKeyPem: 不是合规的私钥 PEM");
  }
  // 从文件里读出来的密钥常带一个结尾的换行：去掉首尾空白再算长度
  const apiV3Key = s.apiV3Key.trim();
  if (Buffer.byteLength(apiV3Key, "utf8") !== 32) problems.push("apiV3Key: 长度必须是 32 个字节");
  if (!s.publicKeyId.startsWith(PUBLIC_KEY_ID_PREFIX)) {
    problems.push(`publicKeyId: 要以 ${PUBLIC_KEY_ID_PREFIX} 开头`);
  }
  for (const key of ["notifyUrl", "refundNotifyUrl"] as const) {
    const url = s[key];
    if (filled(url) && !/^https:\/\/[^?#]+$/.test(url)) {
      problems.push(`${key}: 要是 https 地址，不带参数`);
    }
  }
  // 轮换期的上一把密钥：与当前这把同样去掉首尾空白再算长度
  const current: ApiV3Key = { kid: s.apiV3KeyId ?? "v1", key: apiV3Key };
  let previous: ApiV3Key | undefined;
  if (s.previousApiV3Key !== undefined) {
    const { kid, key } = s.previousApiV3Key;
    previous = { kid, key: filled(key) ? key.trim() : "" };
    if (!filled(kid) || kid === current.kid || Buffer.byteLength(previous.key, "utf8") !== 32) {
      problems.push("previousApiV3Key: 长度必须是 32 个字节，kid 要填且不能与当前的相同");
    }
  }
  // 公钥本体与并存的验签身份：逐条试建，建不起来在这里报出字段名。原因只写固定的一句，不带底层报错与任何值；
  // 公钥 ID 已经报过写错的，不连带再报公钥本体
  const verifiers: VerifierEntry[] = [
    { serial: s.publicKeyId.trim(), pem: s.publicKeyPem },
    ...(s.platformCertificates ?? []),
  ];
  verifiers.forEach((entry, index) => {
    if (index === 0 && !entry.serial.startsWith(PUBLIC_KEY_ID_PREFIX)) return;
    try {
      createVerifierTable([entry]);
    } catch {
      problems.push(
        index === 0
          ? "publicKeyPem: 不是合规的公钥 PEM"
          : `platformCertificates[${index - 1}]: 序列号与 PEM 对不上，或 PEM 不合规`,
      );
    }
  });
  if (!merchantPrivateKey || problems.length > 0)
    return { state: "invalid", missing: [], problems };

  return {
    state: "configured",
    config: {
      mchid: s.mchid.trim(),
      appid: s.appid.trim(),
      merchantSerialNo: s.merchantSerialNo.trim(),
      merchantPrivateKey,
      publicKeyId: s.publicKeyId.trim(),
      apiV3Keys: { current, previous },
      verifiers,
      notifyUrl: s.notifyUrl,
      refundNotifyUrl: filled(s.refundNotifyUrl) ? s.refundNotifyUrl : undefined,
      baseUrl: s.baseUrl,
      timeoutMs: s.timeoutMs,
    },
  };
}

/** 配置错误：message 只列字段名与原因，不带任何值 */
export class WechatPayConfigError extends Error {
  readonly missing: readonly string[];
  readonly problems: readonly string[];

  constructor(missing: readonly string[], problems: readonly string[]) {
    const parts = [missing.length > 0 ? `缺 ${missing.join("、")}` : "", ...problems];
    super(`微信支付配置不合格：${parts.filter(Boolean).join("；")}`);
    this.name = "WechatPayConfigError";
    this.missing = missing;
    this.problems = problems;
  }
}
