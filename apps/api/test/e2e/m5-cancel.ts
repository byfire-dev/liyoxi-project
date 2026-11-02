import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { M5Support } from "@liyoxi/services/testing";
import type { M1ProductionHookContext } from "./runner.js";
import type { M5Call } from "./m5-http.js";
import { expectM5Failure, uploadM5Object } from "./m5-http.js";
import type { M5Actors } from "./m5-ad.js";

async function fundM5Cancellation(
  call: M5Call,
  support: M5Support,
  context: M1ProductionHookContext,
  shortfallPoints: number,
) {
  const { owner, admin } = context;
  assert.ok(Number.isSafeInteger(shortfallPoints) && shortfallPoints > 0);
  const packs = await call("m.pointPack.list", owner.headers);
  const pack = packs.items
    .filter((row) => row.priceFen !== null && row.points >= shortfallPoints)
    .sort((a, b) => a.points - b.points)[0];
  assert.ok(
    pack?.priceFen,
    "M5 cancellation needs a current purchasable pack covering its shortfall",
  );
  const before = await call("m.wallet.get", owner.headers);
  const agreements = await call("m.agreement.list", owner.headers, { query: { scene: "topup" } });
  const payment = await call("m.paymentOrder.create", owner.headers, {
    key: `m5-${support.runId}-cancel-funding-order`,
    body: {
      pointPackId: pack.pointPackId,
      channel: "bank_transfer",
      expectAmountFen: pack.priceFen,
      agreementVersionIds: agreements.items.flatMap((row) =>
        row.currentVersion ? [row.currentVersion.agreementVersionId] : [],
      ),
    },
  });
  assert.equal(payment.type, "topup");
  assert.equal(payment.amountFen, pack.priceFen);
  const receiptBytes = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4o8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const receipt = (
    await call("m.file.create", owner.headers, {
      key: `m5-${support.runId}-cancel-funding-receipt`,
      body: {
        category: "pay_receipt",
        files: [
          {
            fileName: "m5-cancel-funding-receipt.png",
            sizeBytes: String(receiptBytes.length),
            clientToken: randomUUID(),
          },
        ],
      },
    })
  ).items[0]!;
  await uploadM5Object(support, receipt, receiptBytes);
  await call("m.file.complete", owner.headers, {
    key: `m5-${support.runId}-cancel-funding-receipt-complete`,
    params: { fileId: receipt.fileId },
    body: {},
  });
  await support.promote(receipt.fileId);
  const proof = await call("m.paymentOrder.transferProof.create", owner.headers, {
    key: `m5-${support.runId}-cancel-funding-proof`,
    params: { paymentOrderId: payment.paymentOrderId },
    body: { fileId: receipt.fileId },
  });
  assert.ok(proof.latestTransferProof);
  const params = { transferProofId: proof.latestTransferProof.transferProofId };
  const view = await call("admin.transferProof.get", admin.headers, { params });
  await call("admin.transferProof.confirm", admin.headers, {
    key: `m5-${support.runId}-cancel-funding-confirm`,
    params,
    body: {
      lockVersion: view.lockVersion,
      bankSerialNo: `M5-${support.runId}-CANCEL-FUNDS`,
      confirmChecks: ["bank_statement_checked"],
      confirm: { orderNo: payment.orderNo, receivedAmountFen: payment.amountFen },
    },
  });
  await support.drainEvents();
  const paid = await call("m.paymentOrder.get", owner.headers, {
    params: { paymentOrderId: payment.paymentOrderId },
  });
  assert.equal(paid.status, "paid");
  assert.equal(paid.fulfillmentStatus, "done");
  assert.equal(paid.content.pointPackId, pack.pointPackId);
  assert.equal(paid.fulfillment?.points, pack.points);
  const after = await call("m.wallet.get", owner.headers);
  assert.equal(after.points.spendablePoints, before.points.spendablePoints + pack.points);
  assert.equal(after.points.planAvailablePoints, before.points.planAvailablePoints);
  assert.equal(after.points.addonAvailablePoints, before.points.addonAvailablePoints + pack.points);
  assert.equal(after.points.heldPoints, before.points.heldPoints);
}

