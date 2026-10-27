import { expect, it } from "vitest";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import { createRefundRequestApi, refundRequestError } from "./request-api";
import {
  canRequestRefund,
  createRefundRequestIntent,
  eligibleRefundRules,
  paymentRefundTarget,
  refundRequestBody,
  refundSnapshotStamp,
} from "./request-model";
import { requestAccess, requestFixtures, requestIds } from "./request-fixtures.test-support";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
it("只对真实已入账付款关联发起，规则/权限/实算金额与确认快照不由浏览器推算", () => {
  const { row, order, quote } = requestFixtures(),
    snapshot = { order, quote };
  expect(paymentRefundTarget({ ...row, paymentOrder: null })).toBeUndefined();
  expect(paymentRefundTarget({ ...row, entity: null })).toBeUndefined();
  expect(paymentRefundTarget({ ...row, isApplied: false })).toBeUndefined();
  expect(paymentRefundTarget(row)).toMatchObject({
    paymentOrderId: order.paymentOrderId,
    paymentTransactionId: row.paymentTransactionId,
  });
  expect(canRequestRefund({ ...requestAccess, actions: [] })).toBe(false);
  expect(eligibleRefundRules(quote, requestAccess)).toEqual(["window"]);
  expect(eligibleRefundRules({ ...quote, supported: false }, requestAccess)).toEqual([]);
  expect(eligibleRefundRules({ ...quote, refundableFen: 0 }, requestAccess)).toEqual([]);
  expect(
    eligibleRefundRules(
      {
        ...quote,
        openRequest: {
          refundRequestId: requestIds.refund,
          requestNo: "TK",
          status: "pending_approval",
        },
      },
      requestAccess,
    ),
  ).toEqual([]);
  expect(() =>
    refundRequestBody(snapshot, "override", "REASON", "", {
      ...requestAccess,
      actions: [...requestAccess.actions, "refund.override.request"],
    }),
  ).toThrow();
  const body = refundRequestBody(snapshot, "window", "REASON", " 虚构说明 ", requestAccess);
  expect(body).toEqual({
    ruleCode: "window",
    reasonCode: "REASON",
    note: "虚构说明",
    confirm: { orderNo: order.orderNo, amountFen: quote.refundableFen },
  });
  expect(body).not.toHaveProperty("lockVersion");
  expect(refundSnapshotStamp(snapshot)).not.toBe(
    refundSnapshotStamp({ order: { ...order, lockVersion: order.lockVersion + 1 }, quote }),
  );
  expect(refundSnapshotStamp(snapshot)).not.toBe(
    refundSnapshotStamp({
      order,
      quote: { ...quote, sideEffects: { ...quote.sideEffects, revokePoints: 1 } },
    }),
  );
});
it("同步闩拒双击、未知同正文原key；切scope取消后迟到响应不能发布", async () => {
  let keys = 0;
  const intent = createRefundRequestIntent(() => `same:${++keys}`),
    first = deferred<string>(),
    sent: string[] = [];
  const pending = intent.submit({ amount: 1 }, async (key) => {
    sent.push(key);
    return first.promise;
  });
  expect(await intent.submit({ amount: 1 }, async () => "unexpected")).toBeUndefined();
  first.resolve("accepted");
  expect(await pending).toBe("accepted");
  await expect(
    intent.submit({ amount: 2 }, async (key) => {
      sent.push(key);
      throw Error("unknown");
    }),
  ).rejects.toThrow("unknown");
  expect(
    await intent.submit({ amount: 2 }, async (key) => {
      sent.push(key);
      return "same";
    }),
  ).toBe("same");
  expect(sent).toEqual(["same:1", "same:2", "same:2"]);
  const late = deferred<string>();
  let signal: AbortSignal | undefined;
  const old = intent.submit({ amount: 3 }, async (_key, own) => {
    signal = own;
    return late.promise;
  });
  intent.close();
  expect(signal?.aborted).toBe(true);
  late.resolve("late");
  expect(await old).toBeUndefined();
});
it("真实中央客户端两typed POST/GET归属、stepup同key；错单响应/取消/私密远端错误不泄露", async () => {
  const fixtures = requestFixtures(),
    target = paymentRefundTarget(fixtures.row)!,
    writes: Request[] = [],
    all: Request[] = [];
  let attempts = 0,
    stepUps = 0;
  const handlers: ApiHandlers = {
    redirectToLogin() {},
    stepUp: async () => {
      stepUps++;
      return true;
    },
    refreshAccess() {},
    invalidateQueries() {},
    notify() {},
    showBlocked() {},
    buildMismatch() {},
  };
  const make = (fetch: (request: Request) => Promise<Response>) =>
    createRefundRequestApi({
      api: createAdminApi({
        baseUrl: "https://finance.example.test",
        build: "refund-request",
        handlers,
        fetch,
      }),
    });
  const ok = (data: unknown) =>
    new Response(JSON.stringify({ code: 0, data }), {
      headers: { "Content-Type": "application/json" },
    });
  const client = make(async (request) => {
    all.push(request.clone());
    const path = new URL(request.url).pathname;
    if (path.endsWith("refund-quote")) return ok(fixtures.quote);
    if (path.endsWith("refund-requests") && request.method === "POST") {
      writes.push(request.clone());
      if (attempts++ === 0)
        return new Response(JSON.stringify({ error: "STEP_UP_REQUIRED", message: "PRIVATE" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      return ok(fixtures.refund);
    }
    return ok(path.includes("refund-requests/") ? fixtures.refund : fixtures.order);
  });
  const signal = new AbortController().signal;
  expect(await client.snapshot(target, "window", signal)).toEqual({
    order: fixtures.order,
    quote: fixtures.quote,
  });
  const body = refundRequestBody(
    { order: fixtures.order, quote: fixtures.quote },
    "window",
    "REASON",
    "虚构",
    requestAccess,
  );
  await client.create(target, body, "refund:same", signal);
  await client.get(target, requestIds.refund, signal);
  const quote = all.find((request) => request.url.endsWith("refund-quote"))!;
  expect(quote.method).toBe("POST");
  expect(quote.headers.get("Idempotency-Key")).toBeTruthy();
  expect(quote.headers.get("Idempotency-Key")).not.toBe("refund:same");
  expect(await quote.json()).toEqual({ ruleCode: "window" });
  expect(writes.map((request) => request.headers.get("Idempotency-Key"))).toEqual([
    "refund:same",
    "refund:same",
  ]);
  expect(await writes[0]!.json()).toEqual(body);
  expect(await writes[1]!.json()).toEqual(body);
  expect(stepUps).toBe(1);
  await expect(
    make(async (request) =>
      ok(
        request.url.endsWith("refund-quote")
          ? fixtures.quote
          : { ...fixtures.order, paymentOrderId: requestIds.refund },
      ),
    ).snapshot(target, "window", signal),
  ).rejects.toMatchObject({ symbol: "RESPONSE_MISMATCH" });
  await expect(
    make(async () => ok({ ...fixtures.refund, paymentOrder: null })).get(
      target,
      requestIds.refund,
      signal,
    ),
  ).rejects.toMatchObject({ symbol: "RESPONSE_MISMATCH" });
  const denied = make(
    async () =>
      new Response(
        JSON.stringify({
          error: "PLAN_REFUND_NOT_ELIGIBLE",
          message: "PRIVATE-ACCOUNT@example.invalid",
          requestId: "FICTIONAL-12345678",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
  );
  const error = await denied.get(target, requestIds.refund, signal).catch((error) => error);
  expect(refundRequestError(error)).toContain("12345678");
  expect(refundRequestError(error)).not.toMatch(/PRIVATE|@/);
  const controller = new AbortController(),
    waiting = deferred<Response>(),
    entered = deferred<void>();
  let observed: AbortSignal | undefined;
  const pending = make(async (request) => {
    observed = request.signal;
    entered.resolve(undefined);
    return new Promise<Response>((resolve, reject) => {
      request.signal.addEventListener(
        "abort",
        () => reject(new DOMException("取消", "AbortError")),
        { once: true },
      );
      void waiting.promise.then(resolve, reject);
    });
  }).get(target, requestIds.refund, controller.signal);
  await entered.promise;
  controller.abort();
  expect(observed?.aborted).toBe(true);
  waiting.resolve(ok(fixtures.refund));
  await expect(pending).rejects.toThrow();
});
