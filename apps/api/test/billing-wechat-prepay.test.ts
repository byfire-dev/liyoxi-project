// W4-01: "m.paymentOrder.wechatPrepay"；真实鉴权/三段式/DB，只有渠道IO使用既有替身。
import { beforeAll, describe, expect, it } from "vitest";
import {
  createIdentityContext,
  createNotices,
  proposeFinanceConfig,
  runSeed,
  security,
  seedPlaceholderFinanceConfig,
  uuidv7,
} from "@liyoxi/services";
import { createFactories, sampleStaffContext, signInAsStaff } from "@liyoxi/services/testing";
import type { FakeWechatPay } from "@liyoxi/services/testing";
import { PaymentOrderDetailSchema, PaymentOrderWechatPrepayResultSchema } from "@liyoxi/contract";
import type { PaymentOrderDetail, PlanQuote } from "@liyoxi/contract";
import { TEST_WEAPP_APPID, useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
import { merchantServicesOf } from "../src/merchant/services.js";

const h = useTestApi();
let api: TestApi, db: Awaited<ReturnType<typeof h.db.prisma>>, pay: FakeWechatPay;
let versions: string[],
  peer = 0;
type Buyer = { owner: SignedInMerchant; entityId: string; storeId: string };
async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
async function denied(response: Response, status: number, error: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error });
}
const post = (path: string, json: unknown, headers: Record<string, string>, key = uuidv7()) =>
  api.request(`/api/v1${path}`, {
    method: "POST",
    ...(json === undefined ? {} : { json }),
    headers: { ...headers, "Idempotency-Key": key },
    peer: `198.19.88.${++peer % 250}`,
  });
async function buyer(): Promise<Buyer> {
  const owner = await signInAsMerchant(api, { headers: { "X-Client-Platform": "android" } });
  const scope = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  // 与原billing HTTP夹具相同的资质前置；付款单/交易/paid事实始终由正式服务创建。
  await db.entity.update({
    where: { id: scope.entityId },
    data: { verificationStatus: "pending" },
  });
  return { owner, ...scope };
}
async function order(b: Buyer): Promise<PaymentOrderDetail> {
  const plans = await data<{ items: { planId: string }[] }>(
    await api.request("/api/v1/m/plans", { headers: b.owner.withStore(b.storeId) }),
  );
  const q = await data<PlanQuote>(
    await post(
      "/m/plans/quote",
      { planId: plans.items[0]!.planId, months: 1 },
      b.owner.withStore(b.storeId),
    ),
  );
  return PaymentOrderDetailSchema.parse(
    await data<unknown>(
      await post(
        "/m/payment-orders",
        {
          planId: q.planId,
          months: q.months,
          channel: "wechat_jsapi",
          expectAmountFen: q.payFen,
          agreementVersionIds: versions,
        },
        b.owner.withStore(b.storeId),
      ),
    ),
  );
}

beforeAll(async () => {
  api = await h.start({ wechatPay: { appid: TEST_WEAPP_APPID, mchid: "1900000109" } });
  db = await h.db.prisma();
  pay = api.runtime.providers.wechatPay as FakeWechatPay;
  pay.useWireFormat({ appid: TEST_WEAPP_APPID, mchid: "1900000109" });
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(h, api);
  const make = createFactories({ db, clock: api.clock });
  const staff = await make.staff({ staffRoleKey: "super_admin" });
  const doc = await make.fileObject({ bucket: "secure", category: "legal_doc", ext: "pdf" });
  const notices = createNotices({ clock: api.clock, events: api.runtime.events });
  const identity = (id: string) =>
    createIdentityContext({ actor: { type: "staff", id, client: "admin" } });
  versions = [];
  for (const agreementKey of ["member", "points"]) {
    const id = uuidv7();
    const notice = await api.runtime.tx.run((tx) =>
      notices.announce(tx, identity(staff.id), {
        kind: "agreement_version",
        refId: id,
        title: "预下单测试协议",
        summary: "预下单测试协议",
        effectiveAt: api.clock.now(),
        shortNoticeReason: "定向测试占位",
        link: { route: "agreement.version", params: { agreementVersionId: id } },
        createdByStaffId: staff.id,
      }),
    );
    versions.push(
      (
        await make.agreementVersion({
          id,
          agreementKey,
          createdByStaffId: staff.id,
          pdfFileId: doc.id,
          siteNoticeId: notice.siteNoticeId,
        })
      ).id,
    );
  }
  const proposer = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() });
  const approver = await signInAsStaff(db, {
    roleKey: "finance",
    isLead: true,
    now: api.clock.now(),
  });
  const keyring = security.loadKeyring(api.runtime.env);
  await seedPlaceholderFinanceConfig(
    {
      tx: api.runtime.tx,
      clock: api.clock,
      assembly: api.runtime.assembly,
      bizNo: api.runtime.bizNo,
      keyring,
    },
    { proposerId: proposer.staff.id, approverId: approver.staff.id },
  );
  const proposal = await api.runtime.tx.run(async (tx) =>
    proposeFinanceConfig(
      tx,
      { approval: api.runtime.approval, clock: api.clock, keyring },
      identity(proposer.staff.id),
      {
        configKey: "controls",
        payload: {
          adminCreateOrder: false,
          wechatSingleLimitFen: 1_000_000,
          wechatDailyLimitFen: 5_000_000,
          receiptSecondReviewFen: null,
          shippingReport: false,
        },
        changeNote: "本轮微信预下单限额",
      },
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
}, 90_000);

