import { expect, it, vi } from "vitest";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import {
  createOrderAftercareApi,
  aftercareError,
  cancelQuoteIdentity,
  orderCancelFingerprint,
  manualDeductReady,
  definiteAftercareRejection,
  OrderAftercareFailure,
} from "./aftercare-api";
import { createOrderIntent } from "./aftercare-intent";
import { cancelInput } from "./cancel-form";
import { cancelFixture, fixtureId as id, orderFixture, quoteFixture } from "./test-data.fixture";

const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, data }), {
    headers: { "Content-Type": "application/json" },
  });
export function orderTransport(reply: (request: Request) => Promise<Response> | Response) {
  const handlers: ApiHandlers = {
    redirectToLogin() {},
    stepUp: vi.fn(async () => true),
    refreshAccess() {},
    invalidateQueries() {},
    notify() {},
    showBlocked() {},
    buildMismatch() {},
  };
  return createOrderAftercareApi({
    api: createAdminApi({
      baseUrl: "https://order.example.test",
      build: "w513p2",
      handlers,
      fetch: async (request) => reply(request),
    }),
  });
}
it("取消用正式scope订单GET/试算和正式创建body；逐行expect来自真实quote，创建保原key", async () => {
  const requests: Request[] = [],
    order = orderFixture(),
    quote = quoteFixture(),
    signal = new AbortController().signal;
  const api = orderTransport((request) => {
    requests.push(request.clone());
    if (request.method === "GET") return ok(order);
    return ok(request.url.endsWith("/cancel-quote") ? quote : cancelFixture());
  });
  const input = { reasonCode: "merchant_request" as const, orderItemIds: [id(2)] };
  const seen = await api.quote(id(1), input, signal);
  await api.createCancel(
    id(1),
    { ...input, note: "商家提出取消申请", expect: seen.expect },
    seen,
    "order-original",
    signal,
  );
  const posts = requests.filter((request) => request.method === "POST");
  expect(posts.map((request) => new URL(request.url).pathname)).toEqual([
    "/api/v1/admin/orders/" + id(1) + "/cancel-quote",
    "/api/v1/admin/orders/" + id(1) + "/cancel-quote",
    "/api/v1/admin/orders/" + id(1) + "/cancel-requests",
  ]);
  expect(
    // The central client gives every non-GET its transport key; this read-only quote owns no write intent key.
    posts
      .slice(0, 2)
      .every((request) => request.headers.get("Idempotency-Key")?.startsWith("req:")),
  ).toBe(true);
  expect(await posts[1]!.json()).toEqual(input);
  expect(await posts[2]!.json()).toEqual({
    ...input,
    note: "商家提出取消申请",
    expect: { totalRefundPoints: 100 },
  });
  expect(posts[2]!.headers.get("Idempotency-Key")).toBe("order-original");
  expect(requests[0]!.method).toBe("GET");
});
it("输入范围/必填说明按owner schema；报价时间变化不影响事实身份，金额/阶段/去向变化与blockers零创建", async () => {
  expect(cancelInput({ reason: "merchant_request", itemIds: [], date: "", manual: {} })).toBeNull();
  expect(
    cancelInput({
      reason: "platform_fault",
      itemIds: [id(2)],
      date: "2030-11-02",
      manual: { [id(2)]: { points: 2, note: "" } },
    }),
  ).toBeNull();
  const seen = quoteFixture();
  expect(cancelQuoteIdentity({ ...seen, quotedAt: "2030-11-02T00:00:00.000Z" })).toBe(
    cancelQuoteIdentity(seen),
  );
  const input = {
    reasonCode: "merchant_request" as const,
    orderItemIds: [id(2)],
    note: "商家提出取消申请",
    expect: seen.expect,
  };
  let created = 0;
  const api = orderTransport((request) => {
    if (request.method === "GET") return ok(orderFixture());
    if (request.url.endsWith("/cancel-requests")) created++;
    return ok({ ...seen, blockers: [{ orderItemId: id(2), reason: "in_other_request" }] });
  });
  await expect(
    api.createCancel(id(1), input, seen, "key", new AbortController().signal),
  ).rejects.toMatchObject({ code: "PRECONDITION_CHANGED" });
  expect(created).toBe(0);
  const manual = {
    ...seen,
    needsManualDeduct: true,
    lines: seen.lines.map((line) => ({
      ...line,
      isManualDeduct: true,
      ratioBp: null,
      deductNote: "核对实际制作成本",
    })),
  };
  const manualInput = {
    ...input,
    manualDeducts: [{ orderItemId: id(2), deductPoints: 0, deductNote: "核对实际制作成本" }],
  };
  expect(manualDeductReady(manual, input)).toBe(false);
  expect(manualDeductReady(manual, manualInput)).toBe(true);
  const manualApi = orderTransport((request) => {
    if (request.method === "GET") return ok(orderFixture());
    if (request.url.endsWith("/cancel-requests")) {
      created++;
      return ok(cancelFixture());
    }
    return ok(manual);
  });
  await manualApi.createCancel(
    id(1),
    manualInput,
    manual,
    "manual-key",
    new AbortController().signal,
  );
  expect(created).toBe(1);
  const denied = orderTransport(
    () =>
      new Response(
        JSON.stringify({
          error: "PERMISSION_DENIED",
          message: "https://private.invalid/?signature=secret",
        }),
        { status: 403 },
      ),
  );
  const failure = await denied
    .quote(id(1), input, new AbortController().signal)
    .catch((error: unknown) => error);
  expect(aftercareError(failure)).not.toContain("private");
});
it("同意图同步闩/原key；已受理后GET失败只再GET；未知后当前申请变化停写，不假报提交成功", async () => {
  let reads = 0,
    writes = 0,
    failRead = false;
  const keys: string[] = [];
  const workspace = createOrderIntent(
    async () => {
      reads++;
      if (failRead) throw new Error("read failed");
      return orderFixture();
    },
    () => "same-key",
  );
  await expect(
    workspace.submit(
      "same-body",
      () => true,
      async (_fresh, key) => {
        writes++;
        keys.push(key);
        failRead = true;
      },
    ),
  ).rejects.toThrow("read failed");
  failRead = false;
  expect(await workspace.refresh()).toMatchObject({ orderId: id(1) });
  expect(
    await workspace.submit(
      "changed-body-after-accepted",
      () => true,
      async () => {
        writes++;
      },
    ),
  ).toMatchObject({ orderId: id(1) });
  expect({ reads, writes, keys }).toEqual({ reads: 4, writes: 1, keys: ["same-key"] });
  expect(workspace.identity()).toBe("same-body");
  expect(workspace.locked()).toBe(true);
  expect(workspace.canClose()).toBe(false);
  let sequence = 0;
  const unknown = createOrderIntent(
    async () => orderFixture(),
    () => `key-${++sequence}`,
  );
  const write = async (_fresh: unknown, key: string) => {
    keys.push(key);
    throw new Error("network unknown");
  };
  await expect(unknown.submit("input-a", () => true, write)).rejects.toThrow();
  await expect(unknown.submit("input-a", () => true, write)).rejects.toThrow();
  await expect(unknown.submit("input-b", () => true, write)).rejects.toThrow("原操作结果未确认");
  expect(keys.slice(1)).toEqual(["key-1", "key-1"]);
  expect(unknown.identity()).toBe("input-a");
  expect(unknown.canClose()).toBe(false);
  const before = keys.length;
  expect(await unknown.submit("input-a", () => false, write)).toMatchObject({ orderId: id(1) });
  expect(keys).toHaveLength(before);
  let definiteKeys = 0;
  const definite = createOrderIntent(
    async () => orderFixture(),
    () => `known-${++definiteKeys}`,
    definiteAftercareRejection,
  );
  await expect(
    definite.submit(
      "first",
      () => true,
      async () => {
        throw new OrderAftercareFailure("VALIDATION_FAILED", 400);
      },
    ),
  ).rejects.toThrow();
  expect(definite.canClose()).toBe(true);
  await expect(
    definite.submit(
      "changed-after-rejection",
      () => true,
      async () => {
        throw new OrderAftercareFailure("IDEMPOTENCY_IN_PROGRESS", 409);
      },
    ),
  ).rejects.toThrow();
  expect(definiteKeys).toBe(2);
  expect(definite.canClose()).toBe(false);
  await expect(
    definite.submit(
      "must-stay-locked",
      () => true,
      async () => {},
    ),
  ).rejects.toThrow("原操作结果未确认");
  expect(definiteKeys).toBe(2);
  expect(definiteAftercareRejection(new OrderAftercareFailure("BUSY", 409))).toBe(false);
  expect(definiteAftercareRejection(new OrderAftercareFailure("VALIDATION_FAILED", 500))).toBe(
    false,
  );
  expect(orderCancelFingerprint(orderFixture())).toBe("[]");
});
it("真实deferred屏障覆盖并发双击、scope关闭abort及迟到结果丢弃；活动/逐item下载消费正式公口", async () => {
  let release!: () => void,
    signal: AbortSignal | undefined,
    wrote = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const intent = createOrderIntent(async (own) => {
    signal = own;
    await gate;
    return orderFixture();
  });
  const pending = intent.submit(
    "same",
    () => true,
    async () => {
      wrote++;
    },
  );
  expect(
    await intent.submit(
      "same",
      () => true,
      async () => {
        wrote++;
      },
    ),
  ).toBeNull();
  expect(intent.canClose()).toBe(false);
  intent.close();
  release();
  expect(await pending).toBeNull();
  expect(signal?.aborted).toBe(true);
  expect(wrote).toBe(0);
  const paths: string[] = [];
  const api = orderTransport((request) => {
    paths.push(new URL(request.url).pathname);
    return ok(
      request.url.includes("/activities")
        ? { items: [], nextCursor: null, hasMore: false, totalApprox: 0 }
        : request.url.includes("/downloads")
          ? { releases: [], grants: [], logs: { items: [], page: 1, pageSize: 20, total: 0 } }
          : orderFixture(),
    );
  });
  const own = new AbortController().signal;
  await api.activity(id(1), own);
  await api.downloads(id(1), id(2), own);
  expect(paths).toContain(`/api/v1/admin/orders/${id(1)}/activities`);
  expect(paths).toContain(`/api/v1/admin/order-items/${id(2)}/downloads`);
  await expect(api.downloads(id(1), id(99), own)).rejects.toMatchObject({
    code: "RESPONSE_MISMATCH",
  });
});
