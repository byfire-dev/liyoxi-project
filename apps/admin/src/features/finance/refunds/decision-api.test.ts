import { expect, it } from "vitest";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import {
  createRefundDecisionsApi,
  refundDecisionError,
  refundNeedsReconfirm,
} from "./decision-api";
import type { RefundDecisionInput } from "./decision-model";
const id = "0199e187-e72a-7000-8000-000000000001",
  other = "0199e187-e72a-7000-8000-000000000002";
const input: RefundDecisionInput = {
  refundRequestId: other,
  source: "exception",
  requestNo: "TK-FICTIONAL",
  amountFen: 100,
  approval: { approvalId: id, kind: "plan_refund", lockVersion: 8 },
};
function transport(fetch: (request: Request) => Promise<Response>) {
  const handlers: ApiHandlers = {
    redirectToLogin() {},
    stepUp: async () => false,
    refreshAccess() {},
    invalidateQueries() {},
    notify() {},
    showBlocked() {},
    buildMismatch() {},
  };
  return createRefundDecisionsApi({
    api: createAdminApi({
      baseUrl: "https://finance.example.test",
      build: "w418",
      handlers,
      fetch,
    }),
  });
}
it("四typed写口携带真实退款ID、原key及正式body；409保安全符号，不自动换键或假成功", async () => {
  const requests: { path: string; key: string | null; body: unknown }[] = [],
    signal = new AbortController().signal;
  const api = transport(async (request) => {
    requests.push({
      path: new URL(request.url).pathname,
      key: request.headers.get("Idempotency-Key"),
      body: await request.json(),
    });
    return new Response(
      JSON.stringify({
        code: 40901,
        error: "VERSION_CONFLICT",
        message: "PRIVATE-RESPONSE",
        requestId: "FICTIONAL-12345678",
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  });
  for (const action of ["approve", "reject", "withdraw", "void"] as const) {
    const error = await api
      .decide(input, action, "核对后处理", `fixture-${action}`, signal)
      .catch((failure: unknown) => failure);
    expect(refundNeedsReconfirm(error)).toBe(true);
    expect(refundDecisionError(error)).toContain("12345678");
    expect(refundDecisionError(error)).not.toContain("PRIVATE");
  }
  expect(requests).toEqual([
    {
      path: `/api/v1/admin/refund-requests/${other}/approve`,
      key: "fixture-approve",
      body: {
        lockVersion: 8,
        note: "核对后处理",
        confirm: { requestNo: "TK-FICTIONAL", amountFen: 100 },
        confirmChecks: ["rule_amount_checked"],
      },
    },
    {
      path: `/api/v1/admin/refund-requests/${other}/reject`,
      key: "fixture-reject",
      body: { note: "核对后处理" },
    },
    {
      path: `/api/v1/admin/refund-requests/${other}/withdraw`,
      key: "fixture-withdraw",
      body: { note: "核对后处理" },
    },
    {
      path: `/api/v1/admin/refund-requests/${other}/void`,
      key: "fixture-void",
      body: { note: "核对后处理", confirm: { requestNo: "TK-FICTIONAL", amountFen: 100 } },
    },
  ]);
  await expect(
    api.decide({ ...input, source: "staging_probe" }, "approve", "", "fixture-system", signal),
  ).rejects.toMatchObject({ symbol: "PERMISSION_DENIED" });
  expect(requests).toHaveLength(4);
});
it("卸载scope的取消传入真实fetch，拒绝在途写且不返回空成功", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((done) => {
    entered = done;
  });
  let actual: AbortSignal | undefined;
  const api = transport(
    (request) =>
      new Promise<Response>((_done, reject) => {
        actual = request.signal;
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
        entered();
      }),
  );
  const controller = new AbortController(),
    writing = api.decide(input, "withdraw", "", "fixture-cancel", controller.signal),
    stopped = expect(writing).rejects.toMatchObject({ name: "AbortError" });
  await ready;
  controller.abort();
  expect(actual?.aborted).toBe(true);
  await stopped;
});
