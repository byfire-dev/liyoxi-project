import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { allRoutes } from "@liyoxi/contract";
import {
  assertMixedSource,
  MIXED_MAX_MESSAGE,
  MIXED_PROTOCOL,
  mixedDiagnostics,
  MixedAccess,
  serveMixedRpc,
} from "./mixed-http-driver.protocol.js";
import {
  mixedReadOperations,
  mixedReadPlan,
  replayMixedReadSpec,
  readMixedGets,
} from "./mixed-openapi-reader.js";
import { prepareMixedPortalReads } from "./mixed-portal-reader.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const input = async function* (chunks: readonly Uint8Array[]) {
  yield* chunks;
};
const source = "a".repeat(40);

it("私有RPC有界串行、固定身份与错误，截断/未知/重放ID均不执行后继", async () => {
  const calls: number[] = [],
    outputs: string[] = [];
  const request = (id: number, method = "owner.init") => ({
    protocol: MIXED_PROTOCOL,
    id,
    method,
    params: {},
  });
  const combined = Buffer.concat([
    encode(request(1)),
    encode(request(2, "owner.close")),
    encode(request(3)),
  ]);
  await serveMixedRpc(
    input([combined.subarray(0, 7), combined.subarray(7)]),
    async (line) => {
      outputs.push(line);
    },
    async (value) => {
      calls.push(value.id);
      return { source: assertMixedSource(source, source) };
    },
  );
  expect(calls).toEqual([1, 2]);
  expect(outputs.map((line) => JSON.parse(line).ok)).toEqual([true, true]);
  expect(() => assertMixedSource("b".repeat(40), source)).toThrow();
  expect(() => assertMixedSource("short", source)).toThrow();
  for (const chunks of [
    [encode({ ...request(1), method: "owner.sql" })],
    [encode(request(1)).subarray(0, 10)],
    [],
    [Buffer.alloc(MIXED_MAX_MESSAGE + 1, 65)],
    [Buffer.concat([encode(request(1)), encode(request(1)), encode(request(2))])],
  ]) {
    const seen: number[] = [],
      lines: string[] = [];
    await expect(
      serveMixedRpc(
        input(chunks),
        async (line) => {
          lines.push(line);
        },
        async (value) => {
          seen.push(value.id);
          return {};
        },
      ),
    ).rejects.toThrow();
    expect(seen.length).toBeLessThanOrEqual(1);
    expect(lines.every((line) => !line.includes("owner.sql"))).toBe(true);
  }
  const lines: string[] = [];
  await expect(
    serveMixedRpc(
      input([encode(request(1))]),
      async (line) => {
        lines.push(line);
      },
      async () => {
        throw new Error("synthetic-secret-never-exposed");
      },
    ),
  ).rejects.toThrow();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('"errorCode":"invalid_request"');
  expect(lines[0]).not.toContain("synthetic-secret");
  await expect(
    serveMixedRpc(
      input([encode(request(1))]),
      async (line) => {
        lines.push(line);
      },
      async () => ({ tooLarge: "x".repeat(MIXED_MAX_MESSAGE) }),
    ),
  ).rejects.toThrow();
  expect(lines).toHaveLength(1);
});

