// 六方法只负责平台协议，guard由原 withBeforeCall 外层统一执行一次。
import { failed, ok } from "../types.js";
import type { ProviderResult, WechatProvider, WechatTextScene } from "../types.js";
import { createWechatClient, JSON_REQUEST_BYTES } from "./client.js";
import type { WechatHttpOutcome, WechatRequest } from "./client.js";
import { createAccessTokenManager } from "./token.js";
import type { WechatTokenCache } from "./token.js";
import {
  imageResult,
  mapWechatFailure,
  nonempty,
  object,
  phoneResult,
  sessionResult,
  subscribeResult,
  textResult,
  tokenInvalid,
  unavailable,
} from "./mapping.js";
import type { WechatMethod } from "./mapping.js";

const METHOD_TIMEOUT_MS = 8_000;
const SCENES: Record<WechatTextScene, number> = { profile: 1, comment: 2, forum: 3, social: 4 };
type SuccessBody = Extract<WechatHttpOutcome, { ok: true }>["value"];
type ReleaseChannel = "develop" | "trial" | "release";
interface DriverConfig {
  appid: string;
  secret: string;
  releaseChannel: ReleaseChannel;
}
interface DriverDeps {
  cache: WechatTokenCache;
  now: () => Date;
  fetchImpl?: typeof fetch;
}
/** 取消只脱离共享get等待，不取消别的caller；失败仍原样抛，程序错误不降级。 */
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      resolve(undefined);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
const validScene = (value: WechatTextScene): boolean => Object.hasOwn(SCENES, value);
const inputText = (value: unknown): value is string =>
  nonempty(value) && Buffer.byteLength(value) <= JSON_REQUEST_BYTES;
const invalid = <T>(): Promise<ProviderResult<T>> =>
  Promise.resolve(failed("rejected", "微信请求参数不合格"));