export async function runM5Cancellation(
  call: M5Call,
  support: M5Support,
  context: M1ProductionHookContext,
  actors: M5Actors,
) {
  const { owner, admin } = context;
  const current = await call("admin.paramValue.list", admin.headers, {
    query: { keys: "refund.points.auto_approve_before_production" },
  });
  const parameter = current.items.find(
    (row) => row.key === "refund.points.auto_approve_before_production",
  );
  assert.ok(parameter);
  await call("admin.paramValue.replace", admin.headers, {
    key: `m5-${support.runId}-manual-approval`,
    body: {
      items: [{ key: parameter.key, value: false, expectedRev: parameter.latestRev }],
      reason: "隔离M5链验证真实异人取消审批，不改任何生产配置",
    },
  });
  const list = await call("m.drama.list", owner.headers);
  const candidates = [];
  for (const drama of list.items.filter((row) => row.totalEpisodes !== 20)) {
    const quote = await call("m.order.quote", owner.headers, {
      body: {
        dramaIds: [drama.dramaId],
        channelAccountIds: [context.channelAccountId],
        isTopModel: false,
      },
    });
    if (quote.blockers.every((row) => row.code === "POINTS_INSUFFICIENT"))
      candidates.push({ drama, quote });
  }
  candidates.sort((a, b) => a.quote.totalChargePoints - b.quote.totalChargePoints);
  const selected = candidates.find((row) => row.quote.blockers.length === 0) ?? candidates[0];
  assert.ok(selected, "M5 separate cancellation needs another actual orderable demo drama");
  const { drama } = selected;
  let { quote } = selected;
  if (quote.blockers.length) {
    const beforeFunding = await call("m.wallet.get", owner.headers);
    await fundM5Cancellation(
      call,
      support,
      context,
      quote.totalChargePoints - beforeFunding.points.spendablePoints,
    );
    quote = await call("m.order.quote", owner.headers, {
      body: {
        dramaIds: [drama.dramaId],
        channelAccountIds: [context.channelAccountId],
        isTopModel: false,
      },
    });
    assert.equal(quote.totalChargePoints, selected.quote.totalChargePoints);
  }
  assert.deepEqual(quote.blockers, []);
  const wallet = await call("m.wallet.get", owner.headers);
  // Independent rule oracle: an unstarted, never-captured hold is released 100%; no manual
  // deduction, conversion or forfeiture. The base is the original purchase, not cancelQuote.
  const expectedRefund = quote.totalChargePoints;
  assert.ok(Number.isSafeInteger(expectedRefund) && expectedRefund > 0);
  const order = await call("m.order.create", owner.headers, {
    key: `m5-${support.runId}-cancel-order`,
    body: {
      dramaIds: [drama.dramaId],
      channelAccountIds: [context.channelAccountId],
      focusCodes: ["CF01"],
      isTopModel: false,
      expectedLaunchDate: quote.earliestLaunchDate,
      agreementVersionId: quote.agreement.agreementVersionId,
      expect: quote.expect,
    },
  });
  const owned = { ...owner, orderId: order.orderId };
  const frozen = await support.readM5Facts(owned);
  assert.equal(frozen.orders[0]?.status, "pending_start");
  const hold = frozen.holds.find(
    (row) => row.refType === "order_item" && frozen.items.some((item) => item.id === row.refId),
  );
  assert.ok(hold);
  assert.equal(hold.qty, expectedRefund);
  assert.equal(hold.status, "held");
  assert.equal(hold.capturedAt, null);
  const cancellation = await call("admin.order.cancelQuote", admin.headers, {
    params: { orderId: order.orderId },
    body: { reasonCode: "merchant_request" },
  });
  assert.deepEqual(cancellation.blockers, []);
  assert.equal(cancellation.totalRefundPoints, expectedRefund);
  assert.equal(cancellation.totalDeductPoints, 0);
  assert.equal(cancellation.destination.backToOriginal, expectedRefund);
  assert.equal(cancellation.destination.convertedToAddon, 0);
  assert.equal(cancellation.destination.forfeited, 0);
  const requested = await call("admin.order.cancelRequest.create", admin.headers, {
    key: `m5-${support.runId}-cancel-request`,
    params: { orderId: order.orderId },
    body: {
      reasonCode: "merchant_request",
      note: "商家确认取消尚未开工的独立订购",
      expect: { totalRefundPoints: expectedRefund },
    },
  });
  assert.equal(requested.status, "pending_approval");
  assert.equal(requested.requester?.staffId, admin.staffId);
  const params = { cancelRequestId: requested.cancelRequestId };
  const approve = {
    lockVersion: requested.approval.lockVersion,
    confirm: { requestNo: requested.requestNo, totalRefundPoints: expectedRefund },
    confirmChecks: ["stage_rule_amount_checked" as const],
  };
  await expectM5Failure(
    context.api,
    `/api/v1/admin/cancel-requests/${requested.cancelRequestId}/approve`,
    admin.headers,
    approve,
    403,
    "APPROVAL_SELF_FORBIDDEN",
    `m5-${support.runId}-self-approve`,
  );
  const approved = await call("admin.cancelRequest.approve", actors.finance.headers, {
    key: `m5-${support.runId}-cancel-approve`,
    params,
    body: approve,
  });
  assert.equal(approved.status, "pending_execution");
  assert.equal(approved.approval.decidedBy?.staffId, actors.finance.staffId);
  assert.notEqual(approved.approval.decidedBy?.staffId, requested.requester?.staffId);
  const beforeExecution = await support.readM5Facts({
    ...owned,
    cancelRequestId: requested.cancelRequestId,
  });
  assert.equal(beforeExecution.holds.find((row) => row.id === hold.id)?.status, "held");
  assert.equal(beforeExecution.wallet.heldTotalQty, frozen.wallet.heldTotalQty);
  const done = await call("admin.cancelRequest.execute", admin.headers, {
    key: `m5-${support.runId}-cancel-execute`,
    params,
    body: {
      confirm: { requestNo: requested.requestNo, totalRefundPoints: expectedRefund },
      confirmChecks: ["order_points_checked"],
    },
  });
  assert.equal(done.status, "done");
  assert.deepEqual(done.resultTotals, {
    returnedPoints: expectedRefund,
    convertedPoints: 0,
    forfeitedPoints: 0,
  });
  const after = await support.readM5Facts({ ...owned, cancelRequestId: requested.cancelRequestId });
  assert.equal(after.holds.find((row) => row.id === hold.id)?.status, "released");
  assert.equal(after.wallet.heldTotalQty, 0);
  assert.equal(
    after.wallet.planAvailableQty + after.wallet.addonAvailableQty,
    wallet.points.spendablePoints,
  );
  const releases = after.operations.filter(
    (row) => row.pointHoldId === hold.id && row.opType === "release",
  );
  assert.equal(releases.length, 1);
  assert.equal(releases[0]!.planDeltaQty + releases[0]!.addonDeltaQty, expectedRefund);
  const entries = after.ledger.filter((row) => row.ledgerOperationId === releases[0]!.id);
  assert.equal(
    entries.reduce((total, row) => total + row.qty, 0),
    expectedRefund,
  );
  assert.ok(entries.every((row) => row.fromBucket === "held" && row.toBucket === "available"));
  assert.equal(after.cancelLines.length, 1);
  assert.equal(after.cancelLines[0]!.returnedPoints, expectedRefund);
  assert.equal(after.cancelLines[0]!.convertedPoints, 0);
  assert.equal(after.cancelLines[0]!.forfeitedPoints, 0);
  const read = await call("admin.cancelRequest.get", admin.headers, { params });
  assert.equal(read.execution?.executedBy?.staffId, admin.staffId);
  await call("admin.order.activity.list", admin.headers, { params: { orderId: order.orderId } });
  return { id: requested.cancelRequestId, status: "done" as const, refundPoints: expectedRefund };
}
