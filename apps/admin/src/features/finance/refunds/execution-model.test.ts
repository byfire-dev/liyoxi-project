import { expect, it, vi } from "vitest";
import {
  allowedRefundExecutions,
  createRefundExecutionIntent,
  emptyOfflineRefund,
  pendingRefundTxn,
  refundExecutionCommand,
  refundExecutionStamp,
} from "./execution-model";
import { at, executionAccess, executionFixture, id, otherId } from "./execution.test-support";

it("执行动作交实际状态/actions/权限/路由与唯一原退款单；系统来源和回单权限不得绕过", () => {
  const row = executionFixture();
  expect(allowedRefundExecutions(row, executionAccess)).toEqual(["execute", "record-offline"]);
  expect(allowedRefundExecutions({ ...row, source: "staging_probe" }, executionAccess)).toEqual([]);
  expect(allowedRefundExecutions(row, { ...executionAccess, actions: [] })).toEqual([]);
  expect(
    allowedRefundExecutions(row, { ...executionAccess, actions: ["finance.refund.execute"] }),
  ).toEqual(["execute"]);
  expect(allowedRefundExecutions({ ...row, entity: null }, executionAccess)).toEqual([
    "execute",
    "record-offline",
  ]);
  expect(
    allowedRefundExecutions({ ...row, entity: null }, { ...executionAccess, dataScope: "own" }),
  ).toEqual(["execute"]);
  expect(
    allowedRefundExecutions(
      { ...row, entity: null, paymentTxn: { ...row.paymentTxn, channel: "bank_transfer" } },
      executionAccess,
    ),
  ).toEqual([]);
  expect(allowedRefundExecutions({ ...row, allowedRoutes: [] }, executionAccess)).toEqual([]);
  row.status = "executing";
  row.canRetry = true;
  row.canConfirmNotAccepted = true;
  row.actions = ["retry", "confirm-not-accepted"];
  row.refundTxns = [
    {
      refundTxnId: id,
      outRefundNo: "TK-ACTUAL-01",
      channel: "wechat_jsapi",
      origin: "system",
      status: "created",
      amountFen: row.amountFen,
      channelRefundNo: null,
      submitCount: 2,
      lastSubmitAt: at,
      isRetryHalted: true,
      failCode: "unavailable",
      failMessage: "渠道结果未知",
      successAt: null,
      userReceivedAccount: null,
      isLateSuccess: false,
      offline: null,
    },
  ];
  expect(allowedRefundExecutions(row, executionAccess)).toEqual(["retry", "confirm-not-accepted"]);
  expect(refundExecutionCommand(row, "retry", emptyOfflineRefund(row))).toEqual({
    action: "retry",
    body: { confirm: { requestNo: row.requestNo, outRefundNo: "TK-ACTUAL-01" } },
  });
  expect(refundExecutionCommand(row, "confirm-not-accepted", emptyOfflineRefund(row)).body).toEqual(
    { confirm: { requestNo: row.requestNo, outRefundNo: "TK-ACTUAL-01" } },
  );
  row.refundTxns.push({ ...row.refundTxns[0]!, refundTxnId: otherId, outRefundNo: "TK-OTHER-01" });
  expect(pendingRefundTxn(row)).toBeUndefined();
  expect(allowedRefundExecutions(row, executionAccess)).toEqual([]);
});
it("正式执行/线下body来自实际单号金额和原交易；不添加版本，版本变化失效确认快照", () => {
  const row = executionFixture(),
    empty = emptyOfflineRefund(row);
  expect(refundExecutionCommand(row, "execute", empty)).toEqual({
    action: "execute",
    body: {
      confirm: {
        requestNo: row.requestNo,
        amountFen: row.amountFen,
        channelTxnNo: row.paymentTxn.channelTxnNo,
      },
      confirmChecks: ["original_txn_checked"],
    },
  });
  expect(() => refundExecutionCommand(row, "record-offline", empty)).toThrow();
  const draft = {
    ...empty,
    transferDate: "2030-10-18",
    bankSerialNo: "FICTIONAL-SERIAL",
    payeeName: "虚构主体",
    payeeBank: "虚构银行",
    payeeAccount: "000000001234",
    receiptFileId: otherId,
    note: "原路改线下，人工核对",
  };
  expect(refundExecutionCommand(row, "record-offline", draft)).toEqual({
    action: "record-offline",
    body: {
      ...draft,
      confirm: { requestNo: row.requestNo, amountFen: row.amountFen },
      confirmChecks: ["offline_transfer_checked"],
    },
  });
  expect(() => refundExecutionCommand(row, "record-offline", { ...draft, note: "" })).toThrow();
  const stamp = refundExecutionStamp(row);
  row.approval.lockVersion++;
  expect(refundExecutionStamp(row)).not.toBe(stamp);
});
it("执行同意图同步挡双击/失败原key；scope关闭取消并拒绝迟到结果", async () => {
  let serial = 0,
    finish!: (value: string) => void,
    signal: AbortSignal | undefined;
  const intent = createRefundExecutionIntent(() => `exec:${++serial}`);
  const first = intent.submit("execute", [id, "same"], async (_key, own) => {
    signal = own;
    return new Promise<string>((done) => {
      finish = done;
    });
  });
  expect(await intent.submit("execute", [id, "same"], async () => "duplicate")).toBeUndefined();
  intent.close();
  expect(signal?.aborted).toBe(true);
  finish("late");
  expect(await first).toBeUndefined();
  intent.activate();
  const failed = vi.fn(async (_key: string) => {
    throw new Error("未知写结果");
  });
  await expect(intent.submit("execute", [id, "same"], failed)).rejects.toThrow();
  await expect(intent.submit("execute", [id, "same"], failed)).rejects.toThrow();
  expect(failed.mock.calls[1]?.[0]).toBe(failed.mock.calls[0]?.[0]);
  await expect(intent.submit("execute", [id, "changed"], failed)).rejects.toThrow();
  expect(failed.mock.calls[2]?.[0]).not.toBe(failed.mock.calls[1]?.[0]);
});
