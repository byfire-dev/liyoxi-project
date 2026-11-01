import { expect, it } from "vitest";
import { createW508OrderAdFixture, useSeededDatabase, useTestRedis } from "../testing/index.js";
import { createTenant } from "../tenant/index.js";
import { createMerchantPlayables } from "./playable-runtime.js";

const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();

it(
  "真实广告probe安装资产与推送后换取source播放签名，GET零业务写与访问留痕",
  { timeout: 120_000 },
  async () => {
    const p = await db.prisma();
    const f = await createW508OrderAdFixture(p, {
      databaseUrl: await db.url(),
      redisUrl: process.env.REDIS_URL!,
      redisKeyPrefix: redis.prefix,
    });
    try {
      await p.featureFlag.update({
        where: { key: "weapp.video.ad.enabled" },
        data: { defaultValue: true, rules: [] },
      });
      await f.runtime.config.cache.bump("flag");
      const ad = await f.createAd(),
        pushed = await f.pushAd(ad.adId);
      const version = await p.adVersion.findUniqueOrThrow({ where: { id: pushed.adVersionId } });
      const asset = await p.playableAsset.findFirstOrThrow({
        where: { kind: "ad", sourceFileId: version.fileId, ownerId: ad.adId },
      });
      const production = await f.runtime.tx.run((tx) =>
        f.runtime.media.adProductionFacts(tx, version.fileId),
      );
      expect(production.ready).toBe(true);
      expect(production.playable?.id).toBe(asset.id);
      const counts = () =>
        Promise.all([
          p.auditLog.count(),
          p.statusTransition.count(),
          p.outboxEvent.count(),
          p.adVersion.count(),
          p.playableAsset.count(),
          p.fileRef.count(),
        ]);
      const before = await counts();
      const { tx, clock, config, media, assembly, flow } = f.runtime;
      const service = createMerchantPlayables({
        tx,
        clock,
        config,
        media,
        tenant: createTenant({ tx, clock, assembly, flow }),
      });
      const playable = await service.get(
        { merchantUserId: f.actor.ctx.actor.id ?? undefined, storeId: f.actor.membership.storeId },
        asset.id,
      );
      expect(playable).toMatchObject({
        playableId: asset.id,
        kind: "ad",
        muted: false,
        autoplay: false,
      });
      expect(playable.sources).toHaveLength(1);
      expect(playable.sources[0]).toMatchObject({ quality: "source", width: 1080, height: 1920 });
      expect(Date.parse(playable.expiresAt!) - f.clock.now().getTime()).toBe(3_600_000);
      const actual = f.providers.storage.fetch(playable.sources[0]!.url);
      expect(actual.status).toBe(200);
      if (actual.status !== 200) throw new Error("真实广告签名不能读取实际入库对象");
      expect(actual.body.byteLength).toBe(1234);
      expect(await counts()).toEqual(before);
    } finally {
      await f.close();
    }
  },
);