it("本版旧OpenAPI全无参GET、合法组合query与实际详情全部规划，未知能力不静默省略", async () => {
  const documents = await Promise.all(
    ["merchant", "admin", "portal"].map(
      async (surface) =>
        JSON.parse(
          await readFile(
            new URL(
              "../../../../packages/contract/generated/" + surface + ".openapi.json",
              import.meta.url,
            ),
            "utf8",
          ),
        ) as unknown,
    ),
  );
  const operations = mixedReadOperations(documents);
  const id = "019a0000-0000-7000-8000-000000000001";
  const access = MixedAccess.parse({
    admin: {
      staffId: id,
      phone: "19900000101",
      password: "Public-fixture-A1!",
      secret: "A".repeat(32),
      recoveryCodes: [],
    },
    chainId: "roundone",
    ids: {
      entityId: id,
      storeId: id,
      merchantUserId: id,
      orderId: id,
      orderItemId: id,
      deliveryTicketId: id,
      sampleId: id,
    },
  });
  const options = {
    access,
    token: "A".repeat(43),
    portalTicketCode: "1234ABCD",
    licenseVerificationCode: "0123456789ABCDEF",
    year: 2026,
    month: 11,
    observedReads: ["/api/v1/admin/staff/" + id],
  };
  const plan = mixedReadPlan(operations, options);
  expect(plan.operations.map((row) => row.operationId).sort()).toEqual(
    operations
      .filter((row) => !row.path.includes("{"))
      .map((row) => row.operationId)
      .sort(),
  );
  expect(plan.operations.filter((row) => row.path.includes("?"))).toHaveLength(14);
  for (const row of plan.operations) {
    const route = allRoutes.find((one) => one.operationId === row.operationId);
    expect(route, row.operationId).toBeDefined();
    const query = route?.request?.query;
    if (query)
      expect(
        query.safeParse(Object.fromEntries(new URL(row.path, "http://api.localhost").searchParams))
          .success,
        row.operationId,
      ).toBe(true);
  }
  expect(plan.operations.find((row) => row.operationId === "admin.followUp.list")?.path).toContain(
    "entityId=" + id,
  );
  expect(
    plan.operations.find((row) => row.operationId === "admin.storeAsset.list")?.path,
  ).toContain("storeId=" + id);
  expect(
    plan.operations.find((row) => row.operationId === "admin.assetDemand.list")?.path,
  ).toContain("storeId=" + id);
  expect(
    plan.operations.find((row) => row.operationId === "admin.productionRecord.list")?.path,
  ).toBe("/api/v1/admin/production-records?orderItemId=" + id);
  expect(
    allRoutes
      .find((row) => row.operationId === "admin.productionRecord.list")
      ?.request?.query?.safeParse({}).success,
  ).toBe(false);
  expect(plan.operations.find((row) => row.operationId === "m.drama.search")?.path).toContain(
    "q=" + encodeURIComponent("修车"),
  );
  expect(plan.operations.find((row) => row.operationId === "m.portalTicket.lookup")?.path).toBe(
    "/api/v1/m/portal-tickets/lookup?code=1234ABCD",
  );
  expect(() => mixedReadPlan(operations, { ...options, portalTicketCode: "" })).toThrow();
  expect(
    plan.operations.find((row) => row.operationId === "portal.licenseVerification.get")?.path,
  ).toBe("/api/v1/portal/license-verifications?code=0123456789ABCDEF");
  expect(() => mixedReadPlan(operations, { ...options, licenseVerificationCode: "" })).toThrow();
  expect(
    plan.operations.find((row) => row.operationId === "admin.subscriptionTerm.list")?.path,
  ).toBe("/api/v1/admin/subscription-terms?tab=expiring");
  expect(plan.operations.find((row) => row.operationId === "admin.reconciliation.list")?.path).toBe(
    "/api/v1/admin/reconciliations?month=2026-01",
  );
  expect(plan.operations.find((row) => row.operationId === "admin.launchCalendar.get")?.path).toBe(
    "/api/v1/admin/launch-calendar?month=2026-11",
  );
  expect(
    allRoutes
      .find((row) => row.operationId === "admin.launchCalendar.get")
      ?.request?.query?.safeParse({}).success,
  ).toBe(false);
  expect(
    plan.details.some((row) => row.operationId === "admin.deliveryTicket.episodeOutput.list"),
  ).toBe(true);
  expect(plan.details.some((row) => row.operationId === "admin.staff.get")).toBe(true);
  for (const [operationId, suffix] of [
    ["portal.orderItem.release.get", "release"],
    ["portal.orderItem.publishList.get", "publish-list"],
  ])
    expect(plan.details.find((row) => row.operationId === operationId)?.path).toBe(
      `/api/v1/portal/order-items/${id}/${suffix}`,
    );
  const beforeContent = operations.filter(
    (row) =>
      ![
        "portal.licenseVerification.get",
        "portal.orderItem.release.get",
        "portal.orderItem.publishList.get",
      ].includes(row.operationId),
  );
  expect(
    mixedReadPlan(beforeContent, { ...options, licenseVerificationCode: "" }).details.some((row) =>
      row.operationId.startsWith("portal.orderItem."),
    ),
  ).toBe(false);
  expect(() =>
    mixedReadPlan(
      [
        ...operations,
        {
          operationId: "admin.new.required",
          path: "/api/v1/admin/new",
          required: ["unprovided"],
        },
      ],
      options,
    ),
  ).toThrow();
  expect(() =>
    mixedReadPlan(
      [...operations, { operationId: "m.new.lookup", path: "/api/v1/m/new", required: ["code"] }],
      options,
    ),
  ).toThrow(); // A known input name does not confer support on an unknown operation.
  expect(() =>
    mixedReadPlan(operations, {
      ...options,
      observedReads: ["/api/v1/admin/not-a-real-object/" + id],
    }),
  ).toThrow();
  expect(() =>
    mixedReadPlan(operations, {
      ...options,
      observedReads: ["https://outside.invalid/api/v1/admin/staff/" + id],
    }),
  ).toThrow();
  expect(() =>
    mixedReadOperations([{ paths: { "/outside": { get: { operationId: "bad" } } } }]),
  ).toThrow();
  const oldSource = "b".repeat(40);
  const oldOnly = { operationId: "admin.old.only", path: "/api/v1/admin/old-only", required: [] };
  const replay = replayMixedReadSpec(source, oldSource, {
    source: oldSource,
    operations: [...operations, oldOnly],
  });
  for (const capability of [
    options.token,
    options.portalTicketCode,
    options.licenseVerificationCode,
  ])
    expect(JSON.stringify(replay)).not.toContain(capability);
  expect(
    mixedReadPlan(replay.operations, options).operations.some(
      (row) => row.operationId === oldOnly.operationId,
    ),
  ).toBe(true); // HEAD's current document does not contain this old GET.
  expect(() => replayMixedReadSpec(source, source, replay)).toThrow();
  expect(() => replayMixedReadSpec(source, "c".repeat(40), replay)).toThrow();
  expect(() =>
    replayMixedReadSpec(source, oldSource, {
      ...replay,
      operations: [{ ...oldOnly, method: "post" }],
    }),
  ).toThrow();
  const failureOutput: string[] = [];
  await expect(
    serveMixedRpc(
      input([
        encode({
          protocol: MIXED_PROTOCOL,
          id: 1,
          method: "phase.read",
          params: {},
        }),
      ]),
      async (line) => {
        failureOutput.push(line);
      },
      async () =>
        readMixedGets(
          {
            request: async () => {
              throw new Error("synthetic-private-url-secret-500");
            },
          },
          [oldOnly],
          {},
          {},
          new AbortController().signal,
        ),
    ),
  ).rejects.toThrow();
  expect(JSON.parse(failureOutput[0]!)).toEqual({
    protocol: MIXED_PROTOCOL,
    id: 1,
    ok: false,
    errorCode: "read_failed",
    operationId: oldOnly.operationId,
  });
  expect(failureOutput[0]).not.toContain("synthetic-private");
  expect(failureOutput[0]).not.toContain("status");
  const oldPortal = await prepareMixedPortalReads(
    {
      request: async () => {
        throw new Error("old spec must not create a portal capability");
      },
    },
    {
      operationIds: [oldOnly.operationId],
      merchantHeaders: {},
      signal: new AbortController().signal,
    },
  );
  expect(oldPortal.headers).toEqual({});
  expect(oldPortal.lookupCode).toBe("");
  expect(oldPortal.licenseVerificationCode).toBe("");
  await oldPortal.close();
});