function pageValid(value: string | undefined, query: boolean): boolean {
  return (
    value === undefined ||
    (inputText(value) &&
      !value.startsWith("/") &&
      !/[\\#]/.test(value) &&
      ![...value].some((char) => char.charCodeAt(0) < 32) &&
      !/^[a-z][a-z\d+.-]*:/i.test(value) &&
      (query || !value.includes("?")))
  );
}

export function createWechatDriver(
  config: DriverConfig,
  deps: DriverDeps,
): {
  provider: WechatProvider;
  close(): Promise<void>;
} {
  if (!["develop", "trial", "release"].includes(config.releaseChannel))
    throw new Error("微信版本配置不合格");
  const client = createWechatClient({ fetchImpl: deps.fetchImpl });
  const tokens = createAccessTokenManager(config, { client, cache: deps.cache, now: deps.now });
  const pending = new Map<AbortController, Promise<unknown>>();
  let closed = false,
    closing: Promise<void> | undefined;

  function run<T>(
    method: WechatMethod,
    spec: Omit<WechatRequest, "signal">,
    project: (value: SuccessBody) => ProviderResult<T>,
    needsToken = true,
  ): Promise<ProviderResult<T>> {
    if (closed) return Promise.resolve(unavailable());
    if (spec.body && Buffer.byteLength(JSON.stringify(spec.body)) > JSON_REQUEST_BYTES)
      return invalid();
    const controller = new AbortController();
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), METHOD_TIMEOUT_MS);
    timer.unref();
    const result = (async (): Promise<ProviderResult<T>> => {
      try {
        let token: string | undefined;
        if (needsToken) {
          const acquired = await wait(tokens.get(), signal);
          if (acquired === undefined || !acquired.ok || signal.aborted || closed)
            return unavailable();
          if (acquired.value.expiresAt <= deps.now().getTime()) return unavailable();
          token = acquired.value.token;
        }
        if (signal.aborted || closed) return unavailable();
        const response = await client.request({
          ...spec,
          signal,
          ...(token === undefined ? {} : { query: { ...spec.query, access_token: token } }),
        });
        if (signal.aborted || closed) return unavailable();
        if (!response.ok) {
          if (token !== undefined && tokenInvalid(response.code))
            await wait(tokens.invalidate(token), signal);
          return mapWechatFailure(method, response);
        }
        return project(response.value);
      } finally {
        clearTimeout(timer);
      }
    })();
    pending.set(controller, result);
    void result.then(
      () => pending.delete(controller),
      () => pending.delete(controller),
    );
    return result;
  }

  const provider: WechatProvider = {
    status: "wechat",
    configured: true,
    code2Session(input) {
      if (!inputText(input.code)) return invalid();
      return run(
        "code2Session",
        {
          path: "/sns/jscode2session",
          query: {
            appid: config.appid,
            secret: config.secret,
            js_code: input.code,
            grant_type: "authorization_code",
          },
        },
        (value) => sessionResult(value.json),
        false,
      );
    },
    getPhoneNumber(input) {
      if (!inputText(input.code)) return invalid();
      return run(
        "getPhoneNumber",
        { path: "/wxa/business/getuserphonenumber", body: { code: input.code } },
        (value) => phoneResult(value.json, config.appid),
      );
    },
    sendSubscribeMessage(input) {
      if (
        !inputText(input.openid) ||
        !inputText(input.templateId) ||
        !pageValid(input.page, true) ||
        !object(input.data) ||
        !Object.values(input.data).every((value) => typeof value === "string")
      )
        return invalid();
      const data = Object.fromEntries(
        Object.entries(input.data).map(([key, value]) => [key, { value }]),
      );
      return run(
        "sendSubscribeMessage",
        {
          path: "/cgi-bin/message/subscribe/send",
          body: {
            touser: input.openid,
            template_id: input.templateId,
            ...(input.page === undefined ? {} : { page: input.page }),
            data,
            miniprogram_state: { develop: "developer", trial: "trial", release: "formal" }[
              config.releaseChannel
            ],
            lang: "zh_CN",
          },
        },
        (value) => subscribeResult(value.json),
      );
    },
    createMiniProgramCode(input) {
      if (
        !/^[A-Za-z0-9!#$&'()*+,/:;=?@._~-]{1,32}$/.test(input.scene) ||
        !pageValid(input.page, false)
      )
        return invalid();
      return run(
        "createMiniProgramCode",
        {
          path: "/wxa/getwxacodeunlimit",
          body: {
            scene: input.scene,
            ...(input.page === undefined ? {} : { page: input.page }),
            check_path: true,
            env_version: config.releaseChannel,
          },
        },
        (value) =>
          value.json === null &&
          value.bytes.length > 0 &&
          (value.contentType === "image/png" || value.contentType === "image/jpeg")
            ? ok({ image: value.bytes, contentType: value.contentType })
            : unavailable(),
      );
    },
    checkText(input) {
      if (
        !inputText(input.openid) ||
        !validScene(input.scene) ||
        typeof input.content !== "string" ||
        Buffer.byteLength(input.content) > JSON_REQUEST_BYTES ||
        [...input.content].length > 2_500
      )
        return invalid();
      return run(
        "checkText",
        {
          path: "/wxa/msg_sec_check",
          body: {
            openid: input.openid,
            scene: SCENES[input.scene],
            version: 2,
            content: input.content,
          },
        },
        (value) => textResult(value.json),
      );
    },
    checkImage(input) {
      if (!inputText(input.openid) || !validScene(input.scene) || !inputText(input.mediaUrl))
        return invalid();
      let url: URL;
      try {
        url = new URL(input.mediaUrl);
      } catch {
        return invalid();
      }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash)
        return invalid();
      return run(
        "checkImage",
        {
          path: "/wxa/media_check_async",
          body: {
            openid: input.openid,
            scene: SCENES[input.scene],
            version: 2,
            media_type: 2,
            media_url: input.mediaUrl,
          },
        },
        (value) => imageResult(value.json),
      );
    },
  };
  return {
    provider,
    close() {
      if (!closing) {
        closed = true;
        for (const controller of pending.keys()) controller.abort();
        closing = (async () => {
          await Promise.allSettled([tokens.close(), client.close()]);
          await Promise.allSettled(pending.values());
        })();
      }
      return closing;
    },
  };
}
