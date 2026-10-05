// 站点配置读取（W0-18）。依据：14 分组 第 2.4、4.3 节。
// 商城配置（mall）与首页推荐位（home_recommend）各是一份整体生效的 JSON；读侧只取已发布的那一版。
// 每个配置键恰有一份已发布靠播种的初始版成立（config.N9）；还没播种时读到 null，由调用方决定怎么办。
import { SITE_CONFIG_SCHEMAS } from "@liyoxi/contract";
import type { SiteConfigContent } from "@liyoxi/contract";

import type { ConfigCache } from "./cache.js";
import type { ConfigDb, ConfigReport } from "./types.js";

export type SiteConfigKey = keyof SiteConfigContent;

export interface PublishedSiteConfig<K extends SiteConfigKey = SiteConfigKey> {
  configKey: K;
  /** 修订号：端上据此判断本地缓存是否过期 */
  revNo: number;
  content: SiteConfigContent[K];
  publishedAt: Date;
}

export interface SiteConfig {
  /** 已发布的那一版；没有（或内容不合结构）返回 null */
  published<K extends SiteConfigKey>(configKey: K): Promise<PublishedSiteConfig<K> | null>;
}

export interface SiteConfigOptions {
  db: ConfigDb;
  cache: ConfigCache;
  report?: ConfigReport;
}

const isSiteConfigKey = (key: string): key is SiteConfigKey =>
  Object.hasOwn(SITE_CONFIG_SCHEMAS, key);

export function createSiteConfig(options: SiteConfigOptions): SiteConfig {
  const { db, cache, report } = options;

  async function load() {
    const rows = await db.siteConfigRevision.findMany({
      where: { status: "published" },
      select: { configKey: true, revNo: true, content: true, publishedAt: true },
    });
    const data = new Map<string, PublishedSiteConfig>();
    for (const row of rows) {
      if (!isSiteConfigKey(row.configKey) || row.revNo === null || row.publishedAt === null) {
        continue;
      }
      const parsed = SITE_CONFIG_SCHEMAS[row.configKey].safeParse(row.content);
      if (!parsed.success) {
        report?.({
          kind: "site_config_invalid",
          subject: row.configKey,
          detail: `已发布的修订 ${String(row.revNo)} 不合结构`,
        });
        continue;
      }
      data.set(row.configKey, {
        configKey: row.configKey,
        revNo: row.revNo,
        content: parsed.data,
        publishedAt: row.publishedAt,
      });
    }
    return { data: data as ReadonlyMap<string, PublishedSiteConfig> };
  }

  return {
    async published<K extends SiteConfigKey>(configKey: K) {
      const all = await cache.read("site", load);
      return (all.get(configKey) as PublishedSiteConfig<K> | undefined) ?? null;
    },
  };
}
