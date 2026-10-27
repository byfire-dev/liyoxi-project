import { createHash, timingSafeEqual } from "node:crypto";

/** 仅由驱动/测试替身工厂产生；领域只从types消费类型，不能引该构造路径。 */
class VerifiedTradeBill {
  readonly kind = "verified";
  readonly #body: Uint8Array;
  constructor(
    readonly billDate: string,
    readonly appid: string,
    readonly mchid: string,
    readonly sha1: string,
    bytes: Uint8Array,
  ) {
    this.#body = new Uint8Array(bytes);
    Object.freeze(this);
  }
  /** 每次交出副本，防止归档与解析之间原始字节被调用方改写。 */
  get bytes(): Uint8Array {
    return this.#body.slice();
  }
}
export type { VerifiedTradeBill };
export type VerifiedTradeBillResult =
  | VerifiedTradeBill
  | {
      readonly kind: "missing";
      readonly billDate: string;
      readonly appid: string;
      readonly mchid: string;
    };
/** 无URL/正文日志；摘要来自已验签申请应答，原字节来自受控下载。 */
export function createVerifiedTradeBill(input: {
  billDate: string;
  appid: string;
  mchid: string;
  sha1: string;
  bytes: Uint8Array;
}): VerifiedTradeBill {
  const sha1 = input.sha1.trim().toLowerCase();
  const at = new Date(`${input.billDate}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.billDate) ||
    !Number.isFinite(at.getTime()) ||
    at.toISOString().slice(0, 10) !== input.billDate ||
    !input.appid ||
    !input.mchid ||
    !/^[0-9a-f]{40}$/.test(sha1) ||
    !timingSafeEqual(createHash("sha1").update(input.bytes).digest(), Buffer.from(sha1, "hex"))
  )
    throw new TypeError("可信账单来源或摘要不合规");
  return new VerifiedTradeBill(input.billDate, input.appid, input.mchid, sha1, input.bytes);
}
