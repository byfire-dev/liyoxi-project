import { UPLOAD_LIMITS } from "@liyoxi/shared/uploads";
// m08 3.1：七块独立取数；失败只降级对应块。此读侧不更新协议指纹与最后门店。
import { BOOTSTRAP_BLOCKS, FLAGS, MaintenanceNoticeSchema } from "@liyoxi/contract";
import type { Bootstrap } from "@liyoxi/contract";
import { AppError, subscribePlanOf } from "../kernel/index.js";
import type { FlagContext } from "../config/index.js";
import type { IdentityReadDeps } from "./read.types.js";

type Block = (typeof BOOTSTRAP_BLOCKS)[number];
type FlagBlock = Pick<
  Bootstrap,
  | "minClientVersion"
  | "flags"
  | "uploadLimits"
  | "download"
  | "support"
  | "subscribeCooldownDays"
  | "subscribeMaxPerAsk"
>;
interface Blocks {
  flags: FlagBlock;
  versions: Bootstrap["versions"];
  consents: Bootstrap["pendingConsents"];
  subscribe: Bootstrap["subscribePlan"];
  copy: Bootstrap["copy"];
  notice: Bootstrap["notice"];
  context: Bootstrap["context"];
}
export type BootstrapLoaders = { [K in Block]: () => Promise<Blocks[K]> };
export interface BootstrapInput extends Omit<FlagContext, "entityId"> {
  readonly merchantUserId: string | null;
  readonly storeId: string | null;
}

export function bootstrapDefaults(loggedIn: boolean): Blocks {
  return {
    flags: {
      minClientVersion: "0.0.0",
      flags: Object.fromEntries(
        FLAGS.filter((f) => f.exposedTo === "client").map((f) => [f.key, f.defaultValue]),
      ),
      uploadLimits: {
        weappVideoMaxMb: UPLOAD_LIMITS.weappVideoDefaultMaxMb,
        imageMaxMb: UPLOAD_LIMITS.imageMaxMb,
      },
      download: { weappSaveMode: "temp" },
      support: { mode: "contact", corpId: null, kfUrl: null },
      subscribeCooldownDays: 7,
      subscribeMaxPerAsk: 3,
    },
    versions: { dict: {}, site: {}, agreement: "" },
    consents: loggedIn ? [] : null,
    subscribe: loggedIn ? [] : null,
    copy: {},
    notice: null,
    context: null,
  };
}

/** 单独导出装配函数，让全块失败与每块失败可用替身精确覆盖。 */
export async function assembleBootstrap(
  now: Date,
  loggedIn: boolean,
  loaders: BootstrapLoaders,
): Promise<Bootstrap> {
  const fallback = bootstrapDefaults(loggedIn);
  const failed = new Set<Block>();
  async function take<K extends Block>(key: K): Promise<Blocks[K]> {
    try {
      return await loaders[key]();
    } catch {
      failed.add(key);
      return fallback[key];
    }
  }
  const [flags, versions, pendingConsents, subscribePlan, copy, notice, context] =
    await Promise.all([
      take("flags"),
      take("versions"),
      take("consents"),
      take("subscribe"),
      take("copy"),
      take("notice"),
      take("context"),
    ]);
  if (failed.size === BOOTSTRAP_BLOCKS.length) throw new AppError("INTERNAL");
  return {
    serverTime: now.toISOString(),
    ...flags,
    versions,
    pendingConsents,
    subscribePlan,
    copy,
    notice,
    context,
    degraded: BOOTSTRAP_BLOCKS.filter((key) => failed.has(key)),
  };
}

export function bootstrap(deps: IdentityReadDeps, input: BootstrapInput): Promise<Bootstrap> {
  const { config, tx, tenant, docs } = deps;
  const loggedIn = input.merchantUserId !== null;
  // 只把校验过的主体用于白名单求值；无权访问的 X-Store-Id 等同没带主体。
  const flagContext = async (): Promise<FlagContext> => {
    const entityId =
      input.merchantUserId === null || input.storeId === null
        ? null
        : await tx.run(async (db) => {
            if (input.storeId !== null)
              return (
                (
                  await tenant.resolveMembership(db, {
                    merchantUserId: input.merchantUserId!,
                    storeId: input.storeId,
                  })
                )?.entityId ?? null
              );
            return null;
          });
    return {
      platform: input.platform,
      clientVersion: input.clientVersion,
      envVersion: input.envVersion,
      entityId,
    };
  };
  // 懒建，匿名不碰个人数据；失败分别落在 flags / notice 的降级路径。
  let contextPromise: Promise<FlagContext> | undefined;
  const contextOf = () => (contextPromise ??= flagContext());
  return assembleBootstrap(deps.clock.now(), loggedIn, {
    flags: async () => {
      const context = await contextOf();
      const [
        flags,
        minClientVersion,
        weappVideoMaxMb,
        weappSaveMode,
        subscribeCooldownDays,
        subscribeMaxPerAsk,
      ] = await Promise.all([
        config.flags.forClient(context),
        config.flags.minClientVersion(context),
        config.params.get("upload.weapp_video_max_mb"),
        config.params.get("download.weapp_save_mode"),
        config.params.get("notify.wx.ask_cooldown_days"),
        config.params.get("notify.wx.max_per_ask"),
      ]);
      return {
        flags,
        minClientVersion,
        uploadLimits: { weappVideoMaxMb, imageMaxMb: UPLOAD_LIMITS.imageMaxMb },
        download: { weappSaveMode },
        support: { mode: "contact", corpId: null, kfUrl: null },
        subscribeCooldownDays,
        subscribeMaxPerAsk,
      };
    },
    versions: async () => {
      const versions = await config.dicts.versions();
      const dict: Record<string, number> = {};
      for (const [key, version] of Object.entries(versions))
        if ((await config.dicts.list(key)).isMerchantVisible) dict[key] = version;
      const site: Record<string, number> = {};
      for (const key of ["mall", "home_recommend"] as const) {
        const revision = await config.siteConfig.published(key);
        if (revision !== null) site[key] = revision.revNo;
      }
      const stamps = await tx.run((db) => docs.consentStamps(db));
      return { dict, site, agreement: stamps.all };
    },
    consents: () =>
      input.merchantUserId === null
        ? Promise.resolve(null)
        : tx.run((db) => docs.pendingConsents(db, input.merchantUserId!)),
    subscribe: async () => {
      if (!loggedIn) return null;
      const context = await contextOf();
      return tx.run((db) =>
        subscribePlanOf(deps.assembly)(db, {
          platform: context.platform ?? "unknown",
          ...(context.clientVersion == null ? {} : { clientVersion: context.clientVersion }),
          entityId: context.entityId ?? null,
          now: deps.clock.now(),
        }),
      );
    },
    copy: async () => ({}),
    notice: async () => {
      const value = await config.flags.value("ops.maintenance_notice", await contextOf());
      return value === null ? null : MaintenanceNoticeSchema.parse(value);
    },
    context: () =>
      input.merchantUserId === null
        ? Promise.resolve(null)
        : tx.run(async (db) => ({
            storeId:
              (await tenant.membershipBriefs(db, input.merchantUserId!))[0]?.lastStoreId ?? null,
          })),
  });
}
