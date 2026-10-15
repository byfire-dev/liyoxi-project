// W4-02：真实签名原文→Hono鉴权/接收管线→service→DB；仅渠道使用公开假材料。
import { generateKeyPairSync } from "node:crypto";
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
import {
  createFactories,
  createFakeWechatPay,
  sampleStaffContext,
  signInAsStaff,
} from "@liyoxi/services/testing";
import type { FakeWechatPay } from "@liyoxi/services/testing";
import {
  PaymentOrderDetailSchema,
  PaymentOrderWechatPrepayResultSchema,
  PaymentOrderCancelResultSchema,
  PaymentOrderListSchema,
} from "@liyoxi/contract";
import type { PaymentOrderDetail, PlanQuote } from "@liyoxi/contract";
import { TEST_WEAPP_APPID, useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
import { merchantServicesOf } from "../src/merchant/services.js";

const h = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof h.db.prisma>>,
  pay: FakeWechatPay,
  foreignPay: FakeWechatPay;
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
  const generated = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPair = {
    privateKey: generated.privateKey,
    publicKeyPem: generated.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  pay.useWireFormat({ appid: TEST_WEAPP_APPID, mchid: "1900000109", keyPair });
  foreignPay = createFakeWechatPay({ clock: api.clock });
  foreignPay.useWireFormat({ appid: "wx1111111111111111", mchid: "1900000109", keyPair });
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
        title: "渠道测试协议",
        summary: "渠道测试协议",
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
        changeNote: "本轮微信渠道限额",
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

type ChannelOperation =
  "m.paymentOrder.sync" | "m.paymentOrder.cancel" | "hooks.wechatpay.transaction.notify";
function actualPath(operationId: ChannelOperation, path: string) {
  const route = api.api.mounted.find((entry) => entry.operationId === operationId);
  expect(route).toBeDefined();
  expect(route!.method).toBe("POST");
  expect(`/api/v1${path}`.split("/")).toEqual(
    route!.path
      .split("/")
      .map((part) => (/^\{[^}]+\}$/.test(part) ? expect.stringMatching(/^[^/]+$/) : part)),
  );
  return `/api/v1${path}`;
}
async function channel(
  operationId: Exclude<ChannelOperation, "hooks.wechatpay.transaction.notify">,
  b: Buyer,
  id: string,
  key?: string,
) {
  const path = `/m/payment-orders/${id}/${operationId === "m.paymentOrder.sync" ? "sync" : "cancel"}`;
  return api.request(actualPath(operationId, path), {
    method: "POST",
    headers: { ...b.owner.withStore(b.storeId), ...(key ? { "Idempotency-Key": key } : {}) },
  });
}
async function notify(wire: { headers: Record<string, string>; rawBody: string }) {
  return api.request(
    actualPath("hooks.wechatpay.transaction.notify", "/hooks/wechatpay/transactions"),
    {
      method: "POST",
      body: wire.rawBody,
      headers: { "Content-Type": "application/json", ...wire.headers },
    },
  );
}
async function prepared() {
  const b = await buyer(),
    o = await order(b);
  PaymentOrderWechatPrepayResultSchema.parse(
    await data(
      await post(
        `/m/payment-orders/${o.paymentOrderId}/wechat-prepay`,
        undefined,
        b.owner.withStore(b.storeId),
      ),
    ),
  );
  const receipt = await db.paymentTxn.findFirstOrThrow({
    where: { billingOrderId: o.paymentOrderId },
  });
  return { b, o, receipt };
}
async function saved(b: Buyer, id: string) {
  return PaymentOrderDetailSchema.parse(
    await data(
      await api.request(`/api/v1/m/payment-orders/${id}`, {
        headers: b.owner.withStore(b.storeId),
      }),
    ),
  );
}
async function financial(id: string) {
  const order = await db.billingOrder.findUniqueOrThrow({ where: { id } });
  const transactions = await db.paymentTxn.findMany({
    where: { billingOrderId: id },
    orderBy: { id: "asc" },
  });
  return {
    order,
    transactions,
    ledger: await db.ledgerOperation.count(),
    exceptions: await db.paymentException.count(),
    transitions: await db.statusTransition.count({
      where: { machine: "billing_order", subjectId: id },
    }),
    events: await db.outboxEvent.count({
      where: { aggregateId: { in: [id, ...transactions.map((row) => row.id)] } },
    }),
    idem: await db.idempotencyRecord.count(),
  };
}

describe("微信支付渠道真实HTTP", { timeout: 30_000 }, () => {
  it("hooks.wechatpay.transaction.notify：真实签名/错来源/篡改原文、GET paid与同通知重放唯一", async () => {
    const { b, o, receipt } = await prepared();
    const cards = PaymentOrderListSchema.parse(
      await data(
        await api.request("/api/v1/m/payment-orders", { headers: b.owner.withStore(b.storeId) }),
      ),
    );
    expect(cards.items.find((row) => row.paymentOrderId === o.paymentOrderId)?.actions).toEqual(
      expect.arrayContaining(["wechat-prepay", "sync", "cancel"]),
    );
    const event = pay.pay(receipt.outTradeNo);
    if (event.kind !== "transaction") throw new Error("缺本轮交易通知");
    const wire = pay.encode(event),
      before = await financial(o.paymentOrderId);
    expect((await notify({ ...wire, rawBody: `${wire.rawBody} ` })).status).toBe(401);
    expect(
      await db.webhookEvent.count({ where: { provider: "wechatpay", eventId: event.id } }),
    ).toBe(0);
    expect(await financial(o.paymentOrderId)).toEqual(before);
    // 同一假公钥与APIv3 key真实加密/签名，但解出的appid不属于本来源，保存ignored，不记收款。
    const wrong = { ...event, id: `${event.id}-wrong-source` };
    expect((await notify(foreignPay.encode(wrong))).status).toBe(200);
    expect(
      await db.webhookEvent.findUniqueOrThrow({
        where: { provider_eventId: { provider: "wechatpay", eventId: wrong.id } },
      }),
    ).toMatchObject({ processState: "ignored" });
    expect(await financial(o.paymentOrderId)).toEqual(before);
    const accepted = await notify(wire);
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe("");
    expect(await saved(b, o.paymentOrderId)).toMatchObject({
      status: "paid",
      paidAmountFen: o.amountFen,
      fulfillmentStatus: "done",
    });
    expect(await db.paymentTxn.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({
      status: "succeeded",
      channelAmountFen: o.amountFen,
      appliedAt: expect.any(Date),
    });
    const inbox = await db.webhookEvent.findUniqueOrThrow({
      where: { provider_eventId: { provider: "wechatpay", eventId: event.id } },
    });
    expect(inbox).toMatchObject({
      mode: "inline",
      processState: "processed",
      keyVersion: "fake-v1",
    });
    expect(JSON.stringify(inbox.payload)).not.toContain(b.owner.openid);
    const settled = await financial(o.paymentOrderId),
      inboxCount = await db.webhookEvent.count();
    const replay = await notify(wire);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe("");
    expect(await financial(o.paymentOrderId)).toEqual(settled);
    expect(await db.webhookEvent.count()).toBe(inboxCount);
    expect(
      await db.ledgerOperation.count({
        where: { opKey: `fulfill:billing_order:${o.paymentOrderId}` },
      }),
    ).toBe(1);
  });

  it("m.paymentOrder.sync / m.paymentOrder.cancel：查单入账、未知关单保持pending、真实close与C50重放、权限零变化", async () => {
    const successful = await prepared();
    pay.pay(successful.receipt.outTradeNo);
    const idemBefore = await db.idempotencyRecord.count();
    const synced = PaymentOrderDetailSchema.parse(
      await data(await channel("m.paymentOrder.sync", successful.b, successful.o.paymentOrderId)),
    );
    expect(synced).toMatchObject({ status: "paid", fulfillmentStatus: "done", bankAccount: null });
    expect(await saved(successful.b, successful.o.paymentOrderId)).toMatchObject({
      status: "paid",
      fulfillmentStatus: "done",
    });
    expect(await db.idempotencyRecord.count()).toBe(idemBefore);
    const target = await prepared(),
      id = target.o.paymentOrderId;
    pay.failNext("closeOrder");
    const unknown = PaymentOrderCancelResultSchema.parse(
      await data(await channel("m.paymentOrder.cancel", target.b, id, uuidv7())),
    );
    expect(unknown).toMatchObject({
      outcome: "cancelling",
      paymentOrder: { status: "pending_payment" },
    });
    expect(
      (await db.paymentTxn.findUniqueOrThrow({ where: { id: target.receipt.id } })).status,
    ).toBe("prepaid");
    const key = uuidv7();
    const closed = PaymentOrderCancelResultSchema.parse(
      await data(await channel("m.paymentOrder.cancel", target.b, id, key)),
    );
    expect(closed).toMatchObject({
      outcome: "cancelled",
      paymentOrder: { status: "cancelled", bankAccount: null },
    });
    expect(pay.orders.get(target.receipt.outTradeNo)?.tradeState).toBe("CLOSED");
    expect(
      (await db.paymentTxn.findUniqueOrThrow({ where: { id: target.receipt.id } })).status,
    ).toBe("closed");
    expect(await saved(target.b, id)).toMatchObject({ status: "cancelled" });
    const calls = pay.calls.length,
      beforeReplay = await financial(id);
    const replayResponse = await channel("m.paymentOrder.cancel", target.b, id, key);
    expect(replayResponse.headers.get("Idempotent-Replayed")).toBe("true");
    expect(PaymentOrderCancelResultSchema.parse(await data(replayResponse))).toEqual(closed);
    expect(await financial(id)).toEqual(beforeReplay);
    expect(pay.calls).toHaveLength(calls);
    expect(JSON.stringify(await db.idempotencyRecord.findMany())).not.toContain(
      "explicit-fake-signature",
    );
    const outsider = await buyer(),
      clerk = await signInAsMerchant(api);
    const make = createFactories({ db, clock: api.clock });
    const member = await make.entityMember({
      entityId: target.b.entityId,
      merchantUserId: clerk.merchantUserId,
    });
    await make.storeMember({
      entityId: target.b.entityId,
      entityMemberId: member.id,
      storeId: target.b.storeId,
    });
    const forbidden: Buyer = { ...target.b, owner: clerk };
    const beforeDenied = await financial(id),
      deniedCalls = pay.calls.length;
    for (const operation of ["m.paymentOrder.sync", "m.paymentOrder.cancel"] as const) {
      await denied(
        await channel(
          operation,
          forbidden,
          id,
          operation.endsWith("cancel") ? uuidv7() : undefined,
        ),
        403,
        "ROLE_FORBIDDEN",
      );
      await denied(
        await channel(operation, outsider, id, operation.endsWith("cancel") ? uuidv7() : undefined),
        404,
        "NOT_FOUND",
      );
    }
    await denied(
      await channel("m.paymentOrder.cancel", target.b, id),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    expect(await financial(id)).toEqual(beforeDenied);
    expect(pay.calls).toHaveLength(deniedCalls);
  });
});
