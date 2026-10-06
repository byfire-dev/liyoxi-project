// W1-11b："m.wallet.get", "m.purchasePolicy.get", "m.plan.list", "m.plan.quote", "m.paymentOrder.create", "m.paymentOrder.get", "m.paymentOrder.transferProof.create",
// "admin.paymentOrder.get", "admin.transferProof.list", "admin.transferProof.summary", "admin.transferProof.get", "admin.transferProof.confirm", "admin.transferProof.reject"。
import { beforeAll, describe, expect, it } from "vitest";
import {
  seedPlaceholderFinanceConfig,
  proposeFinanceConfig,
  createIdentityContext,
  createNotices,
  runSeed,
  security,
  uuidv7,
} from "@liyoxi/services";
import { createFactories, signInAsStaff, sampleStaffContext } from "@liyoxi/services/testing";
import type { FakeStorage, SignedInStaff } from "@liyoxi/services/testing";
import { planOrderContentSchema } from "@liyoxi/contract";
import type { PaymentOrderDetail, PlanQuote } from "@liyoxi/contract";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
import { merchantServicesOf } from "../src/merchant/services.js";
const h = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof h.db.prisma>>,
  finance: SignedInStaff,
  peer = 0;
let versions: string[];
type Buyer = { owner: SignedInMerchant; entityId: string; storeId: string };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
async function data<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { data: T }).data;
}
async function error(res: Response, status: number, code: string) {
  expect(res.status, await res.clone().text()).toBe(status);
  expect(await res.json()).toMatchObject({ error: code });
}
const post = (path: string, json: unknown, headers: Record<string, string>, key = uuidv7()) =>
  api.request(`/api/v1${path}`, {
    method: "POST",
    json,
    headers: { ...headers, "Idempotency-Key": key },
    peer: `198.19.79.${++peer % 250}`,
  });
async function buyer(verified = true): Promise<Buyer> {
  const owner = await signInAsMerchant(api);
  const made = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  if (verified)
    await db.entity.update({
      where: { id: made.entityId },
      data: { verificationStatus: "pending" },
    });
  return { owner, entityId: made.entityId, storeId: made.storeId };
}
async function quote(b: Buyer, months = 1) {
  const plans = await data<{ items: { planId: string }[] }>(
    await api.request("/api/v1/m/plans", { headers: b.owner.withStore(b.storeId) }),
  );
  return data<PlanQuote>(
    await post(
      "/m/plans/quote",
      { planId: plans.items[0]!.planId, months },
      b.owner.withStore(b.storeId),
    ),
  );
}
const orderBody = (q: PlanQuote) => ({
  planId: q.planId,
  months: q.months,
  channel: "bank_transfer",
  expectAmountFen: q.payFen,
  agreementVersionIds: versions,
});
async function order(b: Buyer, q?: PlanQuote) {
  return data<PaymentOrderDetail>(
    await post("/m/payment-orders", orderBody(q ?? (await quote(b))), b.owner.withStore(b.storeId)),
  );
}
async function file(b: Buyer) {
  const registered = await data<{ items: { fileId: string; key: string }[] }>(
    await post(
      "/m/files",
      {
        category: "pay_receipt",
        files: [{ fileName: "receipt.png", sizeBytes: "8", clientToken: uuidv7() }],
      },
      b.owner.withStore(b.storeId),
    ),
  );
  const f = registered.items[0]!;
  (api.runtime.providers.storage as FakeStorage).put(
    { bucket: "secure", key: f.key },
    png,
    "image/png",
  );
  await data(await post(`/m/files/${f.fileId}/complete`, {}, b.owner.withStore(b.storeId)));
  const job = await db.mediaJob.findUniqueOrThrow({ where: { dedupeKey: `promote:${f.fileId}` } });
  await api.runtime.media.promote({ jobId: job.id });
  return f.fileId;
}
async function proof(b: Buyer, o: PaymentOrderDetail) {
  return data<PaymentOrderDetail>(
    await post(
      `/m/payment-orders/${o.paymentOrderId}/transfer-proofs`,
      { fileId: await file(b) },
      b.owner.withStore(b.storeId),
    ),
  );
}
const confirm = (o: PaymentOrderDetail, serial = uuidv7()) => ({
  lockVersion: 0,
  bankSerialNo: serial,
  confirmChecks: ["bank_statement_checked"],
  confirm: { orderNo: o.orderNo, receivedAmountFen: o.amountFen },
});
const getProof = async (id: string, staff = finance) =>
  data<{ lockVersion: number; reviewStatus: string; actions: string[]; ocr: { status: string } }>(
    await awaitableRequest(id, staff),
  );
