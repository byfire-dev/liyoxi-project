import { describe, expect, it } from "vitest";
import { createIdentityContext } from "@liyoxi/services";
import {
  createFactories,
  createLicenseConvergenceFixture,
  sampleStaffContext,
  useSeededDatabase,
  useTestRedis,
} from "@liyoxi/services/testing";
import { DOMAIN_LOOPS } from "../src/domain-loops.js";
import { createHarness, SLOW } from "./support/harness.js";

const db = useSeededDatabase("worker"),
  redis = useTestRedis();
describe("order 正式 worker 对账循环", () => {
  it(
    "唯一五分钟循环真实arm续期信号、重复不新增，关闭后旧入口拒绝",
    async () => {
      const h = await createHarness(db, redis),
        f = await createLicenseConvergenceFixture(h.prisma, {
          databaseUrl: h.databaseUrl,
          redisUrl: process.env.REDIS_URL!,
          redisKeyPrefix: h.redisPrefix,
        });
      try {
        const make = createFactories({ db: h.prisma, clock: f.clock }),
          staff = await make.staff({ staffRoleKey: "super_admin" }),
          actor = {
            identity: createIdentityContext({
              actor: { type: "staff", id: staff.id, client: "admin" },
            }),
            staff: await sampleStaffContext(h.prisma, staff.id, { stepUpAt: f.clock.now() }),
          },
          proof = await make.fileObject({
            category: "drama_license_doc",
            bucket: "secure",
            ext: "pdf",
            mime: "application/pdf",
          });
        await f.runtime.tx.run((tx) =>
          f.runtime.content.delist(tx, actor.identity, f.dramaId, {
            reasonCode: "ops_strategy",
            note: "续期对账运输验收暂停售卖",
          }),
        );
        const revised = await f.runtime.contentAdmin.revise(actor, f.dramaId, {
          lockVersion: 0,
          changeKind: "extend",
          reason: "真实版权续期生产同步信号",
          confirm: { prevEndDate: "2035-12-31" },
          revisionProofFileIds: [proof.id],
          copyright: {
            source: "licensed",
            platforms: ["douyin", "wechat_channels"],
            territory: "中国大陆",
            hasNetworkRight: true,
            canSublicense: true,
            canEditEmbed: true,
            canAdapt: true,
            licenseStartDate: "2020-01-01",
            licenseEndDate: "2036-12-31",
            proofFileIds: [proof.id],
          },
        });
        const worker = await h.instance({ sampleTimers: false, clock: f.clock }),
          loop = worker.runtime.domainLoops["flow_reconcile_sweep"]!;
        expect(DOMAIN_LOOPS.filter((one) => one.name === "flow_reconcile_sweep")).toHaveLength(1);
        expect(DOMAIN_LOOPS.filter((one) => one.name === "flow_reevaluate_sweep")).toHaveLength(1);
        expect(loop.intervalMs).toBe(300_000);
        const before = await h.prisma.orderItem.findUniqueOrThrow({
          where: { id: f.order.itemId },
        });
        await loop.tick();
        await loop.tick();
        const timers = await h.prisma.timer.findMany({
          where: { kind: "usage.resync", subjectId: before.id },
        });
        expect(timers).toHaveLength(1);
        expect(timers[0]).toMatchObject({
          subjectType: "order_item",
          fireAt: f.clock.now(),
          status: "scheduled",
          dedupeKey: `usage.resync:order_item:${before.id}:${revised.revision.dramaCopyrightRevisionId}`,
        });
        expect(await h.prisma.orderItem.findUniqueOrThrow({ where: { id: before.id } })).toEqual(
          before,
        );
        expect(worker.services.assembly.timerHandler("usage.resync")).toBeUndefined();
        await worker.close();
        expect(() => worker.services.reconcileOrders()).toThrow("已经关闭");
      } finally {
        await f.close();
      }
    },
    SLOW,
  );
});
