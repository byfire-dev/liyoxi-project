import { afterEach, beforeEach, expect, it } from "vitest";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import { correctLicenseLetter, voidLicenseLetter } from "../docs/index.js";
import { createRuntime } from "../runtime.js";
import { createLicenseConvergenceFixture } from "./license-convergence.fixture.js";
import { useSeededDatabase } from "./data/seeded.js";
import { useTestRedis } from "./redis.js";
import { TEST_KEYRING } from "./data/seal.js";
import {
  assertM1ReadyDocuments,
  createM1DocsConsumer,
  createM1LicenseRendering,
  readM1DocsBacklog,
} from "./m1-docs.js";
import { m1Transport } from "./m1-transport.js";

const db = useSeededDatabase("services", { max: 1 });
const redis = useTestRedis();
let fixture: Awaited<ReturnType<typeof createLicenseConvergenceFixture>> | undefined;
let worker: ReturnType<typeof createRuntime> | undefined;
let consumer: Awaited<ReturnType<typeof createM1DocsConsumer>> | undefined;
beforeEach(async () => {
  await db.reset();
  await redis.flush();
});
afterEach(async () => {
  await consumer?.close();
  await worker?.close();
  await fixture?.close();
  consumer = undefined;
  worker = undefined;
  fixture = undefined;
});

it("自有scope真实docs两槽消费者出件，排空覆盖ready/hash/current/issued；读观察不改业务", async () => {
  const prisma = await db.prisma();
  fixture = await createLicenseConvergenceFixture(prisma, {
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  });
  const own = fixture;
  const engine = createM1LicenseRendering(own.clock);
  worker = createRuntime({
    entry: "worker",
    env: own.runtime.env,
    version: "w507-owned-transport",
    clock: own.clock,
    providers: own.runtime.providers,
    redisKeyPrefix: redis.prefix,
    billingKeyring: TEST_KEYRING,
    licenseRendering: engine,
  });
  const runtime = worker;
  let open = true;
  const assertOwned = () => {
    if (!open || runtime.env.DATABASE_URL !== own.runtime.env.DATABASE_URL)
      throw new Error("owned scope lost");
  };
  consumer = await createM1DocsConsumer(runtime, redis.prefix, assertOwned);
  await own.start();
  const transport = m1Transport(
    runtime,
    assertOwned,
    new Date(own.clock.now().getTime() - 25 * 3600000),
  );
  const drained = await transport.drainEvents();
  expect(drained.consumed).toBeGreaterThan(0);
  const rows = await prisma.licenseLetter.findMany({
    where: { orderItemId: own.order.itemId },
    include: { currentRevision: true, revisions: true },
  });
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.currentRevision?.renderStatus).toBe("ready");
    expect(row.currentRevision?.signMode).toBe("platform_cert");
    expect(row.currentRevision?.pdfSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row.revisions).toHaveLength(1);
  }
  expect(await assertM1ReadyDocuments(runtime)).toBe(2);
  const before = await prisma.licenseLetterRevision.findMany({ orderBy: { id: "asc" } });
  expect(await assertM1ReadyDocuments(runtime)).toBe(2);
  expect(await prisma.licenseLetterRevision.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  expect(await prisma.outboxEvent.count({ where: { publishedAt: null } })).toBe(0);
  expect(await prisma.outboxDelivery.count({ where: { status: { not: "done" } } })).toBe(0);
  await consumer.close();
  consumer = undefined;
  open = false;
}, 90000);

