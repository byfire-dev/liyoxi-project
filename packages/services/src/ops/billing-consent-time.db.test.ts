import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createRuntime } from "../runtime.js";
import { createIdentityContext, loadEnv, uuidv7 } from "../kernel/index.js";
import { createNotices } from "../config/index.js";
import { findN5Violations } from "../docs/index.js";
import { createTenant } from "../tenant/index.js";
import {
  proposeFinanceConfig,
  purchaseInvariants,
  seedPlaceholderFinanceConfig,
} from "../billing/index.js";
import {
  createClock,
  createFactories,
  createFakeProviders,
  fakeKeyEnv,
  sampleStaffContext,
  TEST_KEYRING,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";

const db = useSeededDatabase("services"),
  redis = useTestRedis(),
  clock = createClock(new Date("2026-10-15T08:00:00Z"));
let runtime: ReturnType<typeof createRuntime>;
beforeAll(async () => {
  runtime = createRuntime({
    entry: "api",
    env: { ...loadEnv(), ...fakeKeyEnv(), DATABASE_URL: await db.url() },
    version: "billing-consent-time-test",
    clock,
    providers: createFakeProviders({ clock }),
    billingKeyring: TEST_KEYRING,
    redisKeyPrefix: redis.prefix,
  });
}, 120_000);
afterAll(async () => {
  await runtime?.close();
});

it("同意与创建顺序：同意先于新单，跨生效选创建时银行，同版本复用不改证据且故障整笔回滚", async () => {
  const prisma = await db.prisma(),
    make = createFactories({ db: prisma, clock }),
    tenant = createTenant(runtime),
    proposer = await make.staff({ staffRoleKey: "finance", isLead: true }),
    approver = await make.staff({ staffRoleKey: "finance", isLead: true });
  await seedPlaceholderFinanceConfig(
    {
      tx: runtime.tx,
      clock,
      assembly: runtime.assembly,
      bizNo: runtime.bizNo,
      keyring: TEST_KEYRING,
    },
    { proposerId: proposer.id, approverId: approver.id },
  );
  const staffIdentity = (id: string) =>
    createIdentityContext({ actor: { type: "staff", id, client: "admin" } });
  const staff = await sampleStaffContext(prisma, proposer.id, { stepUpAt: clock.now() }),
    reviewer = await sampleStaffContext(prisma, approver.id, { stepUpAt: clock.now() });
  const nextBank = await runtime.tx.run((tx) =>
    proposeFinanceConfig(
      tx,
      { approval: runtime.approval, clock, keyring: TEST_KEYRING },
      staffIdentity(proposer.id),
      {
        configKey: "bank_account",
        payload: {
          accountName: "时序测试收款户（勿转账）",
          bankName: "虚构测试银行",
          accountNo: "0000000000000001",
        },
        changeNote: "测试合法下一银行版本的到点选取",
      },
      staff,
    ),
  );
  await runtime.tx.run((tx) =>
    runtime.approval.approve(tx, staffIdentity(approver.id), {
      approvalId: nextBank.approvalId,
      staff: reviewer,
      lockVersion: 0,
    }),
  );
  const bank = await prisma.financeConfigRevision.findUniqueOrThrow({
    where: { id: nextBank.financeConfigRevisionId },
  });
  if (!bank.effectiveAt) throw new Error("测试银行版本缺真实生效时刻");

  const versions: string[] = [],
    notices = createNotices({ clock, events: runtime.events });
  for (const agreementKey of ["member", "points"]) {
    const id = uuidv7();
    const notice = await runtime.tx.run((tx) =>
      notices.announce(tx, staffIdentity(proposer.id), {
        kind: "agreement_version",
        refId: id,
        title: "时序测试协议",
        summary: "仅供隔离测试",
        effectiveAt: clock.now(),
        shortNoticeReason: "隔离测试即时协议",
        link: { route: "agreement.version", params: { agreementVersionId: id } },
        createdByStaffId: proposer.id,
      }),
    );
    versions.push(
      (
        await make.agreementVersion({
          id,
          agreementKey,
          createdByStaffId: proposer.id,
          siteNoticeId: notice.siteNoticeId,
        })
      ).id,
    );
  }
  async function buyer() {
    const own = await make.merchant({ verified: true });
    const membership = await runtime.tx.run((tx) =>
      tenant.resolveMembership(tx, {
        merchantUserId: own.user.id,
        storeId: own.store.id,
      }),
    );
    if (!membership || membership.role !== "owner") throw new Error("测试老板关系未建立");
    return {
      ...own,
      actor: {
        ctx: createIdentityContext({
          actor: { type: "merchant", id: own.user.id, role: "owner", client: "weapp" },
          entityId: own.entity.id,
          storeId: own.store.id,
        }),
        membership,
      },
    };
  }
  const own = await buyer(),
    rollbackOwner = await buyer(),
    client = { platform: "android", appVersion: "1.0.0" },
    plan = await prisma.plan.findUniqueOrThrow({ where: { code: "pro" } });
  clock.set(new Date(bank.effectiveAt.getTime() - 50));
  const quote = await runtime.billing.quotePlanPurchase(own.actor, client, {
    planId: plan.id,
    months: 1,
  });
  const body = {
    planId: plan.id,
    months: 1,
    channel: "bank_transfer" as const,
    expectAmountFen: quote.payFen,
    agreementVersionIds: versions,
  };
  const quoteAt = clock.now();
  const realConsent = runtime.docs.assertConsents;
  const injectedFailure = new Error("测试同意写入后回滚");
  let failAfterConsent = false;
  // Delegate all validation/writes to the actual public docs method. Only the injected clock moves.
  const consent = vi.spyOn(runtime.docs, "assertConsents").mockImplementation(async (...args) => {
    clock.advance(10);
    const receipt = await realConsent(...args);
    clock.advance(100);
    if (failAfterConsent) throw injectedFailure;
    return receipt;
  });
  try {
    const created = await runtime.billing.createOrder(own.actor, client, body);
    const row = await prisma.billingOrder.findUniqueOrThrow({
      where: { id: created.paymentOrderId },
    });
    const signed = await prisma.agreementConsent.findMany({
      where: { bizType: "billing_order", bizId: row.id },
      orderBy: { agreementKey: "asc" },
    });
    expect(signed.map((entry) => entry.agreementKey)).toEqual(["member", "points"]);
    for (const entry of signed) {
      expect(entry.consentedAt.getTime()).toBeGreaterThan(quoteAt.getTime());
      expect(entry.consentedAt.getTime()).toBeLessThanOrEqual(row.createdAt.getTime());
    }
    expect(row.createdAt).toEqual(row.updatedAt);
    expect(row.createdAt.getTime()).toBeGreaterThan(bank.effectiveAt.getTime());
    expect(row.bankAccountFinanceConfigRevisionId).toBe(bank.id);
    expect(row.expiresAt.getTime()).toBeGreaterThan(row.createdAt.getTime());
    const bankCheck = purchaseInvariants.find((entry) => entry.code === "payment.I12");
    if (!bankCheck?.run) throw new Error("缺真实银行版本不变量");
    expect(
      await runtime.tx.run((tx) =>
        bankCheck.run!(tx, { entityIds: [own.entity.id] }, { now: clock.now() }),
      ),
    ).toEqual([]);

    clock.advance(1000);
    const reused = await runtime.billing.createOrder(own.actor, client, body);
    expect(reused.paymentOrderId).toBe(row.id);
    expect(await prisma.billingOrder.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(
      await prisma.agreementConsent.findMany({
        where: { bizType: "billing_order", bizId: row.id },
        orderBy: { agreementKey: "asc" },
      }),
    ).toEqual(signed);

    const file = await make.fileObject({
      category: "pay_receipt",
      bucket: "secure",
      scopeType: "entity",
      entityId: own.entity.id,
      uploadActorType: "merchant",
      uploadActorId: own.user.id,
      uploadClient: "weapp",
    });
    await runtime.billing.submitProof(own.actor, client, row.id, file.id);
    const proof = await prisma.transferProof.findFirstOrThrow({
      where: { billingOrderId: row.id, reviewStatus: "pending" },
    });
    const currentFinance = await sampleStaffContext(prisma, proposer.id, {
      stepUpAt: clock.now(),
    });
    await runtime.billing.confirmProof(staffIdentity(proposer.id), currentFinance, proof.id, {
      lockVersion: proof.lockVersion,
      bankSerialNo: uuidv7(),
      confirmChecks: ["bank_statement_checked"],
      confirm: { orderNo: row.orderNo, receivedAmountFen: row.amountFen },
    });
    expect((await prisma.billingOrder.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      "paid",
    );
    expect(await runtime.tx.run((tx) => findN5Violations(tx, runtime.assembly))).toEqual([]);

    failAfterConsent = true;
    await expect(runtime.billing.createOrder(rollbackOwner.actor, client, body)).rejects.toBe(
      injectedFailure,
    );
    expect(await prisma.billingOrder.count({ where: { entityId: rollbackOwner.entity.id } })).toBe(
      0,
    );
    expect(
      await prisma.agreementConsent.count({ where: { entityId: rollbackOwner.entity.id } }),
    ).toBe(0);
  } finally {
    consent.mockRestore();
  }
}, 60_000);