it("验真准备只读本链已出件授权预览，缺出件/跨scope/坏地址均失败且不泄露能力", async () => {
  const id = "019a0000-0000-7000-8000-000000000001";
  const other = "019a0000-0000-7000-8000-000000000002";
  const at = "2026-11-04T00:00:00.000Z";
  const code = "0123456789ABCDEF";
  const origin = "https://portal.example.invalid";
  // Transport-only DTOs. Real issued/PDF evidence remains the existing M1 writer/drain chain.
  const card = {
    licenseLetterId: id,
    letterNo: "MIXED-TEST",
    orderId: id,
    orderNo: "MIXED-ORDER",
    orderItemId: id,
    storeId: id,
    dramaTitle: "混版读取测试",
    episodeCount: 20,
    platform: "douyin",
    accountName: "测试账号",
    status: "effective",
    displayStatus: "effective",
    periodStartDate: "2026-11-04",
    periodEndDate: "2026-12-04",
    createdAt: at,
    currentRevNo: 1,
    issuedAt: at,
    isRendering: false,
    voidReason: null,
    voidedAt: null,
    canDownload: true,
    renderIssue: null,
  };
  const preview = {
    licensorName: "测试授权方",
    licensorCreditCodeMask: "test-mask",
    licenseeName: "测试商家",
    licenseeCreditCodeMask: "test-mask",
    storeName: "测试门店",
    dramaName: card.dramaTitle,
    episodes: 20,
    permits: [],
    account: { platform: "douyin", name: "测试账号", accountId: "test-account" },
    period: {
      startDate: card.periodStartDate,
      startText: card.periodStartDate,
      endDate: card.periodEndDate,
      territory: "测试范围",
    },
    clauses: [],
    consent: { consentNo: "1", agreementName: "测试协议", consentedAt: at, operatorMask: "测*" },
    revNo: 1,
    issuedAt: at,
    verifyUrl: `${origin}/v?code=${code}&rev=1`,
    contentFp: "a".repeat(64),
    signMode: "platform_cert",
  };
  const cases = ["ready", "pending", "foreign", "bad-url", "missing", "bad-cursor"] as const;
  for (const scenario of cases) {
    const requests: string[] = [];
    const prepare = prepareMixedPortalReads(
      {
        request: async (path, init) => {
          requests.push(path);
          expect(init?.method ?? "GET").toBe("GET");
          expect(init?.headers).toEqual({ authorization: "Bearer private-merchant-test" });
          if (path.startsWith("/api/v1/m/license-letters?")) {
            const query = new URL(path, "http://api.localhost").searchParams;
            expect(query.get("orderId")).toBe(id);
            expect(query.get("storeId")).toBe(id);
            const row =
              scenario === "pending" ? { ...card, issuedAt: null, currentRevNo: null } : card;
            return Response.json({
              data: {
                items: scenario === "bad-cursor" ? [] : [row],
                hasMore: scenario === "bad-cursor",
                nextCursor: scenario === "bad-cursor" ? "repeated-cursor" : null,
              },
            });
          }
          expect(path).toBe("/api/v1/m/license-letters/" + id);
          if (scenario === "missing") return Response.json({ error: "NOT_FOUND" }, { status: 404 });
          return Response.json({
            data: {
              ...card,
              ...(scenario === "foreign" ? { orderItemId: other } : {}),
              preview:
                scenario === "bad-url"
                  ? { ...preview, verifyUrl: `${origin}/v?code=${code}&rev=2` }
                  : preview,
              revisions: [{ revNo: 1, reason: "initial", issuedAt: at }],
            },
          });
        },
      },
      {
        operationIds: ["portal.licenseVerification.get"],
        merchantHeaders: { authorization: "Bearer private-merchant-test" },
        licenseScope: { orderId: id, orderItemId: id, storeId: id },
        origin,
        signal: new AbortController().signal,
      },
    );
    if (scenario === "ready") {
      const prepared = await prepare;
      expect(prepared.licenseVerificationCode).toBe(code);
      expect(prepared.headers).toEqual({});
      expect(prepared.lookupCode).toBe("");
      await prepared.close();
      expect(requests).toHaveLength(2);
    } else {
      const failure: unknown = await prepare.catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "read_failed", message: "Mixed driver failed" });
      expect(String(failure)).not.toContain(code);
      expect(JSON.stringify(failure)).not.toContain(preview.verifyUrl);
      expect(requests.length).toBeLessThanOrEqual(2);
    }
  }
});

