import { createHash, randomBytes } from "node:crypto";
import COS from "cos-nodejs-sdk-v5";
import type { Secrets } from "./config.ts";
import { ProbeError } from "./errors.ts";
import { tc3Headers } from "./tc3.ts";

export type Credentials = {
  TmpSecretId: string;
  TmpSecretKey: string;
  SecurityToken: string;
  StartTime: number;
  ExpiredTime: number;
  Bucket: string;
  Region: string;
  Key: string;
};
export type Provider = {
  prepareFakeUpload?(key: string, size: number): void;
  login(code: string): Promise<{ openid: string; sessionKey: string }>;
  phone(code: string): Promise<string>;
  credentials(key: string): Promise<Credentials>;
  objectSize(key: string): Promise<number>;
  download(sizeMb: number): Promise<{ url: string; size: number }>;
};
export function uploadPolicy(secrets: Pick<Secrets, "COS_BUCKET" | "COS_REGION">, key: string) {
  if (!/^incoming\/[a-f0-9]{32}\/source\.mp4$/.test(key)) throw new ProbeError("OBJECT_SCOPE");
  const appid = secrets.COS_BUCKET.split("-").at(-1)!;
  const prefix = key.slice(0, key.lastIndexOf("/") + 1);
  return {
    version: "2.0",
    statement: [
      {
        effect: "allow",
        action: [
          "name/cos:PutObject",
          "name/cos:InitiateMultipartUpload",
          "name/cos:UploadPart",
          "name/cos:CompleteMultipartUpload",
          "name/cos:AbortMultipartUpload",
          "name/cos:ListParts",
        ],
        resource: [
          `qcs::cos:${secrets.COS_REGION}:uid/${appid}:prefix//${appid}/${secrets.COS_BUCKET}/${prefix}*`,
        ],
      },
      {
        // ListMultipartUploads is bucket-scoped; the SDK uses Prefix=Key. Restrict the listing too.
        effect: "allow",
        action: ["name/cos:ListMultipartUploads"],
        resource: [
          `qcs::cos:${secrets.COS_REGION}:uid/${appid}:prefix//${appid}/${secrets.COS_BUCKET}/*`,
        ],
        condition: { string_equal: { "cos:prefix": [key] } },
      },
    ],
  };
}
export function createFakeProvider(): Provider & { objects: Map<string, number> } {
  const objects = new Map<string, number>();
  return {
    objects,
    prepareFakeUpload(key, size) {
      objects.set(key, size);
    },
    async login(code) {
      return { openid: `fake-openid-${code}`, sessionKey: `fake-session-key-${code}` };
    },
    async phone(code) {
      return code === "second-phone" ? "13900002222" : "13800001111";
    },
    async credentials(key) {
      const now = Math.floor(Date.now() / 1000);
      return {
        TmpSecretId: "fake-temporary-id",
        TmpSecretKey: "fake-temporary-key",
        SecurityToken: "fake-temporary-token",
        StartTime: now,
        ExpiredTime: now + 1800,
        Bucket: "fake-bucket-123456",
        Region: "ap-guangzhou",
        Key: key,
      };
    },
    async objectSize(key) {
      const size = objects.get(key);
      if (size === undefined) throw new ProbeError("OBJECT_NOT_FOUND", 404);
      return size;
    },
    async download(sizeMb) {
      return { url: `https://fixtures.example.invalid/${sizeMb}.mp4`, size: sizeMb * 1_000_000 };
    },
  };
}
export type Fetcher = typeof fetch;
type RemoteResponse = {
  errcode?: unknown;
  access_token?: unknown;
  expires_in?: unknown;
  openid?: unknown;
  session_key?: unknown;
  phone_info?: { purePhoneNumber?: unknown; watermark?: { appid?: unknown } };
  Response?: {
    Error?: unknown;
    ExpiredTime: number;
    Credentials?: { TmpSecretId: string; TmpSecretKey: string; Token: string };
  };
};
async function remoteJson(
  fetcher: Fetcher,
  url: string,
  init?: RequestInit,
): Promise<RemoteResponse> {
  try {
    const response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw 0;
    const data = (await response.json()) as RemoteResponse;
    if (data.errcode)
      throw new ProbeError(
        Number.isInteger(data.errcode) ? `WECHAT_${data.errcode}` : "WECHAT_FAILED",
        502,
      );
    return data;
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError("PROVIDER_UNAVAILABLE", 502);
  }
}
export function createRealProvider(secrets: Secrets, fetcher: Fetcher = fetch): Provider {
  const cos = new COS({
    SecretId: secrets.COS_SECRET_ID,
    SecretKey: secrets.COS_SECRET_KEY,
    Timeout: 120_000,
  });
  let cached: { value: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;
  const accessToken = async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    pending ??= (async () => {
      const data = await remoteJson(fetcher, "https://api.weixin.qq.com/cgi-bin/stable_token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credential",
          appid: secrets.WECHAT_APP_ID,
          secret: secrets.WECHAT_APP_SECRET,
          force_refresh: false,
        }),
      });
      if (
        typeof data.access_token !== "string" ||
        typeof data.expires_in !== "number" ||
        !Number.isFinite(data.expires_in)
      )
        throw new ProbeError("WECHAT_INVALID_RESPONSE", 502);
      cached = {
        value: data.access_token,
        expiresAt: Date.now() + Math.max(0, data.expires_in - 60) * 1000,
      };
      return cached.value;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
  const sizeOf = (key: string) =>
    new Promise<number>((resolve, reject) => {
      cos.headObject(
        { Bucket: secrets.COS_BUCKET, Region: secrets.COS_REGION, Key: key },
        (error, data) => {
          const size = Number(data?.headers?.["content-length"]);
          if (error || !Number.isSafeInteger(size) || size < 1)
            reject(new ProbeError("OBJECT_UNAVAILABLE", 502));
          else resolve(size);
        },
      );
    });
  return {
    async login(code) {
      const params = new URLSearchParams({
        appid: secrets.WECHAT_APP_ID,
        secret: secrets.WECHAT_APP_SECRET,
        js_code: code,
        grant_type: "authorization_code",
      });
      const data = await remoteJson(
        fetcher,
        `https://api.weixin.qq.com/sns/jscode2session?${params}`,
      );
      if (typeof data.openid !== "string" || typeof data.session_key !== "string")
        throw new ProbeError("WECHAT_INVALID_RESPONSE", 502);
      return { openid: data.openid, sessionKey: data.session_key };
    },
    async phone(code) {
      const token = await accessToken();
      const data = await remoteJson(
        fetcher,
        `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        },
      );
      const phone = data.phone_info?.purePhoneNumber;
      if (
        typeof phone !== "string" ||
        !/^1[3-9]\d{9}$/.test(phone) ||
        data.phone_info?.watermark?.appid !== secrets.WECHAT_APP_ID
      )
        throw new ProbeError("WECHAT_PHONE_INVALID", 502);
      return phone;
    },
    async credentials(key) {
      const now = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({
        Name: "lyxxprobe",
        DurationSeconds: 1800,
        Policy: encodeURIComponent(JSON.stringify(uploadPolicy(secrets, key))),
      });
      const data = await remoteJson(fetcher, "https://sts.tencentcloudapi.com", {
        method: "POST",
        headers: {
          ...tc3Headers(secrets.COS_SECRET_ID, secrets.COS_SECRET_KEY, body, now),
          "X-TC-Region": secrets.COS_REGION,
        },
        body,
      });
      const result = data.Response;
      if (
        result?.Error ||
        !result?.Credentials ||
        !Number.isInteger(result.ExpiredTime) ||
        result.ExpiredTime <= now ||
        result.ExpiredTime > Math.floor(Date.now() / 1000) + 1800
      )
        throw new ProbeError("STS_FAILED", 502);
      const { TmpSecretId, TmpSecretKey, Token } = result.Credentials;
      if (![TmpSecretId, TmpSecretKey, Token].every((v) => typeof v === "string" && v))
        throw new ProbeError("STS_INVALID_RESPONSE", 502);
      return {
        TmpSecretId,
        TmpSecretKey,
        SecurityToken: Token,
        StartTime: now,
        ExpiredTime: result.ExpiredTime,
        Bucket: secrets.COS_BUCKET,
        Region: secrets.COS_REGION,
        Key: key,
      };
    },
    objectSize: sizeOf,
    async download(sizeMb) {
      const Key = `${secrets.COS_TEST_PREFIX}${sizeMb}mb.mp4`;
      const size = await sizeOf(Key);
      const url = await new Promise<string>((resolve, reject) =>
        cos.getObjectUrl(
          {
            Bucket: secrets.COS_BUCKET,
            Region: secrets.COS_REGION,
            Key,
            Sign: true,
            Expires: 900,
            Protocol: "https:",
          },
          (error, data) => (error ? reject(new ProbeError("SIGN_FAILED", 502)) : resolve(data.Url)),
        ),
      );
      return { url, size };
    },
  };
}
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const opaque = (bytes = 16) => randomBytes(bytes).toString("base64url");
