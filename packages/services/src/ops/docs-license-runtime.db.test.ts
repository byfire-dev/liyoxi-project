import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  createLicenseConvergenceFixture,
  assembleForTest,
  createFakeProviders,
  createTestWorkerServices,
  TEST_KEYRING,
  createFactories,
  sampleStaffContext,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { claimDeliveries, consumeDelivery } from "../events/index.js";
import type { DeliveryRef } from "../events/index.js";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import {
  findN6Violations,
  findN16Violations,
  licenseContentFingerprint,
  parseLicenseLetterSnapshot,
} from "../docs/index.js";
import { createDocsLicenseAssembly } from "./docs-license-runtime.js";

const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
type Fixture = Awaited<ReturnType<typeof createLicenseConvergenceFixture>>;
const fixtures: Fixture[] = [];
async function fresh() {
  const f = await createLicenseConvergenceFixture(await db.prisma(), {
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  });
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function deliver(
  f: Fixture,
  eventId: string,
  consume?: (ref: DeliveryRef) => Promise<string>,
) {
  let ref: DeliveryRef | undefined;
  for (let attempt = 0; attempt < 20 && !ref; attempt++) {
    await f.runtime.events.expand();
    ref = (await f.runtime.tx.run((tx) => claimDeliveries(tx, 200))).claimed.find(
      (item) => item.eventId === eventId && item.subscriber === "docs.onLicenseFacts",
    );
  }
  expect(ref).toBeDefined();
  if (consume) return consume(ref!);
  return consumeDelivery(
    {
      tx: f.runtime.tx,
      subscribers: f.runtime.events.subscribers,
      alerts: {
        raise: async () => {
          throw new Error("lyxtest.unexpected-license-delivery-failure");
        },
      },
    },
    ref!,
  );
}
const letters = async (f: Fixture) =>
  (await db.prisma()).licenseLetter.findMany({
    where: { orderItemId: f.order.itemId },
    orderBy: { id: "asc" },
  });

describe("授权实际assembly", { timeout: 120000 }, () => {
  it("真实worker消费使用自己的origin/密钥注入，closeDocs不撤销API的scope", async () => {
    const f = await fresh();
    await f.start();
    const prisma = await db.prisma(),
      worker = createTestWorkerServices({
        prisma,
        clock: f.clock,
        assembly: assembleForTest({ entry: "worker" }),
        providers: createFakeProviders({ clock: f.clock }),
        channel: { enqueue: async () => {}, downForMs: () => 0 },
        keys: {
          PORTAL_PUBLIC_ORIGIN: "https://worker.example.invalid",
          DATA_KEYS: {
            current: TEST_KEYRING.currentKid,
            keys: Object.fromEntries(
              TEST_KEYRING.kids.map((kid) => [kid, TEST_KEYRING.dataKey(kid)!.toString("base64")]),
            ),
          },
          BIDX_KEYS: {
            phone: TEST_KEYRING.bidxKey("phone").toString("base64"),
            uscc: TEST_KEYRING.bidxKey("uscc").toString("base64"),
          },
        },
      });
    try {
      const started = await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: f.order.id, eventType: "order.started" },
      });
      expect(await deliver(f, started.id, worker.consume)).toBe("done");
      const revisions = await prisma.licenseLetterRevision.findMany({
        where: { licenseLetter: { orderItemId: f.order.itemId } },
      });
      expect(revisions).toHaveLength(2);
      expect(
        revisions.every(
          (revision) =>
            new URL((revision.letterSnapshot as { verifyUrl: string }).verifyUrl).origin ===
            "https://worker.example.invalid",
        ),
      ).toBe(true);
      const saved = worker.assembly.subscriber("docs.onLicenseFacts")!;
      await worker.closeDocs();
      await expect(
        f.runtime.tx.run((tx) =>
          saved.handle(tx, {
            id: started.id,
            type: started.eventType,
            payload: started.payload as Record<string, unknown>,
          }),
        ),
      ).rejects.toThrow("已经关闭");
      expect(
        await f.runtime.tx.run((tx) =>
          f.runtime.licenseLetters.ensureLetters(tx, [f.order.itemId], "api:after-worker-close"),
        ),
      ).toMatchObject({ created: 0, revised: 0, voided: 0 });
    } finally {
      worker.disableModelBudget?.();
      await worker.shutdownMediaJobs?.();
      for (const key of [
        "closeDocs",
        "closeNotify",
        "closeAnalytics",
        "closeStaff",
        "closeApproval",
        "closeProfile",
        "closeInvitations",
        "closeSmsHealth",
        "closeAlertFacts",
        "closeCertificates",
        "closeBackups",
        "closeAlertDispatcher",
        "closeProbes",
        "closeModelBudget",
        "closeOrder",
        "closeBillingTimers",
        "closePublish",
        "closeDelivery",
        "closeWebhooks",
        "closeMediaJobs",
        "closeMediaDrivers",
        "closeStorageDrivers",
      ] as const)
        await worker[key]?.();
      await worker.documentConverter?.close();
    }
  });
  it("正式relay/lease/consume消费开工和首次方案确认，双账号变一；实际取消退款后迟到started不复活", async () => {
    const f = await fresh();
    await f.start();
    const prisma = await db.prisma(),
      started = await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: f.order.id, eventType: "order.started" },
      });
    expect(f.runtime.assembly.subscriber("docs.onLicenseFacts")).toBe(
      f.runtime.assembly.subscribers.find((item) => item.name === "docs.onLicenseFacts"),
    );
    expect(await deliver(f, started.id)).toBe("done");
    expect((await letters(f)).filter((letter) => letter.status !== "voided")).toHaveLength(2);
    await f.confirmAccounts([f.accounts[0]]);
    const confirmed = await prisma.outboxEvent.findFirstOrThrow({
      where: {
        eventType: "plan.confirmed",
        payload: { path: ["dramaOrderId"], equals: f.order.id },
      },
      orderBy: { id: "desc" },
    });
    expect(await deliver(f, confirmed.id)).toBe("done");
    expect((await letters(f)).filter((letter) => letter.status !== "voided")).toHaveLength(1);
    await cancel(f);
    const cancelled = await prisma.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: f.order.itemId,
        eventType: { in: ["order.item.cancelled", "order.item.refunded", "order.item.terminated"] },
      },
      orderBy: { id: "desc" },
    });
    expect(await deliver(f, cancelled.id)).toBe("done");
    expect((await letters(f)).every((letter) => letter.status === "voided")).toBe(true);
    const evidence = await prisma.licenseLetterRevision.count({
      where: { licenseLetter: { orderItemId: f.order.itemId } },
    });
    // Replay an actual old event through the saved real subscriber. Delivery itself is already done.
    await f.runtime.tx.run((tx) =>
      f.runtime.assembly.subscriber("docs.onLicenseFacts")!.handle(tx, {
        id: started.id,
        type: started.eventType,
        payload: started.payload as Record<string, unknown>,
      }),
    );
    expect((await letters(f)).every((letter) => letter.status === "voided")).toBe(true);
    expect(
      await prisma.licenseLetterRevision.count({
        where: { licenseLetter: { orderItemId: f.order.itemId } },
      }),
    ).toBe(evidence);

    // Explicit historical corruption injection, not a renderer, signature or production-ready
    // fixture. Two already-voided letters get independent faults: queued rev 1→3, and a ready
    // record whose asserted PDF digest disagrees with bytes actually stored by the media owner.
    const originals = await prisma.licenseLetterRevision.findMany({
      where: { licenseLetter: { orderItemId: f.order.itemId } },
    });
    const voided = await letters(f),
      removed = voided.find((letter) => letter.voidReason === "account_removed")!,
      cancelledLetter = voided.find((letter) => letter.id !== removed.id)!;
    const faultData = (letterId: string, revNo: number) => {
      const source = originals.find((revision) => revision.licenseLetterId === letterId)!;
      const snapshot = parseLicenseLetterSnapshot(source.letterSnapshot),
        url = new URL(snapshot.verifyUrl);
      url.searchParams.set("rev", String(revNo));
      const value = { ...snapshot, revNo, verifyUrl: url.toString() };
      return {
        id: uuidv7(),
        licenseLetterId: letterId,
        revNo,
        reason: "correction",
        triggerRef: "fault:n6-history-evidence",
        letterSnapshot: JSON.parse(JSON.stringify(value)),
        contentFp: licenseContentFingerprint(value),
        templateVersion: source.templateVersion,
        renderStatus: "queued",
        createdAt: f.clock.now(),
        updatedAt: f.clock.now(),
      };
    };
    await prisma.licenseLetterRevision.create({ data: faultData(cancelledLetter.id, 3) });
    const bytes = new TextEncoder().encode(
      "%PDF-1.4\n% N6 historical corruption input only\n%%EOF\n",
    );
    const file = await f.runtime.media.putSystemFile({
      category: "legal_doc",
      entityId: f.merchant.entity.id,
      storeId: null,
      objectKey: `lyxtest/n6-history/${uuidv7()}.pdf`,
      fileName: "n6-history-fault.pdf",
      body: bytes,
    });
    expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const wrongHash = createHash("sha256").update("different historical bytes").digest("hex");
    expect(wrongHash).not.toBe(file.sha256);
    await prisma.licenseLetterRevision.create({
      data: {
        ...faultData(removed.id, 2),
        renderStatus: "ready",
        fileId: file.fileId,
        pdfSha256: wrongHash,
        signMode: "stamp",
        platformSignedAt: f.clock.now(),
        readyAt: f.clock.now(),
      },
    });
    const historicalRows = () =>
      prisma.licenseLetter.findMany({
        where: { orderItemId: f.order.itemId },
        orderBy: { id: "asc" },
        select: {
          id: true,
          status: true,
          currentRevisionId: true,
          lockVersion: true,
          revisions: {
            orderBy: { revNo: "asc" },
            select: { id: true, revNo: true, renderStatus: true, fileId: true, pdfSha256: true },
          },
        },
      });
    const beforeHistoryCheck = await historicalRows();
    expect(
      beforeHistoryCheck.every(
        (letter) => letter.status === "voided" && letter.currentRevisionId === null,
      ),
    ).toBe(true);
    const historicalViolations = await f.runtime.tx.run((tx) =>
      findN6Violations(tx, f.licenseDeps, { entityIds: [f.merchant.entity.id] }),
    );
    expect(historicalViolations.map((row) => row.detail.problem).sort()).toEqual([
      "ready_pdf_hash_mismatch",
      "revision_sequence_gap",
    ]);
    expect(
      historicalViolations.every(
        (row) => row.entityId === f.merchant.entity.id && row.healed === undefined,
      ),
    ).toBe(true);
    const other = await createFactories({ db: prisma, clock: f.clock }).merchant({
      verified: true,
    });
    expect(
      await f.runtime.tx.run((tx) =>
        findN6Violations(tx, f.licenseDeps, { entityIds: [other.entity.id] }),
      ),
    ).toEqual([]);
    expect(await historicalRows()).toEqual(beforeHistoryCheck);
    expect(f.runtime.assembly.invariant("docs.N6")).toBeUndefined();
  });

  it("N6从当前候选发现全部缺信并真实heal；N16核真实归属，缺owner引用不能当零违规", async () => {
    const f = await fresh();
    const { ticketId, planId } = await f.start();
    // Target-resolver unit cases use real owned rows; no archived event or phase is fabricated.
    for (const payload of [
      { deliveryTicketId: ticketId },
      { deliveryPlanId: planId },
      { orderItemIds: [f.order.itemId] },
    ]) {
      expect(
        await f.runtime.tx.run((tx) =>
          f.licenseDeps.facts.eventItemIds(tx, {
            id: f.order.id,
            type: "ticket.archived",
            payload,
          }),
        ),
      ).toEqual([f.order.itemId]);
    }
    await expect(
      f.runtime.tx.run((tx) =>
        f.licenseDeps.facts.eventItemIds(tx, {
          id: f.order.id,
          type: "order.started",
          payload: { dramaOrderId: uuidv7() },
        }),
      ),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    await expect(
      f.runtime.tx.run((tx) =>
        f.licenseDeps.facts.eventItemIds(tx, {
          id: f.order.id,
          type: "order.started",
          payload: { orderItemIds: [] },
        }),
      ),
    ).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
    expect(await letters(f)).toHaveLength(0);
    const scope = { entityIds: [f.merchant.entity.id] };
    // PR1 ships the complete checker as a public function. Formal activation waits for PR2 after 07.
    expect(f.runtime.assembly.invariant("docs.N6")).toBeUndefined();
    expect(f.runtime.assembly.invariants.some((item) => item.code === "docs.N6")).toBe(false);
    const violations = await f.runtime.tx.run((tx) => findN6Violations(tx, f.licenseDeps, scope));
    expect(violations).toHaveLength(2);
    expect(violations.every((row) => row.healed?.action === "reconcileLetters")).toBe(true);
    expect((await letters(f)).filter((row) => row.status !== "voided")).toHaveLength(2);
    expect(await f.runtime.tx.run((tx) => findN6Violations(tx, f.licenseDeps, scope))).toEqual([]);
    expect(
      await f.runtime.tx.run((tx) =>
        f.runtime.assembly.invariant("docs.N16")!.run!(tx, scope, { now: f.clock.now() }),
      ),
    ).toEqual([]);
    const missing = {
      ...f.licenseDeps,
      facts: {
        ...f.licenseDeps.facts,
        readReferences: async (...args: Parameters<typeof f.licenseDeps.facts.readReferences>) => ({
          ...(await f.licenseDeps.facts.readReferences(...args)),
          accounts: [],
        }),
      },
    };
    expect(await f.runtime.tx.run((tx) => findN16Violations(tx, missing, scope))).toHaveLength(2);
  });

  it("两个真实runtime关闭A后A旧引用拒绝，B继续，索引与数组同对象", async () => {
    const a = await fresh(),
      b = await fresh();
    await a.start();
    await b.start();
    const saved = a.runtime.assembly.subscriber("docs.onLicenseFacts")!,
      ensure = a.runtime.licenseLetters.ensureLetters;
    const bHandler = b.runtime.assembly.subscriber("docs.onLicenseFacts")!;
    expect(saved).not.toBe(bHandler);
    expect(bHandler).toBe(
      b.runtime.assembly.subscribers.find((item) => item.name === bHandler.name),
    );
    await a.close();
    await expect(
      b.runtime.tx.run((tx) => ensure(tx, [a.order.itemId], "closed:ensure")),
    ).rejects.toThrow("已经关闭");
    await expect(
      b.runtime.tx.run((tx) =>
        saved.handle(tx, {
          id: a.order.id,
          type: "order.started",
          payload: { v: 1, dramaOrderId: a.order.id },
        }),
      ),
    ).rejects.toThrow("已经关闭");
    expect(
      await b.runtime.tx.run((tx) =>
        b.runtime.licenseLetters.ensureLetters(tx, [b.order.itemId], "active:ensure"),
      ),
    ).toMatchObject({ created: 2 });
    expect(await letters(a)).toHaveLength(0);
    expect(await letters(b)).toHaveLength(2);
  });

  it("实例close等待在途owner读取，返回前失败回滚，缺绑定不借另一实例", async () => {
    const f = await fresh();
    await f.start();
    const scope = createDocsLicenseAssembly(f.runtime.assembly);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    scope.attach({
      ...f.licenseDeps,
      facts: {
        ...f.licenseDeps.facts,
        getLicenseFacts: async (tx, ids) => {
          enter();
          await gate;
          return f.licenseDeps.facts.getLicenseFacts(tx, ids);
        },
      },
    });
    const work = f.runtime.tx.run((tx) =>
        scope.ensureLetters(tx, [f.order.itemId], "close:inflight"),
      ),
      settled = Promise.allSettled([work]);
    await entered;
    let finished = false;
    const closing = scope.close().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await closing;
    expect((await settled)[0]?.status).toBe("rejected");
    expect(await letters(f)).toHaveLength(0);
    const unbound = createDocsLicenseAssembly(f.runtime.assembly);
    await expect(
      f.runtime.tx.run((tx) => unbound.ensureLetters(tx, [f.order.itemId], "unbound")),
    ).rejects.toThrow("尚未绑定");
    await unbound.close();
    expect(() => unbound.attach(f.licenseDeps)).toThrow();
    expect(
      await f.runtime.tx.run((tx) =>
        f.runtime.licenseLetters.ensureLetters(tx, [f.order.itemId], "still:active"),
      ),
    ).toMatchObject({ created: 2 });
  });
});

