import { expect, it } from "vitest";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import {
  createRefundExecutionApi,
  refundExecutionError,
  refundExecutionNeedsReload,
} from "./execution-api";
import type { RefundExecutionCommand } from "./execution-types";
import { executionFixture, id, otherId } from "./execution.test-support";
function transport(fetch: (request: Request) => Promise<Response>, stepUp = async () => false) {
  const handlers: ApiHandlers = {
    redirectToLogin() {},
    stepUp,
    refreshAccess() {},
    invalidateQueries() {},
    notify() {},
    showBlocked() {},
    buildMismatch() {},
  };
  return createRefundExecutionApi({
    api: createAdminApi({
      baseUrl: "https://finance.example.test",
      build: "refund-execution",
      handlers,
      fetch,
    }),
  });
}
const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, data }), {
    headers: { "Content-Type": "application/json" },
  });
it("四typed口回传实际ID/正式body/原key，再验证重放保持同key且响应须关联当前申请", async () => {
  const row = executionFixture(),
    requests: Request[] = [],
    signal = new AbortController().signal;
  let attempts = 0,
    verified = 0;
  const api = transport(
    async (request) => {
      requests.push(request.clone());
      if (attempts++ === 0)
        return new Response(JSON.stringify({ error: "STEP_UP_REQUIRED", message: "PRIVATE" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      return ok(row);
    },
    async () => {
      verified++;
      return true;
    },
  );
  const commands: RefundExecutionCommand[] = [
    {
      action: "execute",
      body: {
        confirm: {
          requestNo: row.requestNo,
          amountFen: row.amountFen,
          channelTxnNo: "FICTIONAL-CHANNEL",
        },
        confirmChecks: ["original_txn_checked"],
      },
    },
    {
      action: "retry",
      body: { confirm: { requestNo: row.requestNo, outRefundNo: "FICTIONAL-REFUND" } },
    },
    {
      action: "confirm-not-accepted",
      body: { confirm: { requestNo: row.requestNo, outRefundNo: "FICTIONAL-REFUND" } },
    },
    {
      action: "record-offline",
      body: {
        transferDate: "2030-10-18",
        bankSerialNo: "FICTIONAL-SERIAL",
        payeeName: "虚构主体",
        payeeBank: "虚构银行",
        payeeAccount: "000000001234",
        receiptFileId: otherId,
        confirm: { requestNo: row.requestNo, amountFen: row.amountFen },
        confirmChecks: ["offline_transfer_checked"],
      },
    },
  ];
  for (const command of commands) await api.write(row, command, `same:${command.action}`, signal);
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual(
    ["execute", "execute", "retry", "confirm-not-accepted", "record-offline"].map(
      (action) => `/api/v1/admin/refund-requests/${id}/${action}`,
    ),
  );
  expect(requests.map((request) => request.headers.get("Idempotency-Key"))).toEqual([
    "same:execute",
    "same:execute",
    "same:retry",
    "same:confirm-not-accepted",
    "same:record-offline",
  ]);
  expect(await requests[0]!.json()).toEqual(commands[0]!.body);
  expect(await requests[4]!.json()).toEqual(commands[3]!.body);
  expect(verified).toBe(1);
  await expect(
    transport(async () => ok({ ...row, refundRequestId: otherId })).write(
      row,
      commands[0]!,
      "mismatch",
      signal,
    ),
  ).rejects.toMatchObject({ symbol: "RESPONSE_MISMATCH" });
});
it("超额/流水冲突仅展示真实白名单details与安全符号；取消传入fetch，迟到写不假成功", async () => {
  const row = executionFixture(),
    command: RefundExecutionCommand = {
      action: "retry",
      body: { confirm: { requestNo: row.requestNo, outRefundNo: "FICTIONAL" } },
    };
  for (const symbol of ["REFUND_EXCEEDS_REFUNDABLE", "BANK_SERIAL_DUPLICATE"]) {
    const failure = await transport(
      async () =>
        new Response(
          JSON.stringify({
            error: symbol,
            message: "PRIVATE-BANK-ACCOUNT",
            details: {
              refundableFen: 0,
              serialNormalized: "ACTUAL-SERIAL",
              payeeAccount: "PRIVATE-ACCOUNT",
            },
            requestId: "FICTIONAL-12345678",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    )
      .write(row, command, "same", new AbortController().signal)
      .catch((error: unknown) => error);
    expect(refundExecutionNeedsReload(failure)).toBe(true);
    const message = refundExecutionError(failure);
    expect(message).toContain(symbol === "BANK_SERIAL_DUPLICATE" ? "ACTUAL-SERIAL" : "¥0.00");
    expect(message).not.toContain("PRIVATE");
    expect(message).toContain("12345678");
  }
  let entered!: () => void;
  const ready = new Promise<void>((done) => {
    entered = done;
  });
  const api = transport(
    (request) =>
      new Promise<Response>((_done, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
        entered();
      }),
  );
  const controller = new AbortController(),
    pending = api.write(row, command, "cancel", controller.signal),
    stopped = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await ready;
  controller.abort();
  await stopped;
});
