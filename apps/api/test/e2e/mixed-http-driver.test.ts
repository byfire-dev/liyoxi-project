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
    year: 2026,
    observedReads: ["/api/v1/admin/staff/" + id],
  };
  const plan = mixedReadPlan(operations, options);
  expect(plan.operations.map((row) => row.operationId).sort()).toEqual(
    operations
      .filter((row) => !row.path.includes("{"))
      .map((row) => row.operationId)
      .sort(),
  );
  expect(plan.operations.filter((row) => row.path.includes("?"))).toHaveLength(8);
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
  expect(plan.operations.find((row) => row.operationId === "m.drama.search")?.path).toContain(
    "q=" + encodeURIComponent("修车"),
  );
  expect(
    plan.details.some((row) => row.operationId === "admin.deliveryTicket.episodeOutput.list"),
  ).toBe(true);
  expect(plan.details.some((row) => row.operationId === "admin.staff.get")).toBe(true);
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
