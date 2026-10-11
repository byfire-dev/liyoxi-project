import { createHmac } from "node:crypto";

type CallbackConfig = Readonly<{ origin: string; key: string }>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function origin(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 266 ||
    [...value].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 32 || code >= 127;
    })
  )
    return undefined;
  const matched = /^https:\/\/([a-z0-9.-]+)(?::443)?\/?$/.exec(value);
  if (!matched) return undefined;
  const host = matched[1]!,
    labels = host.split(".");
  if (
    host.length > 253 ||
    labels.length < 2 ||
    !/[a-z]/.test(labels.at(-1)!) ||
    ["local", "localhost", "internal", "onion", "invalid", "test"].includes(labels.at(-1)!) ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return undefined;
  try {
    const parsed = new URL(value);
    return parsed.hostname === host ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/** 构造时只做纯校验和复制；不探测 DNS，也不声称该域名已部署或可达。 */
export function prepareAsrCallback(value: unknown): CallbackConfig | undefined {
  if (value === undefined) return undefined;
  if (
    !record(value) ||
    Reflect.ownKeys(value).length !== 2 ||
    !Object.hasOwn(value, "origin") ||
    !Object.hasOwn(value, "key")
  )
    throw new TypeError("录音转写回调配置不合法");
  const canonical = origin(value.origin),
    key = value.key;
  if (
    !canonical ||
    typeof key !== "string" ||
    Buffer.byteLength(key) < 32 ||
    Buffer.byteLength(key) > 256
  )
    throw new TypeError("录音转写回调配置不合法");
  return Object.freeze({ origin: canonical, key });
}

/** undefined 表示双方省略；null 表示半配或上下文非法，禁止静默降级。 */
export function asrCallbackUrl(
  config: CallbackConfig | undefined,
  context: unknown,
): string | null | undefined {
  if (config === undefined && context === undefined) return undefined;
  if (
    !config ||
    !record(context) ||
    Reflect.ownKeys(context).length !== 1 ||
    !Object.hasOwn(context, "mediaJobId")
  )
    return null;
  const id = context.mediaJobId;
  if (typeof id !== "string" || id.length !== 36 || !uuid.test(id)) return null;
  const sig = createHmac("sha256", config.key).update(id).digest("base64url");
  const url = `${config.origin}/api/v1/hooks/asr/media-jobs/${id}?sig=${sig}`;
  return Buffer.byteLength(url) <= 2048 ? url : null;
}
