import { afterAll, beforeAll, expect, it } from "vitest";
import {
  AdQuoteSchema,
  AdStateSchema,
  AdDetailSchema,
  AdPageSchema,
  AdRevisionResultSchema,
  PlayableSchema,
  MeOverviewSchema,
  StoreProfileOverviewSchema,
} from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import {
  createDeliveryProductionTools,
  createFactories,
  createW508OrderAdFixture,
  openSealed,
  TEST_KEYRING,
} from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
import { HANDLERS } from "../src/routes/index.js";
const h = useTestApi();
let api: TestApi,
  f: Awaited<ReturnType<typeof createW508OrderAdFixture>>,
  owner: SignedInMerchant,
  clerk: SignedInMerchant,
  outsider: SignedInMerchant;
let p: Awaited<ReturnType<typeof h.db.prisma>>,
  peer = 0,
  otherStore: string;
const operations = [
  "m.ad.list",
  "m.ad.create",
  "m.ad.quote",
  "m.ad.get",
  "m.ad.confirm",
  "m.ad.downloadUrls",
  "m.ad.requestChange",
  "m.ad.submit",
  "m.playable.get",
] as const;
const request = (path: string, json?: unknown, headers?: Record<string, string>, key = uuidv7()) =>
  api.request(`/api/v1${path}`, {
    method: json === undefined ? "GET" : "POST",
    ...(json === undefined ? {} : { json }),
    headers: {
      ...(headers ?? owner.withStore(f.actor.membership.storeId)),
      "Idempotency-Key": key,
    },
    peer: `198.19.211.${++peer}`,
  });
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as { data: unknown }).data;
}
async function assertAggregates() {
  const rows = await p.ad.findMany({
      where: { storeId: f.actor.membership.storeId },
      select: { status: true },
    }),
    count = (statuses: readonly string[]) => rows.filter((r) => statuses.includes(r.status)).length;
  const overview = MeOverviewSchema.parse(await data(await request("/m/me/overview"))),
    profile = StoreProfileOverviewSchema.parse(await data(await request("/m/store-profile")));
  if (overview.viewerRole !== "owner" || profile.viewerRole !== "owner")
    throw new Error("老板聚合应保留老板视图");
  expect(overview.entries.adPendingConfirmCount).toBe(count(["pending_confirm"]));
  expect(profile.ads).toEqual({
    pendingConfirmCount: count(["pending_confirm"]),
    confirmedCount: count(["confirmed"]),
    producingCount: count(["pending_assign", "producing", "returned"]),
    revisingCount: count(["revising"]),
  });
}
beforeAll(async () => {
  api = await h.start({
    merchantKeyring: TEST_KEYRING,
    portalPublicOrigin: "https://ad-test.invalid",
    mediaProduction: (providers) => {
      const codec = createDeliveryProductionTools(providers);
      return { config: codec.env, tools: codec.tools };
    },
  });
  p = await h.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(h, api);
  clerk = await signInAsMerchant(api);
  outsider = await signInAsMerchant(api);
  f = await createW508OrderAdFixture(p, {
    databaseUrl: await h.db.url(),
    redisUrl: api.runtime.env.REDIS_URL,
    redisKeyPrefix: `${h.redis.prefix}merchant-ads:`,
    clock: api.clock,
  });
  owner = await signInAsMerchant(api, {
    phone: openSealed("merchant_user.phone_enc", f.merchant.user.phoneEnc!),
  });
  expect(owner.merchantUserId).toBe(f.merchant.user.id);
  const make = createFactories({ db: p, clock: api.clock }),
    member = await make.entityMember({
      entityId: f.actor.membership.entityId,
      merchantUserId: clerk.merchantUserId,
      role: "clerk",
    });
  await make.storeMember({
    entityMemberId: member.id,
    storeId: f.actor.membership.storeId,
    addedByMemberId: f.merchant.owner.id,
  });
  const entity = await make.entity({
      createdByUserId: outsider.merchantUserId,
      verificationStatus: "verified",
    }),
    store = await make.store({
      entityId: entity.id,
      isPrimary: true,
      qualificationStatus: "verified",
    });
  otherStore = store.id;
  await make.entityMember({
    entityId: entity.id,
    merchantUserId: outsider.merchantUserId,
    role: "owner",
  });
}, 120_000);
afterAll(async () => {
  await f?.close();
});

