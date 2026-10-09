import { createHash, createHmac } from "node:crypto";

export interface CosKey {
  readonly secretId: string;
  readonly secretKey: string;
}
export const cosEncode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sha1 = (value: string) => createHash("sha1").update(value).digest("hex");
const hmac = (algorithm: string, key: string | Uint8Array, value: string) =>
  createHmac(algorithm, key).update(value).digest();
function canonical(values: Readonly<Record<string, string>>) {
  const entries = Object.entries(values)
    .map(([key, value]) => [cosEncode(key).toLowerCase(), cosEncode(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    list: entries.map(([key]) => key).join(";"),
    text: entries.map(([key, value]) => `${key}=${value}`).join("&"),
  };
}
/** COS v5 uses the hex text of SignKey as the next HMAC key, not its raw bytes. */
export function cosAuthorization(input: {
  key: CosKey;
  method: string;
  pathname: string;
  query?: Readonly<Record<string, string>>;
  headers: Readonly<Record<string, string>>;
  start: number;
  end: number;
}) {
  const time = `${input.start};${input.end}`;
  const params = canonical(input.query ?? {});
  const headers = canonical(input.headers);
  const signKey = hmac("sha1", input.key.secretKey, time).toString("hex");
  const httpString = `${input.method.toLowerCase()}\n${input.pathname}\n${params.text}\n${headers.text}\n`;
  const signature = hmac("sha1", signKey, `sha1\n${time}\n${sha1(httpString)}\n`).toString("hex");
  return `q-sign-algorithm=sha1&q-ak=${input.key.secretId}&q-sign-time=${time}&q-key-time=${time}&q-header-list=${headers.list}&q-url-param-list=${params.list}&q-signature=${signature}`;
}

export function cosPostPolicy(key: CosKey, policy: string, start: number, end: number) {
  const time = `${start};${end}`;
  const signKey = hmac("sha1", key.secretKey, time).toString("hex");
  return {
    policy: Buffer.from(policy).toString("base64"),
    "q-sign-algorithm": "sha1",
    "q-ak": key.secretId,
    "q-key-time": time,
    "q-signature": hmac("sha1", signKey, sha1(policy)).toString("hex"),
  };
}

/** STS JSON uses TC3, distinct from COS object-request SHA1. */
export function stsAuthorization(key: CosKey, body: string, timestamp: number) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/sts/tc3_request`;
  const canonicalRequest = `POST\n/\n\ncontent-type:application/json\nhost:sts.tencentcloudapi.com\n\ncontent-type;host\n${hash(body)}`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonicalRequest)}`;
  const dateKey = hmac("sha256", `TC3${key.secretKey}`, date);
  const serviceKey = hmac("sha256", dateKey, "sts");
  const signingKey = hmac("sha256", serviceKey, "tc3_request");
  return `TC3-HMAC-SHA256 Credential=${key.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${hmac("sha256", signingKey, stringToSign).toString("hex")}`;
}

export const xmlEscape = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
/** Only fixed scalar protocol fields; no DTD, entity expansion, attributes or CDATA. */
export function xmlField(text: string, tag: string): string | undefined {
  if (/<!|<\?/u.test(text.replace(/^\s*<\?xml[^?]*\?>/u, "")))
    throw new Error("COS XML 形状不合格");
  const matches = [...text.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))];
  if (matches.length > 1) throw new Error("COS XML 字段重复");
  const raw = matches[0]?.[1];
  if (raw === undefined) return undefined;
  return raw.replace(
    /&(?:lt|gt|amp|quot|apos);/g,
    (s) => ({ "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" })[s]!,
  );
}