it("受保护portal GET自身要求真实票据会话准备，旧spec不含current也不能省略", async () => {
  const id = "019a0000-0000-7000-8000-000000000001";
  const at = "2026-11-04T00:00:00.000Z";
  const origin = "https://portal.example.invalid";
  const secret = "a".repeat(43);
  const cookie = "__Host-lyx_portal=" + "b".repeat(43);
  for (const operationId of [
    "portal.orderItem.list",
    "portal.orderItem.release.get",
    "portal.orderItem.publishList.get",
    "portal.ad.list",
    "portal.ad.get",
  ]) {
    const requests: string[] = [];
    const prepared = await prepareMixedPortalReads(
      {
        request: async (path, init) => {
          requests.push(`${init?.method} ${path}`);
          if (path === "/api/v1/portal/portal-tickets")
            return Response.json({
              data: {
                portalTicketId: id,
                qrUrl: `${origin}/scan`,
                shortCode: "1234ABCD",
                pairDigits: "12",
                pollSecret: secret,
                expiresAt: at,
                pollIntervalMs: 2000,
              },
            });
          if (path.endsWith("/approve")) {
            expect(init?.headers?.authorization).toBe("Bearer private-merchant-test");
            expect(init?.json).toEqual({ pairDigits: "12" });
            return Response.json({
              data: {
                portalTicketId: id,
                status: "approved",
                rejectReason: null,
                approvedAt: at,
                storeId: id,
              },
            });
          }
          if (path.endsWith("/exchange")) {
            expect(init?.json).toEqual({ pollSecret: secret });
            expect(init?.headers?.authorization).toBeUndefined();
            return Response.json(
              {
                data: {
                  status: "consumed",
                  rejectReason: null,
                  session: {
                    portalSessionId: id,
                    storeId: id,
                    storeName: "测试门店",
                    isStoreArchived: false,
                    entityId: id,
                    entityName: "测试主体",
                    authorizerPhoneMask: null,
                    grantScope: "store",
                    capabilities: ["delivery.download", "ad.view"],
                    authorizedAt: at,
                    expiresAt: at,
                    serverTime: at,
                  },
                },
              },
              { headers: { "set-cookie": cookie + "; Secure; Path=/; HttpOnly" } },
            );
          }
          expect(path).toBe("/api/v1/portal/sessions/current");
          expect(init?.method).toBe("DELETE");
          expect(init?.headers?.Cookie).toBe(cookie);
          expect(init?.headers?.authorization).toBeUndefined();
          return Response.json({ data: null });
        },
      },
      {
        operationIds: [operationId],
        merchantHeaders: { authorization: "Bearer private-merchant-test" },
        origin,
        signal: new AbortController().signal,
      },
    );
    expect(prepared.headers).toEqual({ Origin: origin, "X-LYX-Portal": "1", Cookie: cookie });
    expect(prepared.licenseVerificationCode).toBe("");
    await prepared.close();
    expect(requests).toEqual([
      "POST /api/v1/portal/portal-tickets",
      `POST /api/v1/m/portal-tickets/${id}/approve`,
      `POST /api/v1/portal/portal-tickets/${id}/exchange`,
      "DELETE /api/v1/portal/sessions/current",
    ]);
  }
});

it("私有日志只累计固定级别错误，不保留原文或把损坏记录当成功", () => {
  const diagnostics = mixedDiagnostics();
  diagnostics.write(JSON.stringify({ level: "info", secret: "public-fixture-secret" }));
  diagnostics.write(JSON.stringify({ level: "warn" }));
  expect(diagnostics.count()).toBe(0);
  diagnostics.write(JSON.stringify({ level: "error", err: { message: "public-fixture-secret" } }));
  diagnostics.write(JSON.stringify({ level: "fatal" }));
  diagnostics.write("not-json");
  diagnostics.write(JSON.stringify({ level: "unrecognized" }));
  expect(diagnostics.count()).toBe(4);
  expect(JSON.stringify(diagnostics)).not.toContain("public-fixture-secret");
});
