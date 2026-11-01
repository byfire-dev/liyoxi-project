import { afterEach, beforeEach, expect, it } from "vitest";
import { useSeededDatabase, useTestRedis } from "../testing/index.js";
import { claimTimers, runTimer } from "../timers/index.js";
import { adFixture } from "./__fixtures__/lifecycle.js";
import { handleAdSlaBreach } from "./sla.js";
const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
let active: Awaited<ReturnType<typeof adFixture>> | undefined;
beforeEach(() => db.reset(), 120_000);
afterEach(async () => {
  await active?.close();
  active = undefined;
});
async function setup() {
  const p = await db.prisma();
  const f = (active = await adFixture(p, {
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  }));
  const claim = async (key: string) => {
    const timer = await p.timer.findFirstOrThrow({
      where: { dedupeKey: key, status: "scheduled" },
      orderBy: { createdAt: "desc" },
    });
    f.clock.set(new Date(timer.fireAt.getTime() + 1000));
    const result = await f.runtime.tx.run((tx) =>
      claimTimers(tx, f.runtime.timers.registry, f.clock.now(), 100),
    );
    const ref = result.claimed.find((r) => r.timerId === timer.id);
    if (!ref) throw new Error("当前广告定时器未被真实扫描认领");
    return { timer, ref };
  };
  const run = (ref: Parameters<typeof runTimer>[1]) =>
    runTimer(
      {
        tx: f.runtime.tx,
        assembly: f.runtime.assembly,
        registry: f.runtime.timers.registry,
        clock: f.clock,
        alerts: {
          raise: async () => {
            throw new Error("广告时限不应触发失败告警");
          },
        },
      },
      ref,
    );
  return { p, f, claim, run };
}
it(
  "首版与修改版用当前purpose/轮次/实际deadline；旧timer失效且重复认领不重复事件",
  { timeout: 120_000 },
  async () => {
    const { p, f, claim, run } = await setup(),
      id = f.created.adId;
    const first = await claim(`sla.breach:ad:${id}:first:0`);
    expect(await run(first.ref)).toBe("fired");
    expect((await p.ad.findUniqueOrThrow({ where: { id } })).firstBreachedAt).toEqual(
      f.clock.now(),
    );
    expect(await run(first.ref)).toBe("stale");
    expect(
      await p.outboxEvent.count({ where: { eventType: "ad.sla_breached", aggregateId: id } }),
    ).toBe(1);
    const version = await f.push();
    await f.runtime.ads.requestChange(f.actor, id, {
      versionNo: version.versionNo,
      note: "调整品牌字样",
    });
    const current = await p.ad.findUniqueOrThrow({ where: { id } });
    expect(current.status).toBe("revising");
    const rev = await claim(`sla.breach:ad:${id}:rev:1`);
    const fired = {
      id: rev.timer.id,
      kind: "sla.breach",
      subjectType: "ad",
      subjectId: id,
      payload: rev.timer.payload as Record<string, unknown>,
    };
    await expect(
      f.runtime.tx.run((tx) =>
        handleAdSlaBreach(
          tx,
          { clock: f.clock, events: f.runtime.events },
          { ...fired, payload: { ...fired.payload, policy: "ad.first_version" } },
        ),
      ),
    ).resolves.toBe("skipped");
    expect(await run(first.ref)).toBe("stale");
    expect(
      (
        await p.adRevision.findUniqueOrThrow({
          where: { adId_revisionNo: { adId: id, revisionNo: 1 } },
        })
      ).breachedAt,
    ).toBeNull();
    expect(await run(rev.ref)).toBe("fired");
    expect(
      (
        await p.adRevision.findUniqueOrThrow({
          where: { adId_revisionNo: { adId: id, revisionNo: 1 } },
        })
      ).breachedAt,
    ).toEqual(f.clock.now());
    expect(
      await p.outboxEvent.findMany({
        where: { eventType: "ad.sla_breached", aggregateId: id },
        orderBy: { seq: "asc" },
        select: { payload: true },
      }),
    ).toMatchObject([
      { payload: { purpose: "first" } },
      { payload: { purpose: "revision", revisionNo: 1 } },
    ]);
  },
);
it(
  "已推送满足timer、退回旧轮次不得污染重提；资质在审待指派只提醒不写违约",
  { timeout: 120_000 },
  async () => {
    const { p, f, claim, run } = await setup(),
      id = f.created.adId;
    const old = await claim(`sla.breach:ad:${id}:first:0`);
    await f.runtime.tx.run((tx) =>
      f.runtime.ads.production.returnTx(tx, f.adminActor, id, "补充素材"),
    );
    expect(await run(old.ref)).toBe("stale");
    await f.runtime.ads.submit(f.actor, id, {});
    const resumed = await p.ad.findUniqueOrThrow({ where: { id } });
    expect(resumed.resubmitCount).toBe(1);
    const next = await claim(`sla.breach:ad:${id}:first:1`);
    await f.push();
    expect(await run(next.ref)).toBe("stale");
    expect((await p.ad.findUniqueOrThrow({ where: { id } })).firstBreachedAt).toBeNull();
    // Qualification pending is an explicit nonterminal test input, never a fabricated approval.
    await p.store.update({
      where: { id: f.actor.membership.storeId },
      data: { qualificationStatus: "pending", isPrimary: true },
    });
    const waiting = await f.runtime.ads.create(f.actor, f.createBody);
    const waitTimer = await claim(`sla.breach:ad:${waiting.adId}:first:0`);
    expect(await run(waitTimer.ref)).toBe("fired");
    expect(await p.ad.findUniqueOrThrow({ where: { id: waiting.adId } })).toMatchObject({
      status: "pending_assign",
      firstBreachedAt: null,
      capturedAt: null,
    });
    expect(
      await p.outboxEvent.count({
        where: { eventType: "ad.sla_breached", aggregateId: waiting.adId },
      }),
    ).toBe(1);
    expect(await run(waitTimer.ref)).toBe("stale");
  },
);
