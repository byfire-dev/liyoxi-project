// 商家端各域的服务在接口进程里的装配点（W1-04）：一个运行时建一次，鉴权链的中间件与商家端的处理器都从这里取。
//
//   const { identity, tenant, docs } = merchantServicesOf(c.var.runtime);
//
// 进程运行时给事务入口、时钟、配置、装配结果、出站事件与十二个 Provider（W0-22；内核小修补接齐了后两样）；
// 状态迁移运行时上还没有，在这里按它们建。
//   微信能力 取运行时上的 providers.wechat：local、test 是本地的假微信，用例经 createRuntime 的 providers 换成替身；
//            stg、prod 在真实驱动到位之前是“未配置”的那一个，调用即回未配置，两条登录回 503 WECHAT_UNAVAILABLE，不崩溃。
//   密钥环   登录要算手机号的盲索引与密文。用到时才从环境变量里的密钥文件造（security.loadKeyring）：
//            只校验会话的请求用不到它，没配密钥的进程照样起得来、验得了会话。
// 用例与本地的演示装配经 provideMerchantDeps 换成测试密钥环与 appid（要在第一次取服务之前给）。
import { createFlow, createIdentity, createTenant, security } from "@liyoxi/services";
import type { Docs, Identity, Runtime, Tenant, WechatProvider } from "@liyoxi/services";

import { docsOf } from "../routes/agreements.js";

export interface MerchantServices {
  readonly docs: Docs;
  readonly tenant: Tenant;
  readonly identity: Identity;
}

export interface MerchantDeps {
  readonly keyring?: security.Keyring;
  /** 另给一个微信能力顶掉运行时上的那一个；一般不用给：用例的替身经 createRuntime 的 providers 给 */
  readonly wechat?: Pick<WechatProvider, "code2Session" | "getPhoneNumber">;
  /** 本小程序的 appid；不给即占位值 */
  readonly appid?: string;
}

/**
 * 占位的 appid：真实的 AppID 随微信的真实驱动一起配置进来（E2；G2-D）。在那之前本地与测试只有假微信，
 * 微信身份行与同意记录里记的是这个占位值（留桩 m2-identity-login-wechat-fake.md）。
 */
export const PLACEHOLDER_WEAPP_APPID = "wx0000000000000000";

const given = new WeakMap<Runtime, MerchantDeps>();
const built = new WeakMap<Runtime, MerchantServices>();

/** 给这个运行时换上密钥环、微信能力（替身）。要在第一次 merchantServicesOf 之前调；之后再调即抛错 */
export function provideMerchantDeps(runtime: Runtime, deps: MerchantDeps): void {
  if (built.has(runtime)) throw new TypeError("商家端的服务已经建好了：依赖要在建应用之前给");
  given.set(runtime, { ...given.get(runtime), ...deps });
}

export function merchantServicesOf(runtime: Runtime): MerchantServices {
  const existing = built.get(runtime);
  if (existing !== undefined) return existing;

  const deps = given.get(runtime) ?? {};
  const { tx, clock, assembly, config, events } = runtime;
  const flow = createFlow({ assembly, clock, events });
  const docs = docsOf(runtime);
  const tenant = createTenant({ tx, clock, flow, assembly });
  let keyring = deps.keyring;
  const identity = createIdentity({
    tx,
    clock,
    flow,
    events,
    assembly,
    docs,
    tenant,
    config,
    keyring: () => (keyring ??= security.loadKeyring(runtime.env)),
    wechat: deps.wechat ?? runtime.providers.wechat,
    appid: deps.appid ?? PLACEHOLDER_WEAPP_APPID,
  });
  const services: MerchantServices = { docs, tenant, identity };
  built.set(runtime, services);
  return services;
}
