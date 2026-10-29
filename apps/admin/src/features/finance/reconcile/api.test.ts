import { expect, it } from "vitest";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import { createReconcileApi, reconConflict, reconError } from "./api";
import { day, detail, id, month, orderId } from "./fixtures.test-support";
import { resolveBody } from "./model";
const handlers: ApiHandlers = {
  redirectToLogin() {},
  stepUp: async () => false,
  refreshAccess() {},
  invalidateQueries() {},
  notify() {},
  showBlocked() {},
  buildMismatch() {},
};
const transport = (fetch: (request: Request) => Promise<Response>) =>
  createReconcileApi({
    api: createAdminApi({
      baseUrl: "https://reconcile.example.test",
      build: "w418",
      handlers,
      fetch,
    }),
  });
const reply = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, data }), {
    headers: { "Content-Type": "application/json" },
  });
it("月度空值与零不混淆、差异真实分页及逗号筛选；错月/错ID响应拒绝发布", async () => {
  const seen: URL[] = [],
    signal = new AbortController().signal;
  const api = transport(async (request) => {
    const url = new URL(request.url);
    seen.push(url);
    return reply(
      url.pathname.endsWith("reconciliations")
        ? month()
        : url.pathname.endsWith("payment-exceptions")
          ? { items: [detail()], page: 3, pageSize: 10, total: 28 }
          : detail(),
    );
  });
  const value = await api.month("2030-10", signal);
  expect(value.items[0]).toMatchObject({
    platformPay: { count: 0, amountFen: "0" },
    billPay: null,
    diff: null,
  });
  expect(
    (
      await api.list(
        { tab: "all", kind: ["bank_unmatched", "bill_only"], page: 3, pageSize: 10 },
        signal,
      )
    ).total,
  ).toBe(28);
  expect(seen[1]?.searchParams.get("kind")).toBe("bank_unmatched,bill_only");
  expect(seen[1]?.searchParams.get("page")).toBe("3");
  expect((await api.detail(id, signal)).lockVersion).toBe(7);
  await expect(api.detail(orderId, signal)).rejects.toMatchObject({ symbol: "RESPONSE_MISMATCH" });
  await expect(api.month("2030-09", signal)).rejects.toMatchObject({ symbol: "RESPONSE_MISMATCH" });
});
it("三写走真实typed正文与原key；rerun只确认账单日，409安全投影且保留实际outcome", async () => {
  const seen: { path: string; key: string | null; body: unknown }[] = [],
    signal = new AbortController().signal;
  const api = transport(async (request) => {
    const path = new URL(request.url).pathname;
    seen.push({ path, key: request.headers.get("Idempotency-Key"), body: await request.json() });
    return reply(
      path.endsWith("rerun")
        ? day()
        : path.endsWith("resolve")
          ? { ...detail(), status: "resolving", outcome: "refund_requested" }
          : detail(),
    );
  });
  const create = {
      receivedAt: "2030-10-18T04:00:00.000Z",
      amountFen: 101,
      payerName: "虚构付款人",
      bankSerialNo: "FICTIONAL-1",
      note: "虚构登记",
      confirm: { amountFen: 101, bankSerialNo: "FICTIONAL-1" },
    },
    body = resolveBody(detail(), "link_order", "核对候选付款单", { linkPaymentOrderId: orderId });
  await api.rerun(day(), "fixture-rerun", signal);
  await api.create(create, "fixture-create", signal);
  expect((await api.resolve(detail(), body, "fixture-resolve", signal)).outcome).toBe(
    "refund_requested",
  );
  expect(seen).toEqual([
    {
      path: `/api/v1/admin/reconciliations/${id}/rerun`,
      key: "fixture-rerun",
      body: { confirm: { billDate: "2030-10-18" } },
    },
    { path: "/api/v1/admin/payment-exceptions", key: "fixture-create", body: create },
    { path: `/api/v1/admin/payment-exceptions/${id}/resolve`, key: "fixture-resolve", body },
  ]);
  const denied = transport(
    async () =>
      new Response(
        JSON.stringify({
          code: 40901,
          error: "VERSION_CONFLICT",
          message: "PRIVATE-ACCOUNT",
          requestId: "fixture-12345678",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
  );
  const error = await denied
    .resolve(detail(), body, "same-intent", signal)
    .catch((error: unknown) => error);
  expect(reconConflict(error)).toBe(true);
  expect(reconError(error)).toContain("12345678");
  expect(reconError(error)).not.toContain("PRIVATE");
  const duplicate = transport(
    async () =>
      new Response(
        JSON.stringify({
          code: 40902,
          error: "BANK_SERIAL_DUPLICATE",
          message: "PRIVATE-ACCOUNT",
          details: { conflicts: [{ ref: "EX-FIXTURE-OTHER", payerBank: null }] },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
  );
  await expect(duplicate.create(create, "fixture-duplicate", signal)).rejects.toMatchObject({
    conflicts: [{ ref: "EX-FIXTURE-OTHER", payerBank: null }],
  });
  const unavailable = transport(
    async () =>
      new Response(
        JSON.stringify({ code: 50301, error: "PROVIDER_UNAVAILABLE", message: "PRIVATE-PROVIDER" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
  );
  const missing = await unavailable
    .rerun(day(), "fixture-missing", signal)
    .catch((error: unknown) => error);
  expect(reconError(missing)).toContain("渠道暂不可查询");
  expect(reconError(missing)).not.toContain("PRIVATE");
});
