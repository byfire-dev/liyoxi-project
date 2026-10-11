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
import {
  createFlow,
  createIdentity,
  createTenant,
  createProfile,
  createStoreProfileAssetInitializer,
  createSla,
  currentSessionOpenid,
  assertCurrentSession,
  security,
  media,
  AppError,
} from "@liyoxi/services";
import type { Docs, Identity, Runtime, Tenant, Profile, WechatProvider } from "@liyoxi/services";

import { docsOf } from "./docs.js";

export interface MerchantServices {
  readonly docs: Docs;
  readonly tenant: Tenant;
  readonly identity: Identity;
  readonly profile: Profile;
}

export interface MerchantDeps {
  readonly keyring?: security.Keyring;
  /** 另给一个微信能力顶掉运行时上的那一个；一般不用给：用例的替身经 createRuntime 的 providers 给 */
  readonly wechat?: Pick<WechatProvider, "code2Session" | "getPhoneNumber">;
  /** 本小程序的 appid；不给用运行时配置，本地未配置时用占位值 */
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
  const tenant: Tenant = createTenant({
    tx,
    clock,
    flow,
    assembly,
    events,
    readMemberAssetCounts: media.readMemberAssetCounts,
    archiveTimers: runtime.timers,
    storeCreation: {
      async assertSession(handle, principal, now) {
        await assertCurrentSession(handle, principal, now, appid);
      },
      async validateBasics(ctx, principal, body) {
        const membership = await tx.run((handle) =>
          tenant.resolveMembership(handle, {
            merchantUserId: principal.merchantUserId,
            storeId: ctx.storeId!,
          }),
        );
        if (!membership || membership.entityId !== ctx.entityId) throw new AppError("NOT_A_MEMBER");
        if (membership.role !== "owner") throw new AppError("ROLE_FORBIDDEN");
        if (membership.storeMode !== "active") throw new AppError("STORE_ARCHIVED");
        try {
          await profile.validateStoreBasics(
            { ctx, principal, membership },
            {
              draft: false,
              lockVersion: 0,
              storeName: body.name,
              industryCode: body.industryCode,
              categoryCode: body.categoryCode,
              address: {
                provinceCode: null,
                cityCode: null,
                districtCode: null,
                zoneCode: null,
                detail: body.addressDetail,
                poiName: null,
                latitude: null,
                longitude: null,
              },
            },
          );
        } catch (error) {
          if (error instanceof AppError) {
            if (error.code === "CONTENT_REJECTED") {
              const details = error.details;
              const fields =
                details && typeof details === "object" && "fields" in details
                  ? details.fields
                  : undefined;
              if (
                Array.isArray(fields) &&
                fields.every((field) => field === "storeName" || field === "address.detail")
              )
                throw new AppError("CONTENT_REJECTED", {
                  details: {
                    fields: fields.map((field) =>
                      field === "storeName" ? "name" : "addressDetail",
                    ),
                  },
                });
              throw new AppError("PROVIDER_UNAVAILABLE");
            }
            if (
              [
                "VALIDATION_FAILED",
                "DICT_ITEM_DISABLED",
                "INDUSTRY_NOT_OPEN",
                "PROVIDER_UNAVAILABLE",
                "SESSION_INVALID",
              ].includes(error.code)
            )
              throw error;
          }
          throw new AppError("PROVIDER_UNAVAILABLE");
        }
      },
      async initialize(handle, ctx, principal, input) {
        const plan = await initializer.prepare(handle, ctx, principal, input);
        await initializer.apply(handle, plan);
      },
    },
    invitations: {
      keyring: () => (keyring ??= security.loadKeyring(runtime.env)),
      timers: runtime.timers,
      accept: {
        assertSession: (handle, principal, now) =>
          assertCurrentSession(handle, principal, now, appid),
        async checkName(principal, content) {
          const openid = await tx.run((handle) => currentSessionOpenid(handle, principal, appid));
          const result = await runtime.providers.wechat
            .checkText({ openid, scene: "profile", content })
            .catch(() => {
              throw new AppError("PROVIDER_UNAVAILABLE");
            });
          if (!result.ok) throw new AppError("PROVIDER_UNAVAILABLE");
          if (result.value.verdict !== "pass")
            throw new AppError("CONTENT_REJECTED", { details: { fields: ["displayName"] } });
        },
      },
      async checkRemark(principal, content) {
        const openid = await tx.run((handle) => currentSessionOpenid(handle, principal, appid));
        const result = await runtime.providers.wechat
          .checkText({ openid, scene: "profile", content })
          .catch(() => {
            throw new AppError("PROVIDER_UNAVAILABLE");
          });
        if (!result.ok) throw new AppError("PROVIDER_UNAVAILABLE");
        if (result.value.verdict !== "pass")
          throw new AppError("CONTENT_REJECTED", { details: { fields: ["remarkName"] } });
      },
    },
  });
  let keyring = deps.keyring;
  const appid = deps.appid ?? runtime.env.WECHAT?.appid ?? PLACEHOLDER_WEAPP_APPID;
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
    appid,
  });
  const profile: Profile = createProfile({
    tx,
    clock,
    assembly,
    tenant,
    approval: runtime.approval,
    events,
    media: runtime.media,
    keyring: () => (keyring ??= security.loadKeyring(runtime.env)),
    wechat: runtime.providers.wechat,
    currentOpenid: (principal) =>
      tx.run((handle) => currentSessionOpenid(handle, principal, appid)),
  });
  const services: MerchantServices = { docs, tenant, identity, profile };
  const initializer = createStoreProfileAssetInitializer({
    clock,
    tenant,
    media: runtime.media,
    expectedAppid: appid,
    sla: createSla({ clock, assembly }),
    timers: runtime.timers,
  });
  built.set(runtime, services);
  return services;
}
