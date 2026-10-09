// 腾讯官方 signature-process-demo/services/sms/signature-v3/nodejs/demo.js，TC3，2021-01-11。
import { createHash, createHmac } from "node:crypto";

export const SMS_HOST = "sms.tencentcloudapi.com";
export const SMS_CONTENT_TYPE = "application/json; charset=utf-8";
export function signSms(input: {
  secretId: string;
  secretKey: string;
  timestamp: number;
  payload: string;
}): string {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const hmac = (key: string | Buffer, text: string) =>
    createHmac("sha256", key).update(text).digest();
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/sms/tc3_request`;
  const headers = "content-type;host";
  const canonical = `POST\n/\n\ncontent-type:${SMS_CONTENT_TYPE}\nhost:${SMS_HOST}\n\n${headers}\n${hash(input.payload)}`;
  const toSign = `TC3-HMAC-SHA256\n${input.timestamp}\n${scope}\n${hash(canonical)}`;
  const signature = hmac(
    hmac(hmac(hmac(`TC3${input.secretKey}`, date), "sms"), "tc3_request"),
    toSign,
  ).toString("hex");
  return `TC3-HMAC-SHA256 Credential=${input.secretId}/${scope}, SignedHeaders=${headers}, Signature=${signature}`;
}