/** Real post-start refund commands; existing KYC, staff and agreement inputs stay historical fixture data. */
async function cancel(f: Fixture) {
  const prisma = await db.prisma(),
    make = createFactories({ db: prisma, clock: f.clock });
  const actor = async () => {
    const row = await make.staff({ staffRoleKey: "super_admin" });
    return {
      ctx: createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" } }),
      staff: await sampleStaffContext(prisma, row.id, { stepUpAt: f.clock.now() }),
    };
  };
  const requester = await actor(),
    approver = await actor(),
    executor = await actor();
  const quote = await f.runtime.cancelRequests.quote(requester, f.order.id, {
    reasonCode: "merchant_request",
  });
  let request = await f.runtime.cancelRequests.create(requester, f.order.id, {
    reasonCode: "merchant_request",
    note: "授权测试商家真实取消并退款",
    expect: quote.expect,
  });
  if (request.status === "pending_approval")
    request = await f.runtime.cancelRequests.approve(approver, request.cancelRequestId, {
      lockVersion: request.approval.lockVersion,
      confirm: { requestNo: request.requestNo, totalRefundPoints: request.totalRefundPoints },
      confirmChecks: ["stage_rule_amount_checked"],
    });
  if (request.status === "pending_execution")
    request = await f.runtime.cancelRequests.execute(executor, request.cancelRequestId, {
      confirm: { requestNo: request.requestNo, totalRefundPoints: request.totalRefundPoints },
      confirmChecks: ["order_points_checked"],
    });
  expect(request.status).toBe("done");
}