it("历史失败与作废待渲染不阻塞当前任务，但作废历史ready对象仍核完整性", async () => {
  const prisma = await db.prisma();
  fixture = await createLicenseConvergenceFixture(prisma, {
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  });
  const own = fixture;
  worker = createRuntime({
    entry: "worker",
    env: own.runtime.env,
    version: "w507-required-docs",
    clock: own.clock,
    providers: own.runtime.providers,
    redisKeyPrefix: redis.prefix,
    billingKeyring: TEST_KEYRING,
    licenseRendering: createM1LicenseRendering(own.clock),
  });
  const runtime = worker;
  const assertOwned = () => {
    if (runtime.env.DATABASE_URL !== own.runtime.env.DATABASE_URL)
      throw new Error("owned scope lost");
  };
  consumer = await createM1DocsConsumer(runtime, redis.prefix, assertOwned);
  await own.start();
  const transport = m1Transport(
    runtime,
    assertOwned,
    new Date(own.clock.now().getTime() - 25 * 3600000),
  );
  await transport.drainEvents();
  const letter = await prisma.licenseLetter.findFirstOrThrow({
    where: { orderItemId: own.order.itemId },
    include: { currentRevision: { include: { file: true } } },
    orderBy: { id: "asc" },
  });
  const originalFile = letter.currentRevision!.file!;
  const staff = createIdentityContext({
    actor: { type: "system", job: "lyxtest.m1_required_docs" },
    requestId: "owned-required-docs",
  });
  const missingDeps = {
    ...own.licenseDeps,
    snapshot: {
      ...own.licenseDeps.snapshot,
      licensee: async (
        tx: Parameters<typeof own.licenseDeps.snapshot.licensee>[0],
        input: Parameters<typeof own.licenseDeps.snapshot.licensee>[1],
      ) => ({ ...(await own.licenseDeps.snapshot.licensee(tx, input)), name: "缺字𠮷测试" }),
    },
  };
  const correction = {
    licenseLetterId: letter.id,
    correctionKinds: ["licensee_name" as const],
    note: "自有测试资料变更",
  };
  const failed = await runtime.tx.run((tx) =>
    correctLicenseLetter(tx, missingDeps, staff, correction),
  );
  await expect(transport.drainEvents()).rejects.toThrow();
  expect(await runtime.tx.run(readM1DocsBacklog)).toEqual({ docsPending: 0, docsFailed: 1 });
  await runtime.tx.run((tx) => correctLicenseLetter(tx, own.licenseDeps, staff, correction));
  await transport.drainEvents();
  expect(
    await prisma.licenseLetterRevision.findUniqueOrThrow({ where: { id: failed.revisionId } }),
  ).toMatchObject({ renderStatus: "failed" });
  expect(await runtime.tx.run(readM1DocsBacklog)).toEqual({ docsPending: 0, docsFailed: 0 });
  expect(await assertM1ReadyDocuments(runtime)).toBe(3);
  // Queue another real immutable correction, then legally void before the queue can be dispatched.
  const obsolete = await runtime.tx.run((tx) =>
    correctLicenseLetter(tx, missingDeps, staff, correction),
  );
  await runtime.tx.run((tx) =>
    voidLicenseLetter(tx, own.licenseDeps, staff, {
      licenseLetterId: letter.id,
      note: "自有测试作废重出",
    }),
  );
  expect(await runtime.tx.run(readM1DocsBacklog)).toEqual({ docsPending: 1, docsFailed: 0 });
  await transport.drainEvents();
  expect(await prisma.licenseLetter.findUniqueOrThrow({ where: { id: letter.id } })).toMatchObject({
    status: "voided",
  });
  expect(await runtime.tx.run(readM1DocsBacklog)).toEqual({ docsPending: 0, docsFailed: 0 });
  expect(await assertM1ReadyDocuments(runtime)).toBe(4);
  // Corrupt only owned fake bytes and restore them; no runtime spread invokes unrelated lazy getters.
  const storage = runtime.providers.storage;
  if (!("objects" in storage) || !(storage.objects instanceof Map))
    throw new Error("owned object map missing");
  const stored: unknown = storage.objects.get(`secure/${originalFile.objectKey}`);
  if (
    !stored ||
    typeof stored !== "object" ||
    !("body" in stored) ||
    !(stored.body instanceof Uint8Array)
  )
    throw new Error("owned object bytes missing");
  const original = stored.body[0]!;
  try {
    stored.body[0] = original ^ 1;
    await expect(assertM1ReadyDocuments(runtime)).rejects.toThrow("实际PDF字节");
  } finally {
    stored.body[0] = original;
  }
  expect(
    (await prisma.licenseLetterRevision.findUniqueOrThrow({ where: { id: obsolete.revisionId } }))
      .renderStatus,
  ).not.toBe("ready");
}, 90000);

it("非作废信缺首版/current不能因ready扫描为空而通过", async () => {
  const prisma = await db.prisma();
  fixture = await createLicenseConvergenceFixture(prisma, {
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  });
  const own = fixture;
  await own.start();
  const [fact] = await own.runtime.tx.run((tx) =>
    own.licenseDeps.facts.getLicenseFacts(tx, [own.order.itemId]),
  );
  const account = fact?.accounts[0];
  if (!fact || !account) throw new Error("owned legal input missing");
  expect(await prisma.licenseLetter.count({ where: { orderItemId: own.order.itemId } })).toBe(0);
  // Explicitly incomplete evidence in this isolated DB, based on real owned order/account facts.
  // There is no revision DELETE/trigger bypass and no claim that this is a legal production writer.
  await prisma.licenseLetter.create({
    data: {
      id: uuidv7(),
      letterNo: `TSQ2026010500000-1-${account.platform === "douyin" ? "DY" : "SPH"}`,
      dramaOrderId: fact.orderId,
      orderItemId: fact.orderItemId,
      channelAccountId: account.channelAccountId,
      entityId: fact.entityId,
      storeId: fact.storeId,
      dramaId: fact.dramaId,
      platform: account.platform,
      status: "pending_effective",
      periodStart: null,
      periodEnd: new Date(`${fact.usageEndDate}T00:00:00Z`),
      currentRevisionId: null,
      verifyCode: "0123456789ABCDEF",
      createdAt: own.clock.now(),
      updatedAt: own.clock.now(),
    },
  });
  expect(await own.runtime.tx.run(readM1DocsBacklog)).toEqual({ docsPending: 0, docsFailed: 0 });
  await expect(assertM1ReadyDocuments(own.runtime)).rejects.toThrow("缺少最新ready版次或current");
}, 90000);
