import { beforeAll, expect, it } from "vitest";
import {
  createIdentityContext,
  createLedger,
  createNotices,
  runSeed,
  security,
  seedPlaceholderFinanceConfig,
  uuidv7,
} from "@liyoxi/services";
import { createFactories, signInAsStaff, snapshotTables } from "@liyoxi/services/testing";
import type { FakeStorage } from "@liyoxi/services/testing";
import {
  PaymentOrderDetailSchema,
  PlanQuoteSchema,
  SubscriptionTermDetailSchema,
  SubscriptionTermPageSchema,
  SubscriptionTermReminderSchema,
  SubscriptionTermSummarySchema,
} from "@liyoxi/contract";
import type { PaymentOrderDetail } from "@liyoxi/contract";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
import { merchantServicesOf } from "../src/merchant/services.js";

const h = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof h.db.prisma>>,
  versions: string[],
  finance: Awaited<ReturnType<typeof signInAsStaff>>,
  peer = 0;
type Buyer = { owner: SignedInMerchant; entityId: string; storeId: string };
const identity = (id: string) =>
  createIdentityContext({ actor: { type: "staff", id, client: "admin" } });
const tables = [
  "subscription_term",
  "subscription_event",
  "grant_schedule",
  "point_lot",
  "point_ledger_entry",
  "ledger_operation",
  "billing_account",
  "manual_reminder_log",
  "outbox_event",
];
async function data(r: Response): Promise<unknown> {
  expect(r.status, await r.clone().text()).toBe(200);
  return ((await r.json()) as { data: unknown }).data;
}
async function denied(r: Response, status: number, error: string) {
  expect(r.status, await r.clone().text()).toBe(status);
  expect(await r.json()).toMatchObject({ error });
}
const post = (path: string, json: unknown, headers: Record<string, string>, key = uuidv7()) =>
  api.request(`/api/v1${path}`, {
    method: "POST",
    json,
    headers: { ...headers, "Idempotency-Key": key },
    peer: `198.19.85.${++peer % 250}`,
  });
type Operation =
  | "admin.subscriptionTerm.list"
  | "admin.subscriptionTerm.summary"
  | "admin.subscriptionTerm.get"
  | "admin.subscriptionTerm.remind";
