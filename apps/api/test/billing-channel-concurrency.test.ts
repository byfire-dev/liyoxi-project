// W4-03：真实HTTP三入口同时等待本单行锁；无业务状态SQL写或服务返回替身。
import { setTimeout as delay } from "node:timers/promises";

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
  snapshotTables,
  sampleStaffContext,
  signInAsStaff,
} from "@liyoxi/services/testing";
import type { FakeWechatPay } from "@liyoxi/services/testing";
import {
  PaymentOrderDetailSchema,
  PaymentOrderWechatPrepayResultSchema,
  PaymentOrderCancelResultSchema,
} from "@liyoxi/contract";
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
const post = (
  path: string,
  json: unknown,
  headers: Record<string, string>,
  key: string | null = uuidv7(),
) =>
  api.request(`/api/v1${path}`, {
    method: "POST",
    ...(json === undefined ? {} : { json }),
    headers: { ...headers, ...(key ? { "Idempotency-Key": key } : {}) },
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

const observed = [
  "billing_order",
  "payment_txn",
  "ledger_operation",
  "point_ledger_entry",
  "point_lot",
  "subscription_term",
  "grant_schedule",
  "payment_exception",
  "subscription_event",
  "outbox_event",
  "status_transition",
  "audit_log",
  "biz_sequence",
  "timer",
];
type LockEdge = { pid: number; blockers: number[] };
async function waitThree(
  holder: number,
  observation: { max: number; direct: number; edges: LockEdge[] },
) {
  const deadline = performance.now() + 1000;
  for (;;) {
    // PG17：pg_blocking_pids只给当前hard/soft blocker，不是祖先集合。
    // https://www.postgresql.org/docs/17/functions-info.html#FUNCTIONS-INFO-SESSION-TABLE
    const rows = await db.$queryRaw<
      LockEdge[]
    >`SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND pid<>${holder}::int AND pid<>pg_backend_pid() ORDER BY pid`;
    observation.edges = rows.filter((row) => row.blockers.length > 0);
    observation.direct = observation.edges.filter((row) => row.blockers.includes(holder)).length;
    const reached = new Set([holder]);
    // 每轮只加入新PID；最多边数轮，未连到holder的环不能凭空成为屏障证据。
    for (let pass = 0; pass < observation.edges.length; pass++) {
      const before = reached.size;
      for (const row of observation.edges) {
        if (row.blockers.some((blocker) => reached.has(blocker))) reached.add(row.pid);
      }
      if (reached.size === before) break;
    }
    const waiters = reached.size - 1;
    observation.max = Math.max(observation.max, waiters);
    if (waiters >= 3) return waiters;
    if (performance.now() >= deadline) throw new Error("三条真实HTTP事务未同时等待本轮付款单锁");
  }
}
async function hook(wire: ReturnType<FakeWechatPay["encode"]>) {
  return api.request("/api/v1/hooks/wechatpay/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...wire.headers },
    body: wire.rawBody,
  });
}

describe("W4-03 多入口真实HTTP行锁竞争", { timeout: 90_000 }, () => {
  it("三轮回调/sync/cancel到达实际DB屏障后释放：GET仅一笔paid/履约、全入口重放不新增事实", async () => {
    for (let round = 0; round < 3; round++) {
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
      const event = pay.pay(receipt.outTradeNo),
        wire = pay.encode(event);
      let announce!: () => void,
        release!: () => void,
        holderPid = 0;
      const held = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = api.runtime.tx.run(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM billing_order WHERE id=${o.paymentOrderId}::uuid FOR UPDATE`;
          holderPid = (
            await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`
          )[0]!.pid;
          announce();
          await released;
        },
        { timeoutMs: 10000 },
      );
      const cancelKey = uuidv7(),
        path = `/m/payment-orders/${o.paymentOrderId}`;
      let requests: Promise<Response>[] = [];
      const observation: { max: number; direct: number; edges: LockEdge[] } = {
        max: 0,
        direct: 0,
        edges: [],
      };
      let barrierFailed = false;
      try {
        await Promise.race([
          held,
          holder.then(() => {
            throw new Error("本轮真实付款单锁屏障未建立");
          }),
        ]);
        requests = [
          hook(wire),
          post(`${path}/sync`, undefined, b.owner.withStore(b.storeId), null),
          post(`${path}/cancel`, undefined, b.owner.withStore(b.storeId), cancelKey),
        ];
        expect(await waitThree(holderPid, observation), `第${round + 1}轮`).toBe(3);
        console.warn(
          JSON.stringify({
            event: "w403.lock-evidence",
            round: round + 1,
            holderPid,
            chainWaiters: observation.max,
            directWaiters: observation.direct,
            edges: observation.edges,
          }),
        );
      } catch (error) {
        barrierFailed = true;
        throw error;
      } finally {
        release();
        await holder;
        const settledRequests = await Promise.allSettled(requests);
        if (barrierFailed) {
          const statuses = await Promise.all(
            settledRequests.map(async (result) => {
              if (result.status === "rejected") return { kind: "rejected" as const };
              const response = result.value;
              const raw: unknown = await response
                .clone()
                .json()
                .catch(() => null);
              const symbol =
                raw &&
                typeof raw === "object" &&
                "error" in raw &&
                typeof raw.error === "string" &&
                /^[A-Z][A-Z0-9_]{0,100}$/.test(raw.error)
                  ? raw.error
                  : undefined;
              return { status: response.status, ...(symbol ? { error: symbol } : {}) };
            }),
          );
          console.warn(
            JSON.stringify({
              event: "w403.barrier",
              round: round + 1,
              maxWaiters: observation.max,
              directWaiters: observation.direct,
              holderPid,
              edges: observation.edges,
              statuses,
            }),
          );
        }
      }
      const responses = await Promise.all(requests);
      if (responses.some((response) => response.status !== 200)) {
        const statuses = responses.map((response, index) => {
          const requestId = response.headers.get("X-Request-Id");
          return {
            entry: ["callback", "sync", "cancel"][index],
            status: response.status,
            requestId: requestId && /^[0-9a-f-]{36}$/i.test(requestId) ? requestId : null,
          };
        });
        const errors = api.logs
          .filter(
            (log) => log.evt === "http.error" && statuses.some((s) => s.requestId === log.reqId),
          )
          .map((log) => {
            const err = log.err;
            // Pino折叠cause至message；只提取固定码/类别，不输出原message、stack或err。
            const message =
              err && typeof err === "object" && "message" in err && typeof err.message === "string"
                ? err.message
                : "";
            return {
              requestId: log.reqId,
              error:
                typeof log.error === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(log.error)
                  ? log.error
                  : null,
              codes: [
                ...new Set(message.match(/\b(?:P\d{4}|40P01|40001|55P03|57014|25P02)\b/g) ?? []),
              ],
              deadlock: /deadlock detected/i.test(message),
              transactionClosed: /transaction already closed/i.test(message),
              transactionStartTimeout: /unable to start a transaction in the given time/i.test(
                message,
              ),
            };
          });
        console.warn(
          JSON.stringify({ event: "w403.response-failure", round: round + 1, statuses, errors }),
        );
      }
      expect(responses[0]!.status).toBe(200);
      expect(await responses[0]!.text()).toBe("");
      expect(PaymentOrderDetailSchema.parse(await data(responses[1]!))).toMatchObject({
        status: "paid",
        fulfillmentStatus: "done",
      });
      expect(PaymentOrderCancelResultSchema.parse(await data(responses[2]!))).toMatchObject({
        outcome: "paid",
        paymentOrder: { status: "paid", fulfillmentStatus: "done" },
      });
      const saved = PaymentOrderDetailSchema.parse(
        await data(await api.request(`/api/v1${path}`, { headers: b.owner.withStore(b.storeId) })),
      );
      expect(saved).toMatchObject({
        status: "paid",
        paidAmountFen: o.amountFen,
        fulfillmentStatus: "done",
      });
      expect(
        await db.paymentTxn.count({
          where: { billingOrderId: o.paymentOrderId, appliedAt: { not: null } },
        }),
      ).toBe(1);
      expect(
        await db.subscriptionTerm.count({ where: { sourceBillingOrderId: o.paymentOrderId } }),
      ).toBe(1);
      expect(
        await db.ledgerOperation.count({
          where: { opKey: `fulfill:billing_order:${o.paymentOrderId}` },
        }),
      ).toBe(1);
      expect(
        await db.outboxEvent.count({
          where: { aggregateId: o.paymentOrderId, eventType: "billing_order.paid" },
        }),
      ).toBe(1);
      // 正式HTTP建单本来就写create历史；入账只能再写一条pending→paid。
      expect(
        await db.statusTransition.findMany({
          where: { machine: "billing_order", subjectId: o.paymentOrderId },
          orderBy: { seq: "asc" },
          select: { event: true, fromState: true, toState: true },
        }),
      ).toEqual([
        { event: "billing_order.create", fromState: null, toState: "pending_payment" },
        { event: "billing_order.apply_payment", fromState: "pending_payment", toState: "paid" },
      ]);
      const settled = await snapshotTables(db, observed);
      expect((await hook(wire)).status).toBe(200);
      // Redis按真实PEXPIRE计时；首次sync已返回，再等原3秒窗口自然到期，不清键或改额度。
      await delay(3_000);
      expect(
        PaymentOrderDetailSchema.parse(
          await data(await post(`${path}/sync`, undefined, b.owner.withStore(b.storeId), null)),
        ),
      ).toMatchObject({ status: "paid" });
      const replay = await post(
        `${path}/cancel`,
        undefined,
        b.owner.withStore(b.storeId),
        cancelKey,
      );
      expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
      expect(PaymentOrderCancelResultSchema.parse(await data(replay)).outcome).toBe("paid");
      expect(await snapshotTables(db, observed)).toEqual(settled);
    }
  });
});
