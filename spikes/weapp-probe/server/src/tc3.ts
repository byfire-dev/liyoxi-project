import { createHash, createHmac } from "node:crypto";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) =>
  createHmac("sha256", key).update(value).digest();
// Tencent Cloud API v3; signed headers and actual Content-Type are identical.
export function tc3Headers(
  secretId: string,
  secretKey: string,
  body: string,
  timestamp: number,
  service = "sts",
  action = "GetFederationToken",
) {
  const host = `${service}.tencentcloudapi.com`;
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/${service}/tc3_request`;
  const headers = "content-type;host;x-tc-action";
  const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n\n${headers}\n${sha256(body)}`;
  const key = hmac(hmac(hmac(`TC3${secretKey}`, date), service), "tc3_request");
  const signature = hmac(
    key,
    `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonical)}`,
  ).toString("hex");
  return {
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${headers}, Signature=${signature}`,
    "Content-Type": "application/json; charset=utf-8",
    Host: host,
    "X-TC-Action": action,
    "X-TC-Version": "2018-08-13",
    "X-TC-Timestamp": String(timestamp),
  };
}
