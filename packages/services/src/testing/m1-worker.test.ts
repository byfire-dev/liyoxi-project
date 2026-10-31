import { afterEach, expect, it, vi } from "vitest";
import { EVENTS, JOBS, SUBSCRIBERS } from "@liyoxi/contract/registry";
import { assertM1WorkerKnown, m1WorkerSettled, waitM1Worker } from "./m1-observe.js";
import type { M1WorkerBacklog } from "./m1-observe.js";
import { createM1WorkerResources, M1WorkerAttachmentSchema } from "./m1-worker.js";
import { assertM1SharedScope } from "./m1-shared.js";
import { createM1Support } from "./m1-support.js";
import { M1_LICENSE_TEST_INPUTS } from "./m1-license-inputs.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("后台worker纯守卫：错误能力/环境先拒，未知与死信不能排空，取消拒绝迟到观察", async () => {
  const attach = {
    scope: {
      runId: "guard",
      databaseName: "lyx_test_api_guard_0_m1",
      redisPrefix: "lyx:test:guard:0:",
      ownerToken: "1".repeat(32),
      startedAt: new Date().toISOString(),
    },
    chainId: "read",
    version: "a".repeat(40),
    storage: {
      endpoint: "http://127.0.0.1:9100",
      region: "us-east-1",
      accessKey: "liyoxi",
      secretKey: "lyx-local-dev",
      buckets: {
        secure: "lyx-test-mixed-guard-secure",
        asset: "lyx-test-mixed-guard-asset",
        media: "lyx-test-mixed-guard-media",
        pub: "lyx-test-mixed-guard-pub",
      },
    },
  };
  const explicitOwnerInput = {
    ...attach,
    scope: { ...attach.scope, licenseTestInputs: M1_LICENSE_TEST_INPUTS },
  };
  expect(M1WorkerAttachmentSchema.parse(explicitOwnerInput).scope.licenseTestInputs).toEqual(
    M1_LICENSE_TEST_INPUTS,
  );
  expect(() => assertM1SharedScope(explicitOwnerInput.scope)).not.toThrow();
  expect(M1WorkerAttachmentSchema.parse(attach).scope.licenseTestInputs).toBeUndefined();
  for (const licenseTestInputs of [
    { portalPublicOrigin: "https://production.example.invalid" },
    { ...M1_LICENSE_TEST_INPUTS, legalEntity: "unsolicited" },
  ])
    expect(
      M1WorkerAttachmentSchema.safeParse({
        ...attach,
        scope: { ...attach.scope, licenseTestInputs },
      }).success,
    ).toBe(false);
  expect(M1WorkerAttachmentSchema.safeParse({ ...attach, version: "dev" }).success).toBe(false);
  expect(() => assertM1SharedScope({ ...attach.scope, databaseName: "liyoxi" })).toThrow("自有");
  vi.stubEnv("APP_ENV", "prod");
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", fetch);
  await expect(createM1WorkerResources(attach, ["outbox_delivery"])).rejects.toThrow("local");
  vi.stubEnv("APP_ENV", "test");
  await expect(
    createM1Support({ backgroundWorker: { resumeTimerScan: async () => {} } }),
  ).rejects.toThrow("受保护attach");
  expect(fetch).not.toHaveBeenCalled();

  const baseline: M1WorkerBacklog = {
    kinds: {
      events: [EVENTS[0]!.name],
      subscribers: [SUBSCRIBERS[0]!.name],
      timers: [JOBS[0]!.kind],
      media: ["promote"],
    },
    unpublished: 0,
    unsettled: 0,
    deadDeliveries: 0,
    dueTimers: 0,
    deadTimers: 0,
    mediaPending: 0,
    mediaFailed: 0,
    docsPending: 0,
    docsFailed: 0,
    published: 1,
    consumed: 1,
  };
  expect(() => assertM1WorkerKnown(baseline, [SUBSCRIBERS[0]!.name])).not.toThrow();
  expect(m1WorkerSettled(baseline)).toBe(true);
  for (const key of [
    "unpublished",
    "unsettled",
    "dueTimers",
    "mediaPending",
    "docsPending",
  ] as const)
    expect(m1WorkerSettled({ ...baseline, [key]: 1 })).toBe(false);
  for (const key of ["events", "subscribers", "timers", "media"] as const)
    expect(() =>
      assertM1WorkerKnown(
        { ...baseline, kinds: { ...baseline.kinds, [key]: ["future.unknown"] } },
        [SUBSCRIBERS[0]!.name],
      ),
    ).toThrow("未知");
  for (const key of ["deadDeliveries", "deadTimers", "mediaFailed", "docsFailed"] as const)
    expect(() => assertM1WorkerKnown({ ...baseline, [key]: 1 }, [SUBSCRIBERS[0]!.name])).toThrow(
      "死信",
    );

  let resolve!: (value: true) => void;
  const read = new Promise<true>((done) => {
    resolve = done;
  });
  const abort = new AbortController();
  const rejected = expect(
    waitM1Worker(
      () => read,
      () => undefined,
      abort.signal,
    ),
  ).rejects.toThrow();
  abort.abort(new Error("owned cancel"));
  resolve(true); // a successful late read must not turn a canceled observation into success
  await rejected;
  await expect(
    waitM1Worker(
      async () => true,
      () => {
        throw new Error("lost owner");
      },
    ),
  ).rejects.toThrow("lost owner");
});