describe("微信预下单真实HTTP薄壳", { timeout: 30_000 }, () => {
  it("m.paymentOrder.wechatPrepay：老板typed首响应、GET持久事实、同键脱敏与新键复用", async () => {
    const b = await buyer(),
      o = await order(b);
    const path = `/m/payment-orders/${o.paymentOrderId}/wechat-prepay`;
    const key = uuidv7(),
      calls = pay.callsOf("createJsapiOrder").length,
      signs = pay.callsOf("signMiniProgramPay").length;
    const firstResponse = await post(path, undefined, b.owner.withStore(b.storeId), key);
    const first = PaymentOrderWechatPrepayResultSchema.parse(await data<unknown>(firstResponse));
    expect(firstResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(first.replayed).toBe(false);
    const txn = await db.paymentTxn.findFirstOrThrow({
      where: { billingOrderId: o.paymentOrderId },
    });
    expect(txn).toMatchObject({
      status: "prepaid",
      amountFen: o.amountFen,
      payerOpenid: b.owner.openid,
    });
    expect(txn.prepayId).toBeTruthy();
    expect(first.payParams).toMatchObject({
      timeStamp: expect.stringMatching(/^\d+$/),
      nonceStr: expect.any(String),
      package: `prepay_id=${txn.prepayId}`,
      signType: "RSA",
      paySign: expect.any(String),
    });
    const saved = PaymentOrderDetailSchema.parse(
      await data<unknown>(
        await api.request(`/api/v1/m/payment-orders/${o.paymentOrderId}`, {
          headers: b.owner.withStore(b.storeId),
        }),
      ),
    );
    expect(saved).toMatchObject({
      paymentOrderId: o.paymentOrderId,
      channel: "wechat_jsapi",
      status: "pending_payment",
      paidAmountFen: 0,
      fulfillmentStatus: "none",
    });
    const replayResponse = await post(path, undefined, b.owner.withStore(b.storeId), key);
    const replay = PaymentOrderWechatPrepayResultSchema.parse(await data<unknown>(replayResponse));
    expect(replayResponse.headers.get("Idempotent-Replayed")).toBe("true");
    expect(replay).toMatchObject({
      payParams: null,
      replayed: true,
      paymentOrder: { paymentOrderId: o.paymentOrderId },
    });
    const fresh = PaymentOrderWechatPrepayResultSchema.parse(
      await data<unknown>(await post(path, undefined, b.owner.withStore(b.storeId))),
    );
    expect(fresh.replayed).toBe(false);
    expect(fresh.payParams).toMatchObject({ package: first.payParams?.package, signType: "RSA" });
    expect(pay.callsOf("createJsapiOrder")).toHaveLength(calls + 1);
    expect(pay.callsOf("signMiniProgramPay")).toHaveLength(signs + 2);
    expect(await db.paymentTxn.count({ where: { billingOrderId: o.paymentOrderId } })).toBe(1);
    const evidence = JSON.stringify(await db.idempotencyRecord.findMany());
    expect(evidence).not.toContain("explicit-fake-signature");
    expect(JSON.stringify(api.logs)).not.toContain("explicit-fake-signature");
  });

  it("m.paymentOrder.wechatPrepay：店员、跨主体、缺幂等键与失资格均拒绝且零业务写", async () => {
    const b = await buyer(),
      o = await order(b),
      other = await buyer();
    const clerk = await signInAsMerchant(api);
    const make = createFactories({ db, clock: api.clock });
    const member = await make.entityMember({
      entityId: b.entityId,
      merchantUserId: clerk.merchantUserId,
    });
    await make.storeMember({ entityId: b.entityId, entityMemberId: member.id, storeId: b.storeId });
    const path = `/m/payment-orders/${o.paymentOrderId}/wechat-prepay`;
    const snapshot = async () => ({
      order: await db.billingOrder.findUniqueOrThrow({ where: { id: o.paymentOrderId } }),
      txns: await db.paymentTxn.findMany({ where: { billingOrderId: o.paymentOrderId } }),
      ledger: await db.ledgerOperation.count(),
      consents: await db.agreementConsent.count({ where: { bizId: o.paymentOrderId } }),
      idem: await db.idempotencyRecord.count(),
      providerCalls: pay.calls.length,
    });
    const before = await snapshot();
    await denied(await post(path, undefined, clerk.withStore(b.storeId)), 403, "ROLE_FORBIDDEN");
    await denied(
      await post(path, undefined, other.owner.withStore(other.storeId)),
      404,
      "NOT_FOUND",
    );
    await denied(
      await api.request(`/api/v1${path}`, {
        method: "POST",
        headers: b.owner.withStore(b.storeId),
      }),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    expect(await snapshot()).toEqual(before);
    // 仅设置本轮资质夹具变体；被测预下单不得修改订单/交易或绕过失资格守卫。
    await db.entity.update({
      where: { id: b.entityId },
      data: { verificationStatus: "unsubmitted" },
    });
    const unqualified = await snapshot();
    await denied(
      await post(path, undefined, b.owner.withStore(b.storeId)),
      409,
      "PURCHASE_QUALIFICATION_REQUIRED",
    );
    expect(await snapshot()).toEqual(unqualified);
  });
});
