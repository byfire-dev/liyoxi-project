// stable_token普通模式；缓存只保官方token事实，不承担认证/业务持久化。
import type { Redis } from "ioredis";
import { failed, ok } from "../types.js";
import type { ProviderSuccess } from "../types.js";
import type { WechatClient, WechatHttpFailure } from "./client.js";

export const CACHE_TIMEOUT_MS = 200;
export const TOKEN_SAFETY_MS = 60_000;
const MAX_TOKEN_BYTES = 2_048;
export interface TokenRecord {
  token: string;
  expiresAt: number;
}
export interface WechatTokenCache {
  get(appid: string): Promise<TokenRecord | null>;
  put(appid: string, value: TokenRecord, ttlMs: number): Promise<void>;
  deleteIfValue(appid: string, token: string): Promise<void>;
}
export type TokenResult = ProviderSuccess<TokenRecord> | WechatHttpFailure;
function valid(value: unknown): value is TokenRecord {
  if (value === null || typeof value !== "object") return false;
  const row = value as Partial<TokenRecord>;
  return (
    typeof row.token === "string" &&
    row.token.length > 0 &&
    Buffer.byteLength(row.token) <= MAX_TOKEN_BYTES &&
    typeof row.expiresAt === "number" &&
    Number.isSafeInteger(row.expiresAt) &&
    row.expiresAt > 0
  );
}
const key = (appid: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(appid)) throw new Error("微信AppID缓存键不合格");
  return `wx:token:${appid}`;
};
/** 借用已带ioredis前缀的client；不创建连接，不关闭父client。 */
export function createRedisTokenCache(
  redis: Pick<Redis, "get" | "set" | "eval"> & { options: { keyPrefix?: string } },
  prefix: string,
): WechatTokenCache {
  if (!/^lyx:[A-Za-z0-9:_-]+:$/.test(prefix) || redis.options.keyPrefix !== prefix)
    throw new Error("微信缓存前缀不合格");
  return {
    async get(appid) {
      const raw = await redis.get(key(appid));
      if (raw === null || Buffer.byteLength(raw) > 4_096) return null;
      try {
        const value: unknown = JSON.parse(raw);
        return valid(value) ? value : null;
      } catch {
        return null;
      }
    },
    async put(appid, value, ttlMs) {
      if (!valid(value) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0)
        throw new Error("微信缓存记录不合格");
      await redis.set(key(appid), JSON.stringify(value), "PX", ttlMs);
    },
    async deleteIfValue(appid, token) {
      await redis.eval(
        `local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local ok,v=pcall(cjson.decode,raw); if ok and type(v)=='table' and v.token==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`,
        1,
        key(appid),
        token,
      );
    },
  };
}
export interface AccessTokenManager {
  get(): Promise<TokenResult>;
  invalidate(token: string): Promise<void>;
  close(): Promise<void>;
}
export function createAccessTokenManager(
  config: { appid: string; secret: string },
  deps: { client: WechatClient; cache: WechatTokenCache; now: () => Date; cacheTimeoutMs?: number },
): AccessTokenManager {
  key(config.appid);
  if (typeof config.secret !== "string" || config.secret.length === 0)
    throw new Error("微信AppSecret未配置");
  const budget = deps.cacheTimeoutMs ?? CACHE_TIMEOUT_MS;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > CACHE_TIMEOUT_MS)
    throw new Error("微信缓存预算不合格");
  const lifetime = new AbortController();
  let closed = false,
    local: TokenRecord | undefined,
    inFlight: Promise<TokenResult> | undefined;
  const unavailable = (): WechatHttpFailure => failed("unavailable", "微信接口调用凭据暂不可用");
  const fresh = (record: unknown): record is TokenRecord =>
    valid(record) && record.expiresAt - deps.now().getTime() > TOKEN_SAFETY_MS;
  async function cache<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (closed) return undefined;
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: T | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lifetime.signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => done(undefined);
      const timer = setTimeout(abort, budget);
      timer.unref();
      lifetime.signal.addEventListener("abort", abort, { once: true });
      try {
        operation().then(done, () => done(undefined));
      } catch {
        done(undefined);
      }
    });
  }
  async function acquire(): Promise<TokenResult> {
    const stored = await cache(() => deps.cache.get(config.appid));
    if (closed) return unavailable();
    if (fresh(stored)) {
      local = { ...stored };
      return ok({ ...stored });
    }
    const started = deps.now().getTime();
    const response = await deps.client.request({
      path: "/cgi-bin/stable_token",
      body: {
        grant_type: "client_credential",
        appid: config.appid,
        secret: config.secret,
        force_refresh: false,
      },
      signal: lifetime.signal,
    });
    if (closed) return unavailable();
    // token配置/平台拒绝不是商家的js_code错误：业务口返回unavailable，保留私有数字码。
    if (!response.ok)
      return {
        ...unavailable(),
        ...(response.code === undefined ? {} : { code: response.code }),
        ...(response.status === undefined ? {} : { status: response.status }),
      };
    const json = response.value.json;
    const seconds = json?.["expires_in"];
    if (
      typeof seconds !== "number" ||
      !Number.isSafeInteger(seconds) ||
      seconds <= 0 ||
      seconds > 7_200
    )
      return unavailable();
    const record = { token: json?.["access_token"], expiresAt: started + seconds * 1_000 };
    if (!valid(record) || record.expiresAt <= deps.now().getTime()) return unavailable();
    const ttl = record.expiresAt - deps.now().getTime() - TOKEN_SAFETY_MS;
    if (ttl > 0) {
      local = { ...record };
      await cache(() => deps.cache.put(config.appid, record, ttl));
    }
    if (closed) return unavailable();
    return ok({ ...record });
  }
  return {
    get() {
      if (closed) return Promise.resolve(unavailable());
      if (fresh(local)) return Promise.resolve(ok({ ...local }));
      if (inFlight) return inFlight;
      const current = acquire();
      inFlight = current;
      void current.then(
        () => {
          if (inFlight === current) inFlight = undefined;
        },
        () => {
          if (inFlight === current) inFlight = undefined;
        },
      );
      return current;
    },
    async invalidate(token) {
      if (local?.token === token) local = undefined;
      await cache(() => deps.cache.deleteIfValue(config.appid, token));
    },
    async close() {
      closed = true;
      local = undefined;
      lifetime.abort();
      await inFlight;
    },
  };
}