function request(
  operationId: Operation,
  headers: Record<string, string>,
  id = "",
  query = "",
  key = uuidv7(),
) {
  const mounted = api.api.mounted.find((row) => row.operationId === operationId);
  expect(mounted).toBeDefined();
  expect(mounted!.method).toBe(operationId.endsWith(".remind") ? "POST" : "GET");
  return api.request(mounted!.path.replace("{subscriptionTermId}", id) + query, {
    method: mounted!.method,
    headers: { ...headers, ...(mounted!.method === "POST" ? { "Idempotency-Key": key } : {}) },
    peer: `198.19.85.${++peer % 250}`,
  });
}
async function buyer(): Promise<Buyer> {
  const owner = await signInAsMerchant(api, { headers: { "X-Client-Platform": "android" } });
  const scope = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  // 仅本轮购买前资格；付款、周期与积分仍经真实HTTP和原入账服务。
  await db.entity.update({
    where: { id: scope.entityId },
    data: { verificationStatus: "pending" },
  });
  return { owner, ...scope };
}
async function order(b: Buyer, months: number) {
  const plan = await db.plan.findUniqueOrThrow({ where: { code: "pro" } });
  const quote = PlanQuoteSchema.parse(
    await data(
      await post(
        "/m/plans/quote",
        {
          planId: plan.id,
          months,
        },
        b.owner.withStore(b.storeId),
      ),
    ),
  );
  return PaymentOrderDetailSchema.parse(
    await data(
      await post(
        "/m/payment-orders",
        {
          planId: plan.id,
          months,
          channel: "bank_transfer",
          expectAmountFen: quote.payFen,
          agreementVersionIds: versions,
        },
        b.owner.withStore(b.storeId),
      ),
    ),
  );
}
async function pay(b: Buyer, payment: PaymentOrderDetail) {
  const created = (await data(
    await post(
      "/m/files",
      {
        category: "pay_receipt",
        files: [{ fileName: "receipt.png", sizeBytes: "8", clientToken: uuidv7() }],
      },
      b.owner.withStore(b.storeId),
    ),
  )) as { items: { fileId: string; key: string }[] };
  const file = created.items[0]!;
  (api.runtime.providers.storage as FakeStorage).put(
    { bucket: "secure", key: file.key },
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    "image/png",
  );
  await data(await post(`/m/files/${file.fileId}/complete`, {}, b.owner.withStore(b.storeId)));
  const job = await db.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.fileId}` },
  });
  await api.runtime.media.promote({ jobId: job.id });
  const proof = PaymentOrderDetailSchema.parse(
    await data(
      await post(
        `/m/payment-orders/${payment.paymentOrderId}/transfer-proofs`,
        { fileId: file.fileId },
        b.owner.withStore(b.storeId),
      ),
    ),
  );
  return data(
    await post(
      `/admin/transfer-proofs/${proof.latestTransferProof!.transferProofId}/confirm`,
      {
        lockVersion: 0,
        bankSerialNo: `TERM-${uuidv7()}`,
        confirmChecks: ["bank_statement_checked"],
        confirm: { orderNo: payment.orderNo, receivedAmountFen: payment.amountFen },
      },
      finance.headers,
    ),
  );
}
beforeAll(async () => {
  api = await h.start();
  db = await h.db.prisma();
  api.clock.set(new Date("2026-01-31T04:00:00Z"));
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(h, api);
  const make = createFactories({ db, clock: api.clock }),
    staff = await make.staff({ staffRoleKey: "super_admin" }),
    doc = await make.fileObject({ bucket: "secure", category: "legal_doc", ext: "pdf" }),
    notices = createNotices({ clock: api.clock, events: api.runtime.events });
  versions = [];
  for (const agreementKey of ["member", "points"]) {
    const id = uuidv7(),
      notice = await api.runtime.tx.run((tx) =>
        notices.announce(tx, identity(staff.id), {
          kind: "agreement_version",
          refId: id,
          title: "周期测试协议",
          summary: "仅本轮测试",
          effectiveAt: api.clock.now(),
          shortNoticeReason: "定向夹具",
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
  finance = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() });
  const approver = await signInAsStaff(db, {
    roleKey: "finance",
    isLead: true,
    now: api.clock.now(),
  });
  await seedPlaceholderFinanceConfig(
    {
      tx: api.runtime.tx,
      clock: api.clock,
      assembly: api.runtime.assembly,
      bizNo: api.runtime.bizNo,
      keyring: security.loadKeyring(api.runtime.env),
    },
    { proposerId: finance.staff.id, approverId: approver.staff.id },
  );
}, 60000);

it("四个周期HTTP资源同scope读持久事实且零写，手动R1同日去重与同键重放只追加一次", async () => {
  const b = await buyer(),
    first = await order(b, 1);
  await pay(b, first);
  const term = await db.subscriptionTerm.findUniqueOrThrow({
    where: { sourceBillingOrderId: first.paymentOrderId },
  });
  api.clock.set(new Date("2026-02-22T04:00:00Z"));
  const admin = await signInAsStaff(db, { roleKey: "super_admin", now: api.clock.now() }),
    manager = await signInAsStaff(db, { roleKey: "delivery_manager", now: api.clock.now() }),
    outsider = await signInAsStaff(db, { roleKey: "delivery_manager", now: api.clock.now() });
  // 授予本轮真实范围，未推进任何付款/周期终态。
  await db.store.update({
    where: { id: b.storeId },
    data: { deliveryManagerId: manager.staff.id },
  });
  const before = await snapshotTables(db, tables);
  const page = SubscriptionTermPageSchema.parse(
    await data(
      await request(
        "admin.subscriptionTerm.list",
        manager.headers,
        "",
        "?tab=expiring&page=1&pageSize=20",
      ),
    ),
  );
  expect(page.items.map((row) => row.subscriptionTermId)).toEqual([term.id]);
  const summary = SubscriptionTermSummarySchema.parse(
    await data(await request("admin.subscriptionTerm.summary", manager.headers)),
  );
  expect(summary).toMatchObject({ expiring: 1, expired: 0, renewed: 0 });
  const detail = SubscriptionTermDetailSchema.parse(
    await data(await request("admin.subscriptionTerm.get", manager.headers, term.id)),
  );
  expect(detail).toMatchObject({
    subscriptionTermId: term.id,
    endDate: "2026-02-27",
    nextTerm: null,
    actions: expect.arrayContaining(["remind"]),
    pointsForecast: { planPointsToExpire: 6600 },
  });
  expect(
    SubscriptionTermPageSchema.parse(
      await data(
        await request("admin.subscriptionTerm.list", outsider.headers, "", "?tab=expiring"),
      ),
    ).items,
  ).toEqual([]);
  await denied(
    await request("admin.subscriptionTerm.get", outsider.headers, term.id),
    404,
    "NOT_FOUND",
  );
  const clerk = await signInAsStaff(db, { roleKey: "editor", now: api.clock.now() });
  await denied(
    await request("admin.subscriptionTerm.get", clerk.headers, term.id),
    403,
    "PERMISSION_DENIED",
  );
  expect(await snapshotTables(db, tables)).toEqual(before);
  const key = uuidv7(),
    firstReminder = SubscriptionTermReminderSchema.parse(
      await data(await request("admin.subscriptionTerm.remind", admin.headers, term.id, "", key)),
    ),
    after = await snapshotTables(db, tables);
  const replay = await request("admin.subscriptionTerm.remind", admin.headers, term.id, "", key);
  expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
  expect(await data(replay)).toEqual(firstReminder);
  expect(await snapshotTables(db, tables)).toEqual(after);
  await denied(
    await request("admin.subscriptionTerm.remind", admin.headers, term.id),
    409,
    "REMINDED_TODAY",
  );
  expect(
    await db.manualReminderLog.count({ where: { subjectId: term.id, scene: "renewal" } }),
  ).toBe(1);
  expect(
    await db.outboxEvent.count({
      where: { eventType: "manual_reminder.sent", aggregateId: firstReminder.manualReminderLogId },
    }),
  ).toBe(1);
  expect(
    SubscriptionTermDetailSchema.parse(
      await data(await request("admin.subscriptionTerm.get", admin.headers, term.id)),
    ),
  ).toMatchObject({ remindedToday: true });
}, 30000);

it("实际期限原语与HTTP提前续费并发后链无空档重叠，已发放不改且同审批键零重复", async () => {
  api.clock.set(new Date("2026-02-22T04:00:00Z"));
  finance = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() });
  const admin = await signInAsStaff(db, { roleKey: "super_admin", now: api.clock.now() }),
    b = await buyer(),
    opening = await order(b, 1);
  await pay(b, opening);
  const current = await db.subscriptionTerm.findUniqueOrThrow({
    where: { sourceBillingOrderId: opening.paymentOrderId },
  });
  const early = await order(b, 1);
  await pay(b, early);
  const another = await order(b, 1),
    granted = await db.grantSchedule.findMany({
      where: { entityId: b.entityId, status: "granted" },
    }),
    input = {
      entityId: b.entityId,
      approvalRequestId: uuidv7(),
      requestNo: `YQ-${uuidv7()}`,
      days: 7,
      ctx: identity(admin.staff.id),
    };
  // 调用真实期限域原语，不制造已批准审批。审批/revive/unexpire由W408消费本口。
  const ledger = createLedger({ clock: api.clock, events: api.runtime.events });
  const [extension] = await Promise.all([
    api.runtime.tx.run((tx) => ledger.applyExtension(tx, input)),
    pay(b, another),
  ]);
  expect(extension).toMatchObject({
    appliedSubscriptionTermId: current.id,
    appliedMode: "extend",
    prevEndDate: "2026-03-21",
    newEndDate: "2026-03-28",
    replayed: false,
  });
  const terms = await db.subscriptionTerm.findMany({
    where: { entityId: b.entityId },
    orderBy: { termNo: "asc" },
  });
  expect(terms.map((t) => t.startDate.toISOString().slice(0, 10))).toEqual([
    "2026-02-22",
    "2026-03-29",
    "2026-04-29",
  ]);
  for (let i = 1; i < terms.length; i++) expect(terms[i]!.startsAt).toEqual(terms[i - 1]!.endsAt);
  expect(terms.slice(1).map((t) => t.anchorDay)).toEqual([29, 29]);
  expect(
    await db.grantSchedule.findMany({ where: { entityId: b.entityId, status: "granted" } }),
  ).toEqual(granted);
  expect(
    await db.pointLot.findFirstOrThrow({ where: { subscriptionTermId: current.id } }),
  ).toMatchObject({ expiresAt: terms[0]!.endsAt });
  const before = await snapshotTables(db, tables);
  expect(await api.runtime.tx.run((tx) => ledger.applyExtension(tx, input))).toEqual({
    ...extension,
    replayed: true,
  });
  expect(await snapshotTables(db, tables)).toEqual(before);
  const detail = SubscriptionTermDetailSchema.parse(
    await data(await request("admin.subscriptionTerm.get", admin.headers, current.id)),
  );
  expect(detail.nextTerm).toMatchObject({ startDate: "2026-03-29", endDate: "2026-04-28" });
}, 30000);
