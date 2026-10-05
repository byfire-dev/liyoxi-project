// 统一的配置缓存（W0-18）。依据：D6 第 4.6 节；任务书第 10 节第 5 项。
//
// 配置全量放进程内存；Redis 里每个命名空间只有一个整数，是“有没有变”的信号，不存配置本身。
//   读：5 秒内探测过且没到硬过期 → 直接用。否则取 Redis 的版本号：没变 → 接着用；变了 → 重读库。
//       Redis 取不到：手里的值装载未满 60 秒就接着用，否则重读库。
//   硬过期 = min(装载时刻 + 10 分钟, 下一个到点切换的时刻)：参数预约生效这类到点的事，不晚于切换时刻。
//   写：业务事务提交之后调 bump（INCR）；失败不抛，各进程最迟 60 秒后自己重读。
// 正常情况下改配置 5 秒内全实例生效。有法律意义或涉及撤销的判断不走缓存，直接读库（D6 第 4.6 节末）。
import type { Clock } from "../kernel/index.js";

import type { ConfigReport } from "./types.js";

export const CONFIG_NAMESPACES = ["dict", "param", "site", "flag", "checklist"] as const;
export type ConfigNamespace = (typeof CONFIG_NAMESPACES)[number];

/** 两次探测版本号的最短间隔 */
export const PROBE_INTERVAL_MS = 5_000;
/** Redis 不可用时，旧值最多再用这么久 */
export const STALE_TOLERANCE_MS = 60_000;
/** 不管版本号变没变，装载满这么久就重读 */
export const HARD_EXPIRE_MS = 600_000;
/** 取版本号最多等这么久：Redis 连不上时不让读配置的请求跟着挂住 */
export const PROBE_TIMEOUT_MS = 500;

/** 版本号放哪。ioredis 的客户端满足它；只用到两个命令 */
export interface VersionStore {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
}

/** 装载结果：全量数据，以及下一个到点切换的时刻（没有就不给） */
export interface Loaded<T> {
  data: T;
  nextSwitchAt?: Date | null;
}

export interface ConfigCacheOptions {
  clock: Clock;
  /** 不给即没有版本号信号（本地脚本这类只有一个进程的场合）：只靠探测间隔之后的重读 */
  redis: VersionStore | null;
  /** 键的前缀，如 lyx:prod:（D7 第 2.5 节）。连接自己带了 keyPrefix 的不用给 */
  keyPrefix?: string;
  report?: ConfigReport;
}

export interface ConfigCache {
  /** 读一个命名空间的全量数据；该重读时调 load */
  read<T>(namespace: ConfigNamespace, load: () => Promise<Loaded<T>>): Promise<T>;
  /** 写侧在事务提交之后调：版本号加 1，并丢掉本进程手里的旧值 */
  bump(namespace: ConfigNamespace): Promise<void>;
  /** 命名空间的版本号（引导接口的 versions）。从没改过是 0；Redis 取不到时给本进程记着的 */
  version(namespace: ConfigNamespace): Promise<number>;
  /** 丢掉本进程手里的值，下一次读即重读库。不给命名空间即全丢 */
  invalidate(namespace?: ConfigNamespace): void;
}

interface Entry {
  data: unknown;
  /** 装载时 Redis 里的版本号；取不到时为 null */
  version: string | null;
  loadedAt: number;
  checkedAt: number;
  hardExpireAt: number;
}

export const versionKey = (namespace: ConfigNamespace, prefix = ""): string =>
  `${prefix}cfg:ver:${namespace}`;

export function createConfigCache(options: ConfigCacheOptions): ConfigCache {
  const { clock, redis, report } = options;
  const entries = new Map<ConfigNamespace, Entry>();
  const loading = new Map<ConfigNamespace, Promise<unknown>>();
  const keyOf = (namespace: ConfigNamespace): string => versionKey(namespace, options.keyPrefix);

  /** 取版本号。没改过的命名空间键不存在，记作 "0"。取不到（出错或超时）返回 undefined */
  async function probe(namespace: ConfigNamespace): Promise<string | undefined> {
    if (!redis) return "0";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`取版本号超过 ${String(PROBE_TIMEOUT_MS)} 毫秒`));
        }, PROBE_TIMEOUT_MS);
      });
      return (await Promise.race([redis.get(keyOf(namespace)), timeout])) ?? "0";
    } catch (error) {
      report?.({
        kind: "version_unavailable",
        subject: namespace,
        detail: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async function reload<T>(
    namespace: ConfigNamespace,
    version: string | undefined,
    load: () => Promise<Loaded<T>>,
  ): Promise<T> {
    // 同一个命名空间同时只装载一次：并发的读等同一份结果
    const pending = loading.get(namespace) as Promise<T> | undefined;
    if (pending) return pending;
    const task = (async () => {
      const loaded = await load();
      const now = clock.now().getTime();
      const switchAt = loaded.nextSwitchAt?.getTime() ?? Number.POSITIVE_INFINITY;
      entries.set(namespace, {
        data: loaded.data,
        version: version ?? null,
        loadedAt: now,
        checkedAt: now,
        hardExpireAt: Math.min(now + HARD_EXPIRE_MS, switchAt),
      });
      return loaded.data;
    })().finally(() => loading.delete(namespace));
    loading.set(namespace, task);
    return task;
  }

  return {
    async read<T>(namespace: ConfigNamespace, load: () => Promise<Loaded<T>>): Promise<T> {
      const entry = entries.get(namespace);
      const now = clock.now().getTime();
      const alive = entry !== undefined && now < entry.hardExpireAt;
      if (alive && now - entry.checkedAt < PROBE_INTERVAL_MS) return entry.data as T;
      const version = await probe(namespace);
      if (alive && version === undefined && now - entry.loadedAt < STALE_TOLERANCE_MS) {
        // Redis 取不到：旧值接着用，过一个探测间隔再试，不每次读都去碰 Redis
        entry.checkedAt = now;
        return entry.data as T;
      }
      if (alive && version !== undefined && version === entry.version) {
        entry.checkedAt = now;
        return entry.data as T;
      }
      return reload(namespace, version, load);
    },

    async bump(namespace) {
      entries.delete(namespace);
      if (!redis) return;
      try {
        await redis.incr(keyOf(namespace));
      } catch (error) {
        // 提交已经成功，不因为通知不到别的进程而报错：它们最迟 60 秒后自己重读
        report?.({
          kind: "version_unavailable",
          subject: namespace,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async version(namespace) {
      const version = (await probe(namespace)) ?? entries.get(namespace)?.version ?? "0";
      const parsed = Number(version);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    },

    invalidate(namespace) {
      if (namespace === undefined) entries.clear();
      else entries.delete(namespace);
    },
  };
}
