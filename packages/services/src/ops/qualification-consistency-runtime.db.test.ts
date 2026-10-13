import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as dbClients from "@liyoxi/db";
import { createRuntime } from "../runtime.js";
import { buildWorkerServices, runInvariants } from "./index.js";
import { claimDeliveries } from "../events/index.js";
import { invariantsOf, loadEnv } from "../kernel/index.js";
import { createTenant } from "../tenant/index.js";
import {
  assembleForTest,
  fakeKeyEnv,
  TEST_KEYRING,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { createProfile } from "../profile/service.js";
import { complete, harness, submit, uscc } from "../profile/__fixtures__/harness.js";
import type { Harness } from "../profile/__fixtures__/harness.js";
import { reviewer } from "../profile/__fixtures__/rounds.js";

const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
let h: Harness,
  live: Harness,
  api: ReturnType<typeof createRuntime>,
  worker: ReturnType<typeof buildWorkerServices>,
  apiDb: ReturnType<typeof dbClients.createPrismaClient>;
beforeAll(async () => {
  h = harness(await db.prisma());
  await redis.raw();
  const creating = vi.spyOn(dbClients, "createPrismaClient");
  api = createRuntime({
    entry: "api",
    version: "lyxtest-profile-consistency",
    clock: h.clock,
    providers: h.fake,
    redisKeyPrefix: redis.prefix,
    env: {
      ...loadEnv({
        APP_ENV: "test",
        DATABASE_URL: await db.url(),
        REDIS_URL: process.env.REDIS_URL,
      }),
      ...fakeKeyEnv(),
    },
  });
  const created = creating.mock.results[0];
  if (created?.type !== "return") throw new Error("未捕获API真实数据库实例");
  apiDb = created.value;
  creating.mockRestore();
  worker = buildWorkerServices({
    appEnv: "test",
    prisma: h.prisma,
    clock: h.clock,
    providers: h.fake,
    keys: fakeKeyEnv(),
    assembly: assembleForTest({ entry: "worker" }),
    channel: { enqueue: async () => {}, downForMs: () => 0 },
  });
  const tenant = createTenant({
    tx: api.tx,
    clock: h.clock,
    flow: api.flow,
    assembly: api.assembly,
  });
  const profile = createProfile({
    ...h,
    tx: api.tx,
    clock: h.clock,
    assembly: api.assembly,
    tenant,
    approval: api.approval,
    events: api.events,
    media: api.media,
    keyring: () => TEST_KEYRING,
    wechat: h.fake.wechat,
    currentOpenid: async () => "lyxtest_profile_openid",
  });
  live = { ...h, tx: api.tx, events: api.events, approval: api.approval, profile };
}, 120000);
afterAll(async () => {
  await worker?.closeProfile?.();
  await worker?.shutdownMediaJobs?.();
  worker?.closeMediaJobs?.();
  worker?.closeOrder?.();
  worker?.closeBillingTimers?.();
  worker?.closePublish?.();
  worker?.closeDelivery?.();
  worker?.closeWebhooks?.();
  worker?.closeInvitations?.();
  worker?.closeApproval?.();
  worker?.disableModelBudget?.();
  await Promise.allSettled([
    worker?.closeDocs(),
    worker?.closeNotify(),
    worker?.closeAnalytics?.(),
    worker?.closeStaff?.(),
    worker?.closeSmsHealth?.(),
    worker?.closeCertificates?.(),
    worker?.closeModelBudget?.(),
    worker?.closeMediaDrivers?.(),
    worker?.closeStorageDrivers?.(),
    worker?.documentConverter?.close(),
  ]);
  await worker?.closeAlertFacts?.();
  await api?.close();
  vi.restoreAllMocks();
}, 120000);
async function pending(number: string) {
  const world = await live.owner(),
    ready = await complete(live, world.viewer, number);
  await submit(live, world.viewer, ready.submissionId);
  return { ...world, ready };
}

it("API/worker各自实装：max1真实consumer提交后上报/正式P2/SLA取消；关闭worker不丢旧生命周期或污染API I7", async () => {
  const number = uscc(),
    loser = await pending(number),
    winner = await pending(number);
  const before = await h.prisma.qualificationSubmission.findUniqueOrThrow({
    where: { id: loser.ready.submissionId },
  });
  expect(
    await h.prisma.timer.count({
      where: { subjectId: before.approvalRequestId!, kind: "sla.breach", status: "scheduled" },
    }),
  ).toBeGreaterThan(0);
  await live.profile.approve(reviewer, winner.ready.submissionId, {
    lockVersion: 0,
    confirm: { roundNo: 1 },
  });
  const source = await h.prisma.outboxEvent.findFirstOrThrow({
    where: { aggregateId: winner.store.id, eventType: "store.qualification.approved" },
  });
  await worker.relay();
  const ref = (await h.tx.run((tx) => claimDeliveries(tx, 1000))).claimed.find(
    (r) => r.eventId === source.id && r.subscriber === "profile.onQualificationApproved",
  )!;
  expect(ref).toBeDefined();
  expect(apiDb).not.toBe(h.prisma);
  const apiSql = vi.spyOn(apiDb, "$queryRawUnsafe"),
    workerSql = vi.spyOn(h.prisma, "$queryRawUnsafe");
  const reports = (spy: typeof apiSql) =>
    spy.mock.calls.filter(
      ([query]) => typeof query === "string" && query.includes("invariant_violation"),
    );
  expect(await worker.consume(ref)).toBe("done");
  expect(reports(workerSql)).toHaveLength(1);
  expect(reports(apiSql)).toHaveLength(0);
  expect(await worker.consume(ref)).toBe("stale");
  expect(
    await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: loser.ready.submissionId },
    }),
  ).toMatchObject({ outcome: "rejected", systemRejectCode: "duplicate_entity" });
  expect(
    await h.prisma.timer.findFirstOrThrow({
      where: { subjectId: before.approvalRequestId!, kind: "sla.breach" },
    }),
  ).toMatchObject({ status: "cancelled" });
  expect(
    await h.prisma.invariantViolation.findFirstOrThrow({
      where: { code: "profile.I7", subjectId: loser.ready.submissionId },
    }),
  ).toMatchObject({ autoHealedAt: h.clock.now(), resolvedAt: null });
  const alert = await h.prisma.alertEvent.findFirstOrThrow({
    where: {
      rule: "profile.qualification_duplicate",
      fingerprint: `profile.qualification_duplicate:${loser.ready.submissionId}`,
    },
  });
  expect(alert).toMatchObject({
    severity: "P2",
    kind: "event",
    occurrences: 1,
    lastValue: {
      entityId: loser.entity.id,
      systemRejectCode: "duplicate_entity",
      verifiedEntityId: winner.entity.id,
    },
  });
  expect(JSON.stringify(alert.lastValue)).not.toContain(number);
  expect(await h.prisma.alertEvent.count({ where: { rule: "ops.unknown_rule" } })).toBe(0);
  // 后绑worker不能接管API report；两个真实数据库实例的独立SQL调用精确归属。
  apiSql.mockClear();
  workerSql.mockClear();
  await invariantsOf(api.assembly).report({
    code: "profile.I7",
    module: "profile",
    severity: "P2",
    subject: { type: "qualification_submission", id: loser.ready.submissionId },
    entityId: loser.entity.id,
    detail: { systemRejectCode: "duplicate_entity", verifiedEntityId: winner.entity.id },
    healed: { action: "系统驳回重复主体资质轮次", at: h.clock.now() },
  });
  expect(reports(apiSql)).toHaveLength(1);
  expect(reports(workerSql)).toHaveLength(0);
  apiSql.mockRestore();
  workerSql.mockRestore();
  // 原worker生命周期绑定仍是已装配服务，未知事件只拒绝事件，不报未绑定。
  await expect(
    h.tx.run((tx) =>
      worker.assembly
        .subscriber("profile.onTenantLifecycle")!
        .handle(tx, { id: source.id, type: "lyxtest.invalid", payload: {} }),
    ),
  ).rejects.toThrow("未登记");
  await worker.closeProfile!();
  await expect(
    h.tx.run((tx) => worker.assembly.invariant("profile.I7")!.run!(tx, {}, { now: h.clock.now() })),
  ).rejects.toThrow("未绑定或已关闭");
  const otherNumber = uscc(),
    other = await pending(otherNumber),
    otherWinner = await pending(otherNumber);
  await live.profile.approve(reviewer, otherWinner.ready.submissionId, {
    lockVersion: 0,
    confirm: { roundNo: 1 },
  });
  expect(
    await runInvariants(
      { tx: api.tx, assembly: api.assembly, clock: h.clock },
      { mode: "full", trigger: "manual", codes: ["profile.I7"], entityIds: [other.entity.id] },
    ),
  ).toMatchObject({ status: "succeeded", checksRun: 1, violationsFound: 1, errors: [] });
  expect(
    await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: other.ready.submissionId },
    }),
  ).toMatchObject({ outcome: "rejected", systemRejectCode: "duplicate_entity" });
}, 120000);
