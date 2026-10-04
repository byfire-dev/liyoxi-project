// 授权书版次的 snapshot：渲染只读它，不查库（D6 第 3.5.1 节）。
// 内容指纹 = snapshot 规范化 JSON（键排序、无空白、UTF-8）的 SHA-256（D6 第 3.5.1、3.5.3 节）。
import { createHash } from "node:crypto";

export type Platform = "douyin" | "channels";

export interface LicenseSnapshot {
  licensor: { name: string; creditCode: string };
  licensee: { name: string; creditCode: string; store: string };
  drama: {
    name: string;
    episodes: number;
    permits: { kind: string; number: string; platform: Platform }[];
  };
  account: { platform: Platform; name: string; accountId: string };
  period: { start: string | null; startText: string; end: string; territory: string };
  rightsClauseKey: string;
  exclusiveClauseKey: string;
  obligationClauseKey: string;
  consent: { consentId: string; agreement: string; at: string; by: string };
  letterNo: string;
  revNo: number;
  issuedAt: string;
  verifyUrl: string;
}

/**
 * 规范化 JSON：对象的键排序，数组保持原序，不留空白。
 * 排序用 Array.prototype.sort() 的默认顺序，即按 UTF-16 码元比，不是按码位比。现在的键全是 ASCII，
 * 两种比法结果相同；键里出现基本平面以外的字符时会不同，G5-B 定稿时把排序规则写准。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** 内容指纹：64 位十六进制小写 */
export function contentFingerprint(snapshot: LicenseSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot), "utf8").digest("hex");
}
