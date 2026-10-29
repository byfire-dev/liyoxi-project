import { expect, it } from "vitest";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import { configConflict, configError, createConfigApi } from "./api";
import { bank, id } from "./fixtures.test-support";
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
  createConfigApi({
    api: createAdminApi({
      baseUrl: "https://finance.example.test",
      build: "w418",
      handlers,
      fetch,
    }),
  });
const reply = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, data }), {
    headers: { "Content-Type": "application/json" },
  });
it("current/history分支保留真实分页；详情精确ID查询且拒绝错关联，零金额和空阈值不混淆", async () => {
  const seen: URL[] = [],
    signal = new AbortController().signal;
  const api = transport(async (request) => {
    const url = new URL(request.url);
    seen.push(url);
    return reply(
      url.searchParams.get("tab") === "history"
        ? {
            items: [bank()],
            page: 2,
            pageSize: 20,
            total: url.searchParams.has("financeConfigRevisionId") ? 1 : 29,
          }
        : {
            items: [
              {
                ...bank(),
                configKey: "controls",
                payload: {
                  adminCreateOrder: false,
                  shippingReport: false,
                  wechatSingleLimitFen: 0,
                  wechatDailyLimitFen: 100,
                  receiptSecondReviewFen: null,
                },
              },
            ],
          },
    );
  });
  expect((await api.list({ tab: "history", page: 2, pageSize: 20 }, signal)).total).toBe(29);
  expect((await api.list({ tab: "current" }, signal)).items[0]?.payload).toMatchObject({
    wechatSingleLimitFen: 0,
    receiptSecondReviewFen: null,
  });
  expect((await api.get(id, signal)).financeConfigRevisionId).toBe(id);
  expect(seen[2]?.searchParams.get("financeConfigRevisionId")).toBe(id);
  await expect(api.get("0199e187-e72a-7000-8000-000000000009", signal)).rejects.toMatchObject({
    symbol: "RESPONSE_MISMATCH",
  });
});
it("提议及三决定严格typed body/原key；银行尾四位与版本回传，409只显示安全错误", async () => {
  const seen: { path: string; key: string | null; body: unknown }[] = [],
    signal = new AbortController().signal;
  const api = transport(async (request) => {
    seen.push({
      path: new URL(request.url).pathname,
      key: request.headers.get("Idempotency-Key"),
      body: await request.json(),
    });
    return new Response(
      JSON.stringify({
        code: 40901,
        error: "VERSION_CONFLICT",
        message: "PRIVATE-BANK-DETAIL",
        requestId: "fixture-12345678",
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  });
  const proposed = {
    configKey: "bank_account" as const,
    payload: { accountName: "虚构测试账户", bankName: "虚构银行", accountNo: "6222000012344321" },
    changeNote: "虚构提议",
    confirm: { configKey: "bank_account" as const, baseRevisionId: null },
  };
  await expect(api.create(proposed, "fixture-create", signal)).rejects.toMatchObject({
    status: 409,
  });
  for (const action of ["approve", "reject", "withdraw"] as const) {
    const error = await api
      .decide(bank(), action, "核对后处理", "4321", `fixture-${action}`, signal)
      .catch((error: unknown) => error);
    expect(configConflict(error)).toBe(true);
    expect(configError(error)).toContain("12345678");
    expect(configError(error)).not.toContain("PRIVATE");
  }
  expect(seen).toEqual([
    { path: "/api/v1/admin/finance-config-revisions", key: "fixture-create", body: proposed },
    {
      path: `/api/v1/admin/finance-config-revisions/${id}/approve`,
      key: "fixture-approve",
      body: {
        lockVersion: 7,
        confirmChecks: ["change_reviewed"],
        confirm: { configKey: "bank_account", financeConfigRevisionId: id, accountNoLast4: "4321" },
        note: "核对后处理",
      },
    },
    {
      path: `/api/v1/admin/finance-config-revisions/${id}/reject`,
      key: "fixture-reject",
      body: { note: "核对后处理" },
    },
    {
      path: `/api/v1/admin/finance-config-revisions/${id}/withdraw`,
      key: "fixture-withdraw",
      body: { note: "核对后处理" },
    },
  ]);
});