async function awaitableRequest(id: string, staff: SignedInStaff) {
  return api.request(`/api/v1/admin/transfer-proofs/${id}`, { headers: staff.headers });
}
async function approveConfig(
  configKey: "bank_account" | "purchase_policy" | "controls",
  payload: unknown,
) {
  const proposer = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() });
  const approver = await signInAsStaff(db, {
    roleKey: "finance",
    isLead: true,
    now: api.clock.now(),
  });
  const identity = (id: string) =>
    createIdentityContext({ actor: { type: "staff", id, client: "admin" } });
  const proposal = await api.runtime.tx.run(async (tx) =>
    proposeFinanceConfig(
      tx,
      {
        approval: api.runtime.approval,
        clock: api.clock,
        keyring: security.loadKeyring(api.runtime.env),
      },
      identity(proposer.staff.id),
      { configKey, payload, changeNote: "定向接口测试" },
      await sampleStaffContext(db, proposer.staff.id, { stepUpAt: api.clock.now() }),
    ),
  );
  await api.runtime.tx.run(async (tx) =>
    api.runtime.approval.approve(tx, identity(approver.staff.id), {
      approvalId: proposal.approvalId,
      lockVersion: 0,
      staff: await sampleStaffContext(db, approver.staff.id, { stepUpAt: api.clock.now() }),
    }),
  );
  return proposal.financeConfigRevisionId;
}
beforeAll(async () => {
  api = await h.start();
  db = await h.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(h, api);
  const make = createFactories({ db, clock: api.clock }),
    staff = await make.staff({ staffRoleKey: "super_admin" }),
    doc = await make.fileObject({ bucket: "secure", category: "legal_doc", ext: "pdf" });
  const notices = createNotices({ clock: api.clock, events: api.runtime.events });
  versions = [];
  for (const agreementKey of ["member", "points"]) {
    const id = uuidv7();
    const siteNoticeId = await api.runtime.tx.run(
      async (tx) =>
        (
          await notices.announce(
            tx,
            createIdentityContext({ actor: { type: "staff", id: staff.id, client: "admin" } }),
            {
              kind: "agreement_version",
              refId: id,
              title: "测试协议",
              summary: "测试协议",
              effectiveAt: api.clock.now(),
              shortNoticeReason: "测试占位协议",
              link: { route: "agreement.version", params: { agreementVersionId: id } },
              createdByStaffId: staff.id,
            },
          )
        ).siteNoticeId,
    );
    versions.push(
      (
        await make.agreementVersion({
          id,
          agreementKey,
          createdByStaffId: staff.id,
          pdfFileId: doc.id,
          siteNoticeId,
        })
      ).id,
    );
  }
  finance = await signInAsStaff(db, { roleKey: "finance" });
  const second = await signInAsStaff(db, { roleKey: "finance", isLead: true });
  await seedPlaceholderFinanceConfig(
    {
      tx: api.runtime.tx,
      clock: api.clock,
      assembly: api.runtime.assembly,
      bizNo: api.runtime.bizNo,
      keyring: security.loadKeyring(api.runtime.env),
    },
    { proposerId: finance.staff.id, approverId: second.staff.id },
  );
}, 180_000);
describe("对公付款真实 API 链", { timeout: 90_000 }, () => {
  it("只读报价、创建脱敏重放、原账户版本、到账履约与钱包积分", async () => {
    const b = await buyer(),
      before = await db.ledgerOperation.count(),
      q = await quote(b);
    expect(await db.ledgerOperation.count()).toBe(before);
    expect(
      await data(
        await api.request("/api/v1/m/purchase-policy", { headers: b.owner.withStore(b.storeId) }),
      ),
    ).toMatchObject({ mode: "in_app", channels: [{ isEnabled: false }, { isEnabled: true }] });
    const key = uuidv7(),
      body = orderBody(q),
      first = await post("/m/payment-orders", body, b.owner.withStore(b.storeId), key),
      o = await data<PaymentOrderDetail & { replayed: boolean }>(first);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(o.bankAccount?.accountNo).toBe("0000000000000000");
    const replay = await post("/m/payment-orders", body, b.owner.withStore(b.storeId), key);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await data(replay)).toMatchObject({
      paymentOrderId: o.paymentOrderId,
      bankAccount: { accountNo: null },
      replayed: true,
    });
    expect(await db.agreementConsent.findMany({ where: { bizId: o.paymentOrderId } })).toHaveLength(
      2,
    );
    expect(
      (await db.agreementConsent.findMany({ where: { bizId: o.paymentOrderId } })).every(
        (c) => c.bizNo === o.orderNo,
      ),
    ).toBe(true);
    const uploadKey = uuidv7(),
      upload = { fileId: await file(b) },
      uploaded = await data<PaymentOrderDetail>(
        await post(
          `/m/payment-orders/${o.paymentOrderId}/transfer-proofs`,
          upload,
          b.owner.withStore(b.storeId),
          uploadKey,
        ),
      );
    expect(
      await data(
        await post(
          `/m/payment-orders/${o.paymentOrderId}/transfer-proofs`,
          upload,
          b.owner.withStore(b.storeId),
          uploadKey,
        ),
      ),
    ).toEqual({
      ...uploaded,
      bankAccount: { ...uploaded.bankAccount, accountNo: null },
      replayed: true,
    });
    const snapshots = await db.idempotencyRecord.findMany({
      where: {
        actorKey: `merchant:${b.owner.merchantUserId}`,
        scope: { in: ["m.paymentOrder.create", "m.paymentOrder.transferProof.create"] },
      },
    });
    expect(snapshots).toHaveLength(2);
    for (const saved of snapshots) {
      expect(saved.result).toMatchObject({ bankAccount: { accountNo: null } });
      expect(JSON.stringify(saved.result)).not.toContain("0000000000000000");
    }
    const pid = uploaded.latestTransferProof!.transferProofId;
    expect(await getProof(pid)).toMatchObject({
      reviewStatus: "pending",
      ocr: { status: "unavailable" },
    });
    expect(
      await data(
        await api.request(`/api/v1/admin/transfer-proofs?tab=pending&q=${o.orderNo}`, {
          headers: finance.headers,
        }),
      ),
    ).toMatchObject({ total: 1 });
    expect(
      await data(
        await api.request(`/api/v1/admin/transfer-proofs/summary?q=${o.orderNo}`, {
          headers: finance.headers,
        }),
      ),
    ).toMatchObject({ pending: 1, pendingAmountFen: String(o.amountFen) });
    const cKey = uuidv7(),
      cBody = confirm(o, "  ａｂｃ-１２３  ");
    const accepted = await data(
      await post(`/admin/transfer-proofs/${pid}/confirm`, cBody, finance.headers, cKey),
    );
    expect(accepted).toMatchObject({ outcome: "paid", reviewStatus: "accepted" });
    expect(
      await data(await post(`/admin/transfer-proofs/${pid}/confirm`, cBody, finance.headers, cKey)),
    ).toEqual(accepted);
    const merchant = await data<PaymentOrderDetail>(
      await api.request(`/api/v1/m/payment-orders/${o.paymentOrderId}`, {
        headers: b.owner.withStore(b.storeId),
      }),
    );
    expect(merchant).toMatchObject({
      status: "paid",
      fulfillmentStatus: "done",
      paidAmountFen: o.amountFen,
      transferState: null,
    });
    const admin = await data(
      await api.request(`/api/v1/admin/payment-orders/${o.paymentOrderId}`, {
        headers: finance.headers,
      }),
    );
    expect(JSON.stringify(admin)).not.toContain('"accountNo"');
    expect(
      await data(await api.request("/api/v1/m/wallet", { headers: b.owner.withStore(b.storeId) })),
    ).toMatchObject({
      subscription: { status: "active" },
      points: { spendablePoints: q.benefits.monthlyPoints },
      topUp: { canTopUp: false, blockReason: "not_offered" },
    });
    const txn = await db.paymentTxn.findFirstOrThrow({ where: { transferProofId: pid } });
    expect(txn.channelTxnNo).toBe("ABC123");
    expect(txn.appliedAt).not.toBeNull();
    expect(
      await db.paymentTxn.count({ where: { transferProofId: pid, status: "succeeded" } }),
    ).toBe(1);
    expect(
      await db.outboxEvent.count({
        where: { eventType: "billing.subscription.activated", entityId: b.entityId },
      }),
    ).toBe(1);
    expect(
      await db.timer.count({
        where: { subjectId: o.paymentOrderId, kind: "po.transfer_ttl", status: "scheduled" },
      }),
    ).toBe(0);
    await error(
      await post("/m/plans/quote", { planId: q.planId, months: 1 }, b.owner.withStore(b.storeId)),
      409,
      "STATE_NOT_ALLOWED",
    );
  });
  it("驳回重放、顺延有效期、替换历史与文件引用永久保留", async () => {
    const b = await buyer(),
      o = await order(b),
      p = await proof(b, o),
      id = p.latestTransferProof!.transferProofId;
    const timer = await db.timer.findFirstOrThrow({ where: { subjectId: o.paymentOrderId } });
    expect(timer.status).toBe("scheduled");
    const replaced = await proof(b, o);
    expect(await db.transferProof.findUniqueOrThrow({ where: { id } })).toMatchObject({
      reviewStatus: "superseded",
    });
    expect(
      await db.statusTransition.count({
        where: { machine: "billing_order", subjectId: o.paymentOrderId },
      }),
    ).toBe(2);
    const current = replaced.latestTransferProof!.transferProofId,
      reason = await db.dictItem.findFirstOrThrow({
        where: {
          dictTypeKey: "reject_reason",
          isEnabled: true,
          ext: { path: ["scene"], equals: "transfer" },
        },
      });
    const key = uuidv7(),
      body = { lockVersion: 0, reasonCode: reason.code, note: "回单金额不符" };
    api.clock.advance(1000);
    const result = await data(
      await post(`/admin/transfer-proofs/${current}/reject`, body, finance.headers, key),
    );
    expect(result).toMatchObject({ reviewStatus: "rejected" });
    expect(
      await data(
        await post(`/admin/transfer-proofs/${current}/reject`, body, finance.headers, key),
      ),
    ).toEqual(result);
    const row = await db.billingOrder.findUniqueOrThrow({ where: { id: o.paymentOrderId } });
    expect(row).toMatchObject({ status: "pending_payment", transferState: "proof_rejected" });
    expect(row.expiresAt.getTime()).toBeGreaterThan(new Date(o.expiresAt).getTime());
    expect(
      await db.timer.count({ where: { subjectId: o.paymentOrderId, kind: "po.transfer_ttl" } }),
    ).toBe(2);
    expect(
      await db.fileRef.count({
        where: { refType: "transfer_proof", refId: { in: [id, current] }, releasedAt: null },
      }),
    ).toBe(2);
    expect(await proof(b, o)).toMatchObject({ status: "pending_confirmation" });
  });
  it("金额/回显/缺再验证/二人同时确认以及规范化流水冲突", async () => {
    const b = await buyer(),
      o = await order(b),
      p = await proof(b, o),
      id = p.latestTransferProof!.transferProofId,
      body = confirm(o, "unique-serial");
    await error(
      await post(
        `/admin/transfer-proofs/${id}/confirm`,
        { ...body, confirm: { ...body.confirm, receivedAmountFen: o.amountFen + 1 } },
        finance.headers,
      ),
      409,
      "TRANSFER_AMOUNT_MISMATCH",
    );
    await error(
      await post(
        `/admin/transfer-proofs/${id}/confirm`,
        { ...body, confirm: { ...body.confirm, orderNo: "wrong" } },
        finance.headers,
      ),
      409,
      "CONFIRM_MISMATCH",
    );
    const stale = await signInAsStaff(db, { roleKey: "finance" });
    await db.staffSession.update({
      where: { id: stale.sessionId },
      data: {
        createdAt: new Date(api.clock.now().getTime() - 31 * 60_000),
        stepupAt: new Date(api.clock.now().getTime() - 31 * 60_000),
      },
    });
    await error(
      await post(`/admin/transfer-proofs/${id}/confirm`, body, stale.headers),
      403,
      "STEP_UP_REQUIRED",
    );
    const other = await signInAsStaff(db, { roleKey: "finance" });
    const results = await Promise.all([
      post(`/admin/transfer-proofs/${id}/confirm`, body, finance.headers),
      post(`/admin/transfer-proofs/${id}/confirm`, body, other.headers),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    await error(
      results.find((r) => r.status === 409)!,
      409,
      "VERSION_CONFLICT",
    );
    const b2 = await buyer(),
      o2 = await order(b2),
      p2 = await proof(b2, o2);
    await error(
      await post(
        `/admin/transfer-proofs/${p2.latestTransferProof!.transferProofId}/confirm`,
        confirm(o2, " ＵＮＩＱＵＥ-ＳＥＲＩＡＬ "),
        finance.headers,
      ),
      409,
      "BANK_SERIAL_DUPLICATE",
    );
    expect(await db.paymentTxn.count({ where: { billingOrderId: o2.paymentOrderId } })).toBe(0);
  });
  it("资质/报价/渠道/同内容/同意版本/周期守卫与七条老板能力拒绝店员", async () => {
    const b = await buyer(false),
      q = await quote(b),
      body = orderBody(q);
    await error(
      await post("/m/payment-orders", body, b.owner.withStore(b.storeId)),
      409,
      "PURCHASE_QUALIFICATION_REQUIRED",
    );
    await db.entity.update({
      where: { id: b.entityId },
      data: { verificationStatus: "pending" },
    });
    await error(
      await post(
        "/m/payment-orders",
        { ...body, expectAmountFen: q.payFen + 1 },
        b.owner.withStore(b.storeId),
      ),
      409,
      "QUOTE_CHANGED",
    );
    await error(
      await post(
        "/m/payment-orders",
        { ...body, channel: "wechat_jsapi" },
        b.owner.withStore(b.storeId),
      ),
      403,
      "CHANNEL_NOT_ALLOWED",
    );
    await error(
      await post(
        "/m/payment-orders",
        { ...body, agreementVersionIds: [versions[0]] },
        b.owner.withStore(b.storeId),
      ),
      409,
      "AGREEMENT_VERSION_STALE",
    );
    await error(
      await post("/m/plans/quote", { planId: q.planId, months: 2 }, b.owner.withStore(b.storeId)),
      400,
      "CYCLE_NOT_AVAILABLE",
    );
    const o = await order(b, q);
    expect((await order(b, q)).paymentOrderId).toBe(o.paymentOrderId);
    const q3 = await quote(b, 3);
    await error(
      await post("/m/payment-orders", orderBody(q3), b.owner.withStore(b.storeId)),
      409,
      "OPEN_ORDER_EXISTS",
    );
    await db.billingOrder.update({
      where: { id: o.paymentOrderId },
      data: { expiresAt: new Date(api.clock.now().getTime() + 300_000) },
    });
    await error(
      await post("/m/payment-orders", body, b.owner.withStore(b.storeId)),
      409,
      "OPEN_ORDER_EXPIRING",
    );
    const clerk = await signInAsMerchant(api),
      make = createFactories({ db, clock: api.clock }),
      member = await make.entityMember({
        entityId: b.entityId,
        merchantUserId: clerk.merchantUserId,
      });
    await make.storeMember({
      entityMemberId: member.id,
      storeId: b.storeId,
      addedByMemberId: (
        await db.entityMember.findFirstOrThrow({ where: { entityId: b.entityId, role: "owner" } })
      ).id,
    });
    for (const path of [
      "/m/wallet",
      "/m/purchase-policy",
      "/m/plans",
      `/m/payment-orders/${o.paymentOrderId}`,
    ])
      await error(
        await api.request(`/api/v1${path}`, { headers: clerk.withStore(b.storeId) }),
        403,
        "ROLE_FORBIDDEN",
      );
    for (const [path, json] of [
      ["/m/plans/quote", { planId: q.planId, months: 1 }],
      ["/m/payment-orders", body],
      [`/m/payment-orders/${o.paymentOrderId}/transfer-proofs`, { fileId: uuidv7() }],
    ] as const)
      await error(await post(path, json, clerk.withStore(b.storeId)), 403, "ROLE_FORBIDDEN");
  });
  it("策略首匹配控制列表/报价/建单，未生效收款账户不可选", async () => {
    const b = await buyer(),
      q = await quote(b);
    await approveConfig("purchase_policy", {
      rules: [{ when: { entityIds: [b.entityId] }, then: { mode: "offline_contract" } }],
    });
    expect(
      await data(await api.request("/api/v1/m/plans", { headers: b.owner.withStore(b.storeId) })),
    ).toEqual({ items: [] });
    expect(
      await data(
        await api.request("/api/v1/m/purchase-policy", { headers: b.owner.withStore(b.storeId) }),
      ),
    ).toMatchObject({ mode: "offline_contract", channels: [], isPriceShown: false });
    await error(
      await post("/m/plans/quote", { planId: q.planId, months: 1 }, b.owner.withStore(b.storeId)),
      403,
      "PURCHASE_NOT_OFFERED",
    );
    await error(
      await post("/m/payment-orders", orderBody(q), b.owner.withStore(b.storeId)),
      403,
      "PURCHASE_NOT_OFFERED",
    );
    const now = api.clock.now();
    try {
      api.clock.set(new Date(now.getTime() - 26 * 3_600_000));
      expect(
        await data(
          await api.request("/api/v1/m/purchase-policy", {
            headers: b.owner.withStore(b.storeId),
          }),
        ),
      ).toMatchObject({ channels: [{ isEnabled: false }, { isEnabled: false }] });
    } finally {
      api.clock.set(now);
    }
  });
  it("真实新账户批准24小时后仅新单采用，已建单仍取原版本；后台资源按本人范围", async () => {
    const b = await buyer(),
      o = await order(b),
      p = await proof(b, o);
    const manager = await signInAsStaff(db, { roleKey: "delivery_manager" });
    const other = await signInAsStaff(db, { roleKey: "delivery_manager" });
    await db.store.update({
      where: { id: b.storeId },
      data: { deliveryManagerId: manager.staff.id },
    });
    await data(
      await api.request(`/api/v1/admin/payment-orders/${o.paymentOrderId}`, {
        headers: manager.headers,
      }),
    );
    await data(await awaitableRequest(p.latestTransferProof!.transferProofId, manager));
    await error(
      await api.request(`/api/v1/admin/payment-orders/${o.paymentOrderId}`, {
        headers: other.headers,
      }),
      404,
      "NOT_FOUND",
    );
    await error(
      await awaitableRequest(p.latestTransferProof!.transferProofId, other),
      404,
      "NOT_FOUND",
    );
    const original = await db.billingOrder.findUniqueOrThrow({ where: { id: o.paymentOrderId } });
    const changed = await approveConfig("bank_account", {
      accountName: "新演示收款户",
      bankName: "新演示银行",
      accountNo: "1111111111111111",
    });
    expect(
      (await db.financeConfigRevision.findUniqueOrThrow({ where: { id: changed } })).effectiveAt,
    ).toEqual(new Date(api.clock.now().getTime() + 86_400_000));
    const now = api.clock.now();
    try {
      api.clock.set(new Date(now.getTime() + 86_400_000));
      b.owner = await signInAsMerchant(api, { phone: b.owner.phone, openid: b.owner.openid });
      const old = await data<PaymentOrderDetail>(
        await api.request(`/api/v1/m/payment-orders/${o.paymentOrderId}`, {
          headers: b.owner.withStore(b.storeId),
        }),
      );
      expect(old.bankAccount).toMatchObject({
        accountName: "狸有戏（演示收款户，勿转账）",
        accountNo: "0000000000000000",
      });
      expect(
        (await db.billingOrder.findUniqueOrThrow({ where: { id: o.paymentOrderId } }))
          .bankAccountFinanceConfigRevisionId,
      ).toBe(original.bankAccountFinanceConfigRevisionId);
      const fresh = await order(await buyer());
      expect(fresh.bankAccount).toMatchObject({
        accountName: "新演示收款户",
        accountNo: "1111111111111111",
      });
      expect(
        (await db.billingOrder.findUniqueOrThrow({ where: { id: fresh.paymentOrderId } }))
          .bankAccountFinanceConfigRevisionId,
      ).toBe(changed);
    } finally {
      api.clock.set(now);
    }
  });
  it("新快照保持创建时名称，老快照无名称仍兼容读侧", async () => {
    const b = await buyer(),
      q = await quote(b),
      o = await order(b, q);
    const original = await db.billingOrder.findUniqueOrThrow({ where: { id: o.paymentOrderId } });
    expect(original.contentSnapshot).toMatchObject({ planName: q.planName });
    try {
      await db.plan.update({ where: { id: q.planId }, data: { name: "改名后的套餐" } });
      const read = () =>
        api.request(`/api/v1/m/payment-orders/${o.paymentOrderId}`, {
          headers: b.owner.withStore(b.storeId),
        });
      expect(await data(await read())).toMatchObject({ content: { planName: q.planName } });
      const admin = await data<{ content: { planName: string } }>(
        await api.request(`/api/v1/admin/payment-orders/${o.paymentOrderId}`, {
          headers: finance.headers,
        }),
      );
      expect(admin.content.planName).toBe(q.planName);
      const legacy = planOrderContentSchema.parse(original.contentSnapshot);
      delete legacy.planName;
      await db.billingOrder.update({
        where: { id: original.id },
        data: { contentSnapshot: legacy },
      });
      expect(await data(await read())).toMatchObject({ content: { planName: "改名后的套餐" } });
    } finally {
      await db.plan.update({ where: { id: q.planId }, data: { name: q.planName } });
    }
  });
  it("大额复核桩拒绝不留交易；不同银行同流水须精确回显，同银行仍拒绝", async () => {
    const b = await buyer(),
      o = await order(b),
      p = await proof(b, o),
      id = p.latestTransferProof!.transferProofId;
    await approveConfig("controls", {
      adminCreateOrder: false,
      wechatSingleLimitFen: 0,
      wechatDailyLimitFen: 0,
      receiptSecondReviewFen: 1,
      shippingReport: false,
    });
    await error(
      await post(`/admin/transfer-proofs/${id}/confirm`, confirm(o), finance.headers),
      409,
      "STATE_NOT_ALLOWED",
    );
    expect(await db.paymentTxn.count({ where: { billingOrderId: o.paymentOrderId } })).toBe(0);
    expect(await getProof(id)).toMatchObject({ reviewStatus: "pending", lockVersion: 0 });
    await approveConfig("controls", {
      adminCreateOrder: false,
      wechatSingleLimitFen: 0,
      wechatDailyLimitFen: 0,
      receiptSecondReviewFen: null,
      shippingReport: false,
    });
    const now = api.clock.now();
    for (const [code, name] of [
      ["W111B_A", "测试甲银行"],
      ["W111B_B", "测试乙银行"],
    ])
      await db.dictItem.create({
        data: {
          id: uuidv7(),
          dictTypeKey: "bank",
          code: code!,
          name: name!,
          createdAt: now,
          updatedAt: now,
        },
      });
    const serial = `BANK-${uuidv7()}`;
    await data(
      await post(
        `/admin/transfer-proofs/${id}/confirm`,
        { ...confirm(o, serial), payerBankCode: "W111B_A" },
        finance.headers,
      ),
    );
    const b2 = await buyer(),
      o2 = await order(b2),
      p2 = await proof(b2, o2),
      id2 = p2.latestTransferProof!.transferProofId;
    await error(
      await post(
        `/admin/transfer-proofs/${id2}/confirm`,
        { ...confirm(o2, serial), payerBankCode: "W111B_B" },
        finance.headers,
      ),
      409,
      "CONFIRM_MISMATCH",
    );
    expect(await db.paymentTxn.count({ where: { billingOrderId: o2.paymentOrderId } })).toBe(0);
    const accepted = await data(
      await post(
        `/admin/transfer-proofs/${id2}/confirm`,
        {
          ...confirm(o2, serial),
          payerBankCode: "W111B_B",
          confirm: { ...confirm(o2).confirm, conflictOrderNos: [o.orderNo] },
        },
        finance.headers,
      ),
    );
    expect(accepted).toMatchObject({ outcome: "paid" });
    const b3 = await buyer(),
      o3 = await order(b3),
      p3 = await proof(b3, o3);
    await error(
      await post(
        `/admin/transfer-proofs/${p3.latestTransferProof!.transferProofId}/confirm`,
        {
          ...confirm(o3, serial),
          payerBankCode: "W111B_B",
          confirm: { ...confirm(o3).confirm, conflictOrderNos: [o.orderNo, o2.orderNo] },
        },
        finance.headers,
      ),
      409,
      "BANK_SERIAL_DUPLICATE",
    );
    expect(await db.paymentTxn.count({ where: { billingOrderId: o3.paymentOrderId } })).toBe(0);
  });
});
