import assert from "node:assert/strict";
import { sourceBill } from "@liyoxi/services/testing";
import type { M4Support } from "@liyoxi/services/testing";
import type { M1Api } from "./in-process.js";
import type { M1AuthenticatedStaff } from "./m1-auth.js";
import { createM1Caller } from "./runner-api.js";

export async function runM4Reconciliation(input: {
  api: M1Api;
  support: M4Support;
  finance: M1AuthenticatedStaff;
  entityId: string;
  billDate: string;
  payment: { outTradeNo: string; transactionId: string; amountFen: number };
  refund: { outRefundNo: string; refundId: string; amountFen: number };
}) {
  const { api, support, finance, billDate, payment, refund } = input;
  const identity = { appid: "wxlyxm1demo000001", mchid: "1900000109" };
  // 独立原始分向量：实际付款与退款各一行，另一个没有平台单的100分事实须形成真实差异。
  support.providers.wechatPay.setTradeBill(
    billDate,
    sourceBill(billDate, [
      {
        ...identity,
        outTradeNo: payment.outTradeNo,
        transactionId: payment.transactionId,
        amountFen: payment.amountFen,
        feeFen: 0,
      },
      {
        ...identity,
        outTradeNo: payment.outTradeNo,
        transactionId: payment.transactionId,
        refund: {
          outRefundNo: refund.outRefundNo,
          refundId: refund.refundId,
          applicationFen: refund.amountFen,
        },
        feeFen: 0,
      },
      {
        ...identity,
        outTradeNo: `FK${billDate.replaceAll("-", "")}99999-01-ABC419`,
        transactionId: `M4ORPHAN${support.runId}`,
        amountFen: 100,
        feeFen: 0,
      },
    ]),
  );
  const job = support.runtime.assembly.recurringJob("bill.download");
  assert.ok(job);
  // 使用原90日生产窗口；仅目标日有合法样本，其他missing保留waiting，不能假称对平。
  const downloaded = await job.run({
    scheduledFor: support.clock.now(),
    signal: new AbortController().signal,
    runTx: (fn) => support.runtime.tx.run(fn),
  });
  assert.deepEqual(downloaded, { parsed: 1, waiting: 89, failed: 0 });
  const call = createM1Caller(api),
    headers = finance.headers;
  const month = await call("admin.reconciliation.list", headers, {
    query: { month: billDate.slice(0, 7) },
  });
  const day = month.items.find((row) => row.billDate === billDate);
  assert.ok(day?.reconciliationId);
  assert.equal(day.billFileStatus, "parsed");
  assert.equal(day.status, "diff");
  assert.equal(day.billPay?.amountFen, String(payment.amountFen + 100));
  assert.equal(day.refund?.platformFen, String(refund.amountFen));
  assert.equal(day.refund?.billFen, String(refund.amountFen));
  assert.ok(month.openExceptions.some((row) => row.kind === "bill_only" && row.amountFen === 100));
  const before = await support.financeFacts(input.entityId);
  const options = {
    key: `m4-${support.runId}-reconcile`,
    params: { reconciliationId: day.reconciliationId },
    body: { confirm: { billDate } },
  };
  const first = await call("admin.reconciliation.rerun", headers, options);
  assert.equal(first.runCount, day.runCount + 1);
  assert.equal(first.status, "diff");
  assert.deepEqual(await call("admin.reconciliation.rerun", headers, options), first);
  const after = await support.financeFacts(input.entityId);
  assert.equal(after.operations, before.operations);
  assert.equal(after.ledgerEntries, before.ledgerEntries);
  assert.deepEqual(
    after.payments.map((row) => row.id),
    before.payments.map((row) => row.id),
  );
  return { billDate, status: first.status, parsed: 1, waiting: 89, failed: 0 };
}
