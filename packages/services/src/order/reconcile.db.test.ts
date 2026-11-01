import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLedger } from "../billing/index.js";
import {
  createContentCopyright,
  createContentLicense,
  DramaPricePort,
  readCurrentLicenseEnd,
} from "../content/index.js";
import { getTicketBriefByOrderItem } from "../delivery/index.js";
import { ensureLetters } from "../docs/index.js";
import { alertsOf, createIdentityContext } from "../kernel/index.js";
import { listFinalRejectedQualificationScopes } from "../profile/index.js";
import { createSla } from "../sla/index.js";
import { claimTimers, runTimer } from "../timers/index.js";
import {
  assertSnapshotsEqual,
  completeQualificationFixture,
  createFactories,
  createLicenseConvergenceFixture,
  createRuntimeDocsLicense,
  openTerm,
  runTestInvariants,
  snapshotTables,
  submitQualificationFixture,
  TEST_KEYRING,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { createOrderReconciler } from "./reconcile.js";
import type { OrderReconcileDeps } from "./reconcile.js";
import { MONEY_TABLES, REQUEST_TABLES, requestsHarness } from "./__fixtures__/cancel-requests.js";

const db = useSeededDatabase("services", { max: 2 }),
  redis = useTestRedis();
const cleanup: (() => unknown)[] = [];
beforeEach(() => db.reset(), 120_000);
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
type Fixture = Awaited<ReturnType<typeof createLicenseConvergenceFixture>>;
async function fixture() {
  const f = await createLicenseConvergenceFixture(await db.prisma(), {
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  });
  cleanup.push(() => f.close());
  return f;
}
function deps(f: Fixture): OrderReconcileDeps {
  const r = f.runtime;
  return {
    tx: r.tx,
    clock: f.clock,
    assembly: r.assembly,
    cancel: {
      tx: r.tx,
      clock: f.clock,
      assembly: r.assembly,
      flow: r.flow,
      events: r.events,
      approval: r.approval,
      ledger: createLedger({ clock: f.clock, events: r.events }),
      timers: r.timers,
      sla: createSla({ clock: f.clock, assembly: r.assembly }),
    },
    ensureLetters: r.licenseLetters.ensureLetters,
    qualificationScopes: listFinalRejectedQualificationScopes,
    currentLicenseEnd: readCurrentLicenseEnd,
    ticketByItem: getTicketBriefByOrderItem,
  };
}
function scope(input: OrderReconcileDeps) {
  const s = createOrderReconciler(input);
  cleanup.push(() => s.close());
  return s;
}
async function extend(f: Fixture) {
  const p = await db.prisma(),
    r = f.runtime,
    make = createFactories({ db: p, clock: f.clock }),
    staff = await make.staff({ staffRoleKey: "super_admin" }),
    ctx = createIdentityContext({ actor: { type: "staff", id: staff.id, client: "admin" } }),
    proof = await make.fileObject({
      category: "drama_license_doc",
      bucket: "secure",
      ext: "pdf",
      mime: "application/pdf",
    });
  await r.tx.run((tx) =>
    r.content.delist(tx, ctx, f.dramaId, { reasonCode: "ops_strategy", note: "续期核对暂停售卖" }),
  );
  const copyright = createContentCopyright({
    clock: f.clock,
    media: r.media,
    events: r.events,
    prices: r.assembly.port(DramaPricePort),
    license: createContentLicense({ clock: f.clock, flow: r.flow, timers: r.timers }),
  });
  return r.tx.run((tx) =>
    copyright.revise(tx, ctx, f.dramaId, {
      lockVersion: 0,
      changeKind: "extend",
      reason: "真实版权续期，对账只生产同步定时器",
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
    }),
  );
}

describe("W5-03 三类订单对账", { timeout: 120_000 }, () => {
  it("真实开工严格超过十分钟才ensure，重放零信件/版次/事件新增", async () => {
    const f = await fixture();
    await f.start();
    const s = scope(deps(f)),
      p = await db.prisma();
    expect((await s.run()).lettersCreated).toBe(0);
    f.clock.advance(600_000);
    expect((await s.run()).lettersCreated).toBe(0);
    f.clock.advance(1);
    let beats = 0;
    expect((await s.run(() => beats++)).lettersCreated).toBe(2);
    expect(beats).toBeGreaterThan(0);
    const evidence = () =>
      snapshotTables(p, [
        "license_letter",
        "license_letter_revision",
        "status_transition",
        "audit_log",
        "outbox_event",
      ]);
    const before = await evidence();
    expect(await s.run()).toMatchObject({ lettersCreated: 0, lettersRevised: 0, lettersVoided: 0 });
    assertSnapshotsEqual(before, await evidence());
    expect(
      await p.licenseLetter.count({
        where: { orderItemId: f.order.itemId, status: { not: "voided" } },
      }),
    ).toBe(2);
    // This mechanism fixture retains historical content/media inputs; full-chain health is
    // validated by the existing M1 target. Here exercise both formal authorization checks.
    const full = await runTestInvariants(f.runtime, {
      mode: "full",
      trigger: "manual",
      codes: ["docs.N6", "docs.N16"],
    });
    expect(full.errors).toEqual([]);
    expect(full).toMatchObject({
      status: "succeeded",
      violationsFound: 0,
      checksRun: 2,
    });
  });

  it("真实终局丢投递后补整店申请，含仅广告门店；分页、锁内重判与重放不碰资金", async () => {
    const h = requestsHarness(await db.prisma());
    cleanup.push(() => h.close());
    const w = await h.qualificationOrder(),
      ad = await h.unassignedAd(w),
      reviewer = await h.staff();
    await h.param("refund.points.auto_approve_before_production", false, reviewer);
    const onlyAd = await h.profileFixture.owner(),
      ready = await completeQualificationFixture(h.profileFixture, onlyAd.viewer);
    await submitQualificationFixture(h.profileFixture, onlyAd.viewer, ready.submissionId);
    const { term } = await openTerm(h, { entityId: onlyAd.entity.id });
    const ad2 = await h.unassignedAd({ ...onlyAd, b: { term } });
    for (const [submissionId, storeId] of [
      [w.submissionId, w.store.id],
      [ready.submissionId, onlyAd.store.id],
    ]) {
      const impact = await h.profile.admin.rejectQuote(reviewer.staff!, submissionId!);
      await h.profile.admin.reject(reviewer.ctx, reviewer.staff!, submissionId!, {
        isFinal: true,
        reasonCodes: ["R01"],
        note: "资质终局事实，模拟订阅投递尚未完成",
        confirm: {
          pendingStartOrderCount: impact.pendingStartOrderCount,
          pendingAssignAdCount: impact.pendingAssignAdCount,
          heldPoints: impact.heldPoints,
        },
      });
      expect(
        await h.prisma.cancelRequest.count({ where: { storeId, kind: "qualification_cancel" } }),
      ).toBe(0);
    }
    const first = await h.tx.run((tx) => listFinalRejectedQualificationScopes(tx, { limit: 1 }));
    const second = await h.tx.run((tx) =>
      listFinalRejectedQualificationScopes(tx, { limit: 1, cursor: first[0]!.storeId }),
    );
    expect([...first, ...second].map((r) => r.storeId).sort()).toEqual(
      [w.store.id, onlyAd.store.id].sort(),
    );
    const license = createRuntimeDocsLicense({
      clock: h.clock,
      flow: h.flow,
      events: h.events,
      portalOrigin: "https://reconcile.example.invalid",
      keyring: () => TEST_KEYRING,
    });
    const s = scope({
      tx: h.tx,
      clock: h.clock,
      assembly: h.assembly,
      cancel: h.requestDeps,
      ensureLetters: (tx, ids, ref) => ensureLetters(tx, license, ids, ref),
      qualificationScopes: listFinalRejectedQualificationScopes,
      currentLicenseEnd: readCurrentLicenseEnd,
      ticketByItem: getTicketBriefByOrderItem,
    });
    const money = await snapshotTables(h.prisma, MONEY_TABLES);
    expect((await s.run()).cancellationsCreated).toBe(2);
    for (const target of [ad, ad2])
      expect(await h.prisma.ad.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
        status: "pending_assign",
        openCancelRequestId: expect.any(String),
      });
    expect(
      await h.prisma.cancelRequest.count({
        where: { kind: "qualification_cancel", status: "pending_approval" },
      }),
    ).toBe(2);
    assertSnapshotsEqual(money, await snapshotTables(h.prisma, MONEY_TABLES));
    const evidence = await snapshotTables(h.prisma, REQUEST_TABLES);
    expect((await s.run()).cancellationsCreated).toBe(0);
    assertSnapshotsEqual(evidence, await snapshotTables(h.prisma, REQUEST_TABLES));
  });

  it("真实版权续期只即时arm；缺M6handler真实retry，小时重放保留退避，较晚止日只告警", async () => {
    const f = await fixture(),
      p = await db.prisma(),
      revisionId = await extend(f),
      s = scope(deps(f));
    const before = await p.orderItem.findUniqueOrThrow({ where: { id: f.order.itemId } });
    expect((await s.run()).resyncArmed).toBe(1);
    const timer = await p.timer.findFirstOrThrow({
      where: { kind: "usage.resync", subjectId: f.order.itemId },
    });
    expect(timer).toMatchObject({
      status: "scheduled",
      subjectType: "order_item",
      fireAt: f.clock.now(),
      dedupeKey: `usage.resync:order_item:${f.order.itemId}:${revisionId}`,
    });
    expect(await p.orderItem.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    expect(f.runtime.assembly.timerHandler("usage.resync")).toBeUndefined();
    const claimed = await f.runtime.tx.run((tx) =>
      claimTimers(tx, f.runtime.timers.registry, f.clock.now()),
    );
    const ref = claimed.claimed.find((row) => row.timerId === timer.id)!;
    expect(ref).toBeDefined();
    expect(
      await runTimer(
        {
          tx: f.runtime.tx,
          clock: f.clock,
          assembly: f.runtime.assembly,
          registry: f.runtime.timers.registry,
          alerts: alertsOf(f.runtime.assembly),
        },
        ref,
      ),
    ).toBe("retry");
    const retried = await p.timer.findUniqueOrThrow({ where: { id: timer.id } });
    expect(retried).toMatchObject({ status: "scheduled", attempts: 1, retryAt: expect.any(Date) });
    f.clock.advance(3_600_000);
    expect((await s.run()).resyncArmed).toBe(0);
    expect(await p.timer.findUniqueOrThrow({ where: { id: timer.id } })).toEqual(retried);
    // Explicit corrupt historical date, not a shortened-license writer or a successful M6 result.
    await p.orderItem.update({
      where: { id: before.id },
      data: { usageEndDate: new Date("2037-12-31") },
    });
    f.clock.advance(3_600_000);
    expect(await s.run()).toMatchObject({ shortened: 1, resyncArmed: 0 });
    expect(
      (await p.orderItem.findUniqueOrThrow({ where: { id: before.id } })).usageEndDate,
    ).toEqual(new Date("2037-12-31"));
    expect(await p.alertEvent.count({ where: { rule: "order.license_shortened" } })).toBe(1);
  });

  it("单对象失败回滚仍处理下一对象；close等在途且回滚，旧入口拒绝，另实例可用", async () => {
    const a = await fixture();
    await a.start();
    const b = await fixture();
    await b.start();
    a.clock.advance(600_001);
    const base = deps(a),
      s = scope({
        ...base,
        ensureLetters: async (tx, ids, ref) => {
          const result = await base.ensureLetters(tx, ids, ref);
          if (ids.includes(a.order.itemId)) throw new Error("故障注入：writer后失败");
          return result;
        },
      });
    await expect(s.run()).rejects.toThrow("1个目标失败");
    const p = await db.prisma();
    expect(await p.licenseLetter.count({ where: { orderItemId: a.order.itemId } })).toBe(0);
    expect(await p.licenseLetter.count({ where: { orderItemId: b.order.itemId } })).toBe(2);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const active = scope({
      ...base,
      ensureLetters: async (...args) => {
        enter();
        await gate;
        return base.ensureLetters(...args);
      },
    });
    const work = active.run(),
      settled = Promise.allSettled([work]);
    await entered;
    let finished = false;
    const closing = active.close().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await closing;
    expect((await settled)[0]!.status).toBe("rejected");
    expect(await p.licenseLetter.count({ where: { orderItemId: a.order.itemId } })).toBe(0);
    expect(() => active.run()).toThrow("已经关闭");
    expect((await scope(base).run()).lettersCreated).toBe(2);
  });
});
