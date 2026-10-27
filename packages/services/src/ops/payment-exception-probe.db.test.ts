import { afterEach, beforeEach, expect, it } from "vitest";
import type { PaymentExceptionKindCode } from "@liyoxi/contract";
import { createPaymentExceptions, readPaymentExceptionAlertFacts } from "../billing/index.js";
import { sendSystemAlert } from "../notify/index.js";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import {
  createRefundHarnessForTest,
  refundIdempotencyForTest,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import type { RefundHarnessForTest } from "../testing/index.js";
import { financialProbeRules } from "./financial-probe-rules.js";
import { createProbe } from "./probe.js";
import { writeAlertFact } from "./alert-facts.js";

const db = useSeededDatabase("services", { max: 1, label: "exprobe" });
let h: RefundHarnessForTest;
const probes: ReturnType<typeof createProbe>[] = [];
beforeEach(async () => {
  await db.reset();
  h = createRefundHarnessForTest(await db.prisma());
}, 60_000);
afterEach(async () => {
  await Promise.all(probes.splice(0).map((p) => p.close()));
  h?.close();
});
const facts = (at = h.clock.now()) => h.tx.run((tx) => readPaymentExceptionAlertFacts(tx, at));
const rule = () =>
  financialProbeRules(h.prisma, (at) => facts(at)).find((r) => r.key === "payment_exceptions")!;
async function opened(kind: PaymentExceptionKindCode) {
  const own = await h.paid(),
    now = h.clock.now(),
    id = uuidv7(),
    ctx = createIdentityContext({
      actor: { type: "system", job: "lyxtest.recon" },
      entityId: own.entity.id,
    });
  // 探针消费既有对账差异事实；收款/履约先经真实渠道与入账，开单仍经过正式flow。
  await h.tx.run(async (tx) => {
    await tx.paymentException.create({
      data: {
        id,
        exceptionNo: await h.deps.bizNo.next(tx, "CY"),
        kind,
        detectedBy: "query",
        billDate: new Date("2026-01-05T00:00:00Z"),
        entityId: own.entity.id,
        billingOrderId: own.order.id,
        paymentTxnId: own.receipt.id,
        amountFen: own.order.amountFen,
        status: "open",
        resolution: "none",
        dedupeKey: `lyxtest.probe:${id}`,
        createdAt: now,
        updatedAt: now,
      },
    });
    await h.deps.flow.transition(tx, ctx, {
      machine: "payment_exception",
      stateField: "status",
      id,
      event: "payment_exception.open",
      created: true,
      ref: "08:760",
      entityId: own.entity.id,
      audit: {
        stream: "ops",
        category: "recon",
        action: "lyxtest.exception.open",
        summary: "隔离持久差异事实",
        target: { type: "payment_exception", id },
      },
      emit: {
        type: "payment_exception.opened",
        payload: {
          v: 1,
          paymentExceptionId: id,
          kind,
          billingOrderId: own.order.id,
          paymentTxnId: own.receipt.id,
          amountFen: own.order.amountFen,
        },
      },
    });
    await tx.billingOrder.update({
      where: { id: own.order.id },
      data: { hasOpenException: true, updatedAt: now },
    });
  });
  return id;
}
it("新增未决即P1，两高危有独立即时维度；采样只读并将财务与既有超管纳入差异铃铛", async () => {
  await opened("refund_over");
  await opened("entitlement_unrecovered");
  const stable = await snapshotTables(h.prisma, [
    "payment_exception",
    "payment_txn",
    "billing_order",
    "ledger_operation",
    "point_lot",
  ]);
  expect(await rule().sample(h.clock.now())).toEqual([
    {
      rule: "billing.payment_exception",
      dimension: "open",
      severity: "P1",
      detail: { unresolved: 2 },
    },
    {
      rule: "billing.payment_exception",
      dimension: "critical",
      severity: "P1",
      detail: { critical: 2 },
    },
  ]);
  expect(
    await snapshotTables(h.prisma, [
      "payment_exception",
      "payment_txn",
      "billing_order",
      "ledger_operation",
      "point_lot",
    ]),
  ).toEqual(stable);
  const finance = await h.staff(),
    admin = await h.staff("super_admin");
  await h.prisma.notifyScene.update({
    where: { sceneKey: "s.system_alert" },
    data: { sceneEnabled: true },
  });
  await h.tx.run((tx) =>
    writeAlertFact(
      tx,
      { rule: "billing.payment_exception", dimension: "critical", severity: "P1", detail: {} },
      "probe",
      h.clock.now(),
    ),
  );
  const alert = await h.prisma.alertEvent.findFirstOrThrow({
    where: { fingerprint: "billing.payment_exception:critical" },
  });
  await h.tx.run((tx) =>
    sendSystemAlert(
      tx,
      {
        alertId: alert.id,
        fingerprint: alert.fingerprint,
        severity: "P1",
        recovered: false,
        noticeNo: 1,
        at: h.clock.now(),
      },
      h.assembly,
    ),
  );
  expect(
    (await h.prisma.staffMessage.findMany({ where: { notification: { bizId: alert.id } } }))
      .map((m) => m.staffId)
      .sort(),
  ).toEqual([finance.row.id, admin.row.id].sort());
});
it("真实日历周五起算跨周末，恰1工作日不升级，超过1ms才追加升级维度", async () => {
  h.clock.set(new Date("2026-01-09T10:00:00+08:00"));
  await opened("status_mismatch");
  const due = new Date("2026-01-12T10:00:00+08:00");
  expect(await facts(due)).toMatchObject({
    unresolved: 1,
    critical: 0,
    overdue: false,
    oldestDueAt: due.toISOString(),
  });
  expect((await rule().sample(due)).map((a) => a.dimension)).toEqual(["open"]);
  expect((await rule().sample(new Date(due.getTime() + 1))).map((a) => a.dimension)).toEqual([
    "open",
    "overdue",
  ]);
});
it("真实解决差异后三个维度均恢复，沿原探针三次健康观测清除持久告警", async () => {
  const id = await opened("status_mismatch");
  const wall = new Date();
  await h.prisma.workerLease.create({
    data: {
      name: "primary",
      holder: "w411-probe",
      holderVersion: "test",
      acquiredAt: wall,
      heartbeatAt: wall,
    },
  });
  const probe = createProbe({
    db: h.prisma,
    tx: h.tx,
    clock: h.clock,
    holder: () => "w411-probe",
    rules: [rule()],
    logger: { info() {}, warn() {}, error() {} },
  });
  probes.push(probe);
  const tick = async () => {
    h.clock.advance(60_000);
    const result = await probe.run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    return result;
  };
  expect(await tick()).toMatchObject({ completed: true, failed: 0 });
  expect(
    await h.prisma.alertEvent.count({
      where: { rule: "billing.payment_exception", status: "open" },
    }),
  ).toBe(1);
  const actor = await h.staff("super_admin"),
    row = await h.prisma.paymentException.findUniqueOrThrow({ where: { id } });
  const input = {
    lockVersion: row.lockVersion,
    resolution: "corrected" as const,
    note: "真实差异已依运行手册核对",
    confirm: { exceptionNo: row.exceptionNo, amountFen: row.amountFen },
  };
  await createPaymentExceptions({ ...h.deps, fulfillment: h.fulfillment }).resolve(
    actor.ctx,
    actor.staff,
    id,
    input,
    refundIdempotencyForTest(actor.ctx, "admin.paymentException.resolve", input),
  );
  expect(await rule().sample(h.clock.now())).toEqual([]);
  for (let n = 0; n < 3; n++) expect(await tick()).toMatchObject({ completed: true, failed: 0 });
  expect(
    await h.prisma.alertEvent.findFirst({ where: { rule: "billing.payment_exception" } }),
  ).toMatchObject({ status: "resolved", okStreak: 3 });
});