it(
  "九个商户/播放正式入口：真实创建冻结、默认播放确认、下线兜底下载、修改及退回重提；角色和跨店隔离",
  { timeout: 120_000 },
  async () => {
    const wired = new Set(HANDLERS.map((h) => h.route.operationId));
    for (const operation of operations) expect(wired.has(operation)).toBe(true);
    const quote = AdQuoteSchema.parse(
        await data(await request("/m/ads/quote", { type: "opening", durationSec: 3 })),
      ),
      promo = await p.dictItem.findFirstOrThrow({
        where: { dictTypeKey: "ad_promo_point", isEnabled: true },
      });
    const body = {
      type: "opening",
      durationSec: 3,
      promoPointCodes: [promo.code],
      copy: "真实商户广告需求",
      expectChargePoints: quote.chargePoints!,
      agreementVersionId: quote.agreement.agreementVersionId,
      isAgreementChecked: true,
    };
    const key = uuidv7(),
      created = AdStateSchema.parse(await data(await request("/m/ads", body, undefined, key)));
    expect(AdStateSchema.parse(await data(await request("/m/ads", body, undefined, key)))).toEqual(
      created,
    );
    const reused = await request("/m/ads", { ...body, copy: "变化的需求" }, undefined, key);
    expect(reused.status).toBe(409);
    const flag = (await f.runtime.configAdmin.flags()).items.find(
      (v) => v.flagKey === "weapp.video.ad.enabled",
    )!;
    await f.runtime.configAdmin.updateFlag(
      { identity: f.admin.ctx, staff: f.admin.staff },
      flag.flagKey,
      { lockVersion: flag.lockVersion, defaultValue: true },
    );
    await api.runtime.config.cache.bump("flag");
    const version = await f.pushAd(created.adId),
      view = AdDetailSchema.parse(await data(await request(`/m/ads/${created.adId}`)));
    expect(view.currentVersion?.versionNo).toBe(version.versionNo);
    expect(view.playable?.sources).toHaveLength(1);
    await assertAggregates();
    const playback = PlayableSchema.parse(
      await data(await request(`/m/playables/${view.playable!.playableId}`)),
    );
    expect(playback.kind).toBe("ad");
    expect(playback.sources[0]?.quality).toBe("source");
    expect(
      AdPageSchema.parse(await data(await request("/m/ads?tab=pending_confirm&limit=1"))).items[0]
        ?.adId,
    ).toBe(created.adId);
    expect(
      AdStateSchema.parse(
        await data(
          await request(`/m/ads/${created.adId}/confirm`, {
            versionNo: version.versionNo,
            viewedVia: "weapp",
          }),
        ),
      ),
    ).toMatchObject({ status: "confirmed", confirmedVersionNo: version.versionNo });
    await assertAggregates();
    expect(
      AdPageSchema.parse(
        await data(await request("/m/ads?tab=confirmed&isSelectable=true")),
      ).items.map((a) => a.adId),
    ).toContain(created.adId);
    const current = (await api.runtime.configAdmin.flags()).items.find(
      (v) => v.flagKey === "weapp.video.ad.enabled",
    )!;
    await api.runtime.configAdmin.updateFlag(
      { identity: f.admin.ctx, staff: f.admin.staff },
      current.flagKey,
      { lockVersion: current.lockVersion, defaultValue: false },
    );
    const fallback = AdDetailSchema.parse(await data(await request(`/m/ads/${created.adId}`)));
    expect(fallback.playable?.sources).toEqual([]);
    expect(fallback.confirmableVia).toEqual([]);
    expect(fallback.alternatives.canSaveToAlbum).toBe(true);
    const url = (await data(
      await request(`/m/ads/${created.adId}/download-urls`, { versionNo: version.versionNo }),
    )) as { expiresAt: string; url: string };
    expect(new Date(url.expiresAt).getTime() - api.clock.now().getTime()).toBe(900_000);
    const revision = AdRevisionResultSchema.parse(
      await data(
        await request(`/m/ads/${created.adId}/request-change`, {
          versionNo: version.versionNo,
          note: "更换这一版的结尾文字",
        }),
      ),
    );
    expect(revision.ad.status).toBe("revising");
    expect(revision.revision.chargePoints).toBe(0);
    await assertAggregates();
    const clerkOverview = await data(
        await request("/m/me/overview", undefined, clerk.withStore(f.actor.membership.storeId)),
      ),
      clerkProfile = await data(
        await request("/m/store-profile", undefined, clerk.withStore(f.actor.membership.storeId)),
      );
    expect(clerkOverview).toMatchObject({ viewerRole: "clerk" });
    expect(clerkOverview).not.toHaveProperty("entries");
    expect(clerkProfile).toMatchObject({ viewerRole: "clerk" });
    expect(clerkProfile).not.toHaveProperty("ads");
    const extra = AdStateSchema.parse(await data(await request("/m/ads", body)));
    await f.runtime.tx.run((tx) =>
      f.runtime.ads.production.returnTx(tx, f.admin, extra.adId, "需要商户补充清晰素材"),
    );
    expect(
      AdStateSchema.parse(
        await data(await request(`/m/ads/${extra.adId}/submit`, { copy: "已经补充的广告文案" })),
      ),
    ).toMatchObject({ status: "pending_assign" });
    const before = await p.adRevision.count({ where: { adId: created.adId } }),
      denied = await request(
        `/m/ads/${created.adId}/request-change`,
        { versionNo: version.versionNo, note: "店员不得改动" },
        clerk.withStore(f.actor.membership.storeId),
      );
    expect(denied.status).toBe(403);
    expect(
      (await request(`/m/ads/${created.adId}`, undefined, outsider.withStore(otherStore))).status,
    ).toBe(404);
    expect(await p.adRevision.count({ where: { adId: created.adId } })).toBe(before);
  },
);
