import { expect, it } from "vitest";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import { createInvoiceApi, invoiceError, invoiceNeedsReload } from "./api";
import { fileId, invoiceFixture, invoiceId } from "./fixtures.test-support";
const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, data }), {
    headers: { "Content-Type": "application/json" },
  });
function api(
  fetch: (request: Request) => Promise<Response>,
  stepUp: () => Promise<boolean> = async () => false,
) {
  const handlers: ApiHandlers = {
    redirectToLogin() {},
    stepUp,
    refreshAccess() {},
    invalidateQueries() {},
    notify() {},
    showBlocked() {},
    buildMismatch() {},
  };
  return createInvoiceApi({
    api: createAdminApi({
      baseUrl: "https://finance.example.test",
      build: "invoice",
      handlers,
      fetch,
    }),
  });
}
it("真实typed GET筛选/KPI/详情与四写口使用准确id/body/key；再验证后重放同key", async () => {
  const requests: Request[] = [],
    row = invoiceFixture(),
    signal = new AbortController().signal;
  let stepUps = 0,
    attempts = 0;
  const client = api(
    async (request) => {
      requests.push(request.clone());
      const url = new URL(request.url);
      if (request.method === "GET")
        return ok(
          url.pathname.endsWith("summary")
            ? {
                pending: 0,
                red_pending: 0,
                processed: 0,
                pendingAmountFen: "0",
                issuedThisMonth: { amountFen: "0", count: 0 },
              }
            : url.pathname.endsWith(invoiceId)
              ? row
              : { items: [], page: 2, pageSize: 10, total: 0 },
        );
      if (attempts++ === 0)
        return new Response(
          JSON.stringify({ code: 40301, error: "STEP_UP_REQUIRED", message: "PRIVATE" }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      return ok(row);
    },
    async () => {
      stepUps++;
      return true;
    },
  );
  await client.list(
    { tab: "red_pending", q: "虚构", medium: "paper", page: 2, pageSize: 10 },
    signal,
  );
  expect(Object.fromEntries(new URL(requests[0]!.url).searchParams)).toEqual({
    tab: "red_pending",
    q: "虚构",
    medium: "paper",
    page: "2",
    pageSize: "10",
  });
  expect(await client.summary({}, signal)).toMatchObject({ pendingAmountFen: "0" });
  expect(await client.get(invoiceId, signal)).toMatchObject({ lockVersion: 7 });
  const blue = {
    invoiceNo: "20400000000000004181",
    fileId,
    confirm: { requestNo: row.requestNo, amountFen: row.amountFen },
  };
  await client.write(invoiceId, { action: "issue", body: blue }, "same:issue", signal);
  await client.write(
    invoiceId,
    {
      action: "issue-red",
      body: {
        ...blue,
        redReason: "虚构红冲",
        confirm: { ...blue.confirm, blueInvoiceNo: "20400000000000004180" },
      },
    },
    "same:red",
    signal,
  );
  await client.write(
    invoiceId,
    { action: "reject", body: { reasonCode: "INVOICE", note: "资料核对不符" } },
    "same:reject",
    signal,
  );
  await client.write(invoiceId, { action: "resend" }, "same:resend", signal);
  const writes = requests.filter((request) => request.method === "POST");
  expect(writes.map((request) => new URL(request.url).pathname.split("/").at(-1))).toEqual([
    "issue",
    "issue",
    "issue-red",
    "reject",
    "resend",
  ]);
  expect(writes.map((request) => request.headers.get("Idempotency-Key"))).toEqual([
    "same:issue",
    "same:issue",
    "same:red",
    "same:reject",
    "same:resend",
  ]);
  expect(await writes[0]!.json()).toEqual(blue);
  expect(await writes[1]!.json()).toEqual(blue);
  expect(stepUps).toBe(1);
  expect(writes.at(-1)!.body).toBeNull();
});
it("响应id不符停止；409仅显示安全符号/尾号，不显示远端正文或邮箱", async () => {
  const signal = new AbortController().signal;
  await expect(
    api(async () => ok({ ...invoiceFixture(), invoiceRequestId: fileId })).get(invoiceId, signal),
  ).rejects.toMatchObject({ symbol: "RESPONSE_MISMATCH" });
  const client = api(
    async () =>
      new Response(
        JSON.stringify({
          code: 40901,
          error: "CONFIRM_MISMATCH",
          message: "PRIVATE-EMAIL@example.invalid",
          requestId: "FICTIONAL-12345678",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
  );
  const error = await client.get(invoiceId, signal).catch((failure: unknown) => failure);
  expect(invoiceNeedsReload(error)).toBe(true);
  expect(invoiceError(error)).toContain("12345678");
  expect(invoiceError(error)).not.toContain("PRIVATE");
  expect(invoiceError(error)).not.toContain("@");
});
