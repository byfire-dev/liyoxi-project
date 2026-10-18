// Tencent TC3固定service=ses；沿已有ASR模式，不接受可变host/service。
import { createHash, createHmac } from "node:crypto";

export const MAIL_HOST = "ses.tencentcloudapi.com";
export const MAIL_CONTENT_TYPE = "application/json; charset=utf-8";
export function signMail(input: {
  secretId: string;
  secretKey: string;
  timestamp: number;
  payload: string;
}): string {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const hmac = (key: string | Buffer, text: string) =>
    createHmac("sha256", key).update(text).digest();
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/ses/tc3_request`,
    headers = "content-type;host";
  const canonical = `POST\n/\n\ncontent-type:${MAIL_CONTENT_TYPE}\nhost:${MAIL_HOST}\n\n${headers}\n${hash(input.payload)}`;
  const signature = hmac(
    hmac(hmac(hmac(`TC3${input.secretKey}`, date), "ses"), "tc3_request"),
    `TC3-HMAC-SHA256\n${input.timestamp}\n${scope}\n${hash(canonical)}`,
  ).toString("hex");
  return `TC3-HMAC-SHA256 Credential=${input.secretId}/${scope}, SignedHeaders=${headers}, Signature=${signature}`;
}
