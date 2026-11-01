import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSeededDatabase, useTestRedis } from "../testing/index.js";
import { adFixture } from "./__fixtures__/lifecycle.js";
import { getWalletView } from "../billing/index.js";
const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
let active: Awaited<ReturnType<typeof adFixture>> | undefined;
beforeEach(() => db.reset(), 120_000);
afterEach(async () => {
  await active?.close();
  active = undefined;
});
it(
  "同版修改并发只创建一轮；免费额度耗尽后收费报价被锁内核对且只扣一次",
  { timeout: 120_000 },
  async () => {
    const p = await db.prisma(),
      f = (active = await adFixture(p, {
        databaseUrl: await db.url(),
        redisUrl: process.env.REDIS_URL!,
        redisKeyPrefix: redis.prefix,
      })),
      id = f.created.adId;
    const quota = (await p.ad.findUniqueOrThrow({ where: { id } })).freeRevisionQuota;
    for (let i = 0; i < quota; i++) {
      const v = await f.push();
      const changed = await f.runtime.ads.requestChange(f.actor, id, {
        versionNo: v.versionNo,
        note: `免费修改${i}`,
      });
      expect(changed.revision.isChargeable).toBe(false);
      expect(changed.revision.chargePoints).toBe(0);
    }
    const v = await f.push(),
      price = (await f.runtime.ads.get(f.actor, id)).revisionUnitChargePoints!;
    await expect(
      f.runtime.ads.requestChange(f.actor, id, { versionNo: v.versionNo, note: "未接受收费" }),
    ).rejects.toMatchObject({ error: "CHARGE_CHANGED" });
    let arrived = 0,
      open!: () => void;
    const barrier = new Promise<void>((resolve) => {
        open = resolve;
      }),
      original = f.providers.wechat.checkText.bind(f.providers.wechat);
    const spy = vi.spyOn(f.providers.wechat, "checkText").mockImplementation(async (input) => {
      if (++arrived === 2) open();
      await barrier;
      return original(input);
    });
    const beforeBalance = (await getWalletView(p, f.actor.membership.entityId, f.clock.now()))
      .points.spendablePoints;
    const results = await Promise.allSettled([
      f.runtime.ads.requestChange(f.actor, id, {
        versionNo: v.versionNo,
        note: "第一份收费意见",
        acceptChargePoints: price,
      }),
      f.runtime.ads.requestChange(f.actor, id, {
        versionNo: v.versionNo,
        note: "第二份收费意见",
        acceptChargePoints: price,
      }),
    ]);
    spy.mockRestore();
    expect(arrived).toBe(2);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await p.adRevision.findMany({ where: { adId: id, isChargeable: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.chargePoints).toBe(price);
    const hold = await p.pointHold.findUniqueOrThrow({
      where: { id: rows[0]!.chargePointHoldId! },
    });
    expect(hold.status).toBe("captured");
    expect(hold.qty).toBe(price);
    expect(
      (await getWalletView(p, f.actor.membership.entityId, f.clock.now())).points.spendablePoints,
    ).toBe(beforeBalance - price);
    expect(await p.adRevision.count({ where: { adId: id, fulfilledByVersionNo: null } })).toBe(1);
    expect(
      await p.timer.count({
        where: {
          kind: "sla.breach",
          subjectId: id,
          status: "scheduled",
          dedupeKey: { endsWith: `rev:${quota + 1}` },
        },
      }),
    ).toBe(1);
  },
);
