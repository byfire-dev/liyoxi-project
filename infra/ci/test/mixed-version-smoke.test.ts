import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { makeTempDir, repoRoot } from "./helpers.js";

const { parseMixedArgs, selectVersions, workerEvidence, fourSteps, reportWriter } = await import(
  pathToFileURL(join(repoRoot, "infra/ci/mixed-version-smoke.mjs")).href
);
const { RpcPeer, MixedFailure, deadline, dockerBackend, PROTOCOL, MAX_FRAME } = await import(
  pathToFileURL(join(repoRoot, "infra/ci/mixed-version-smoke-runtime.mjs")).href
);
const HEAD = "a".repeat(40),
  OLD = "b".repeat(40),
  IMAGE = `sha256:${"c".repeat(64)}`;
const versions = {
  head: HEAD,
  previous: OLD,
  baseline: "first-parent-bootstrap",
  productionChangedFiles: 0,
};
const privateValue = "SENSITIVE-private-credential";
const runId = "abcdef123456";
const worker = (source: string) => ({
  pid: 12,
  version: source,
  active: true,
  errors: 0,
  lease: { held: true, version: source },
  backlog: {
    unpublished: 0,
    unsettled: 0,
    deadDeliveries: 0,
    dueTimers: 0,
    deadTimers: 0,
    mediaPending: 0,
    mediaFailed: 0,
  },
  queues: [{ name: "timer_run", waiting: 0, active: 0, failed10Min: 0, paused: false }],
  hidden: privateValue,
});
const attachBase = {
  scope: {
    runId,
    databaseName: `lyx_test_api_${runId}_0_m1`,
    redisPrefix: `lyx:test:${runId}:0:`,
    ownerToken: "d".repeat(32),
    startedAt: "2026-10-15T00:00:00.000Z",
  },
  storage: {
    buckets: Object.fromEntries(
      ["asset", "media", "pub", "secure"].map((kind) => [kind, `lyx-test-mixed-${runId}-${kind}`]),
    ),
  },
};
function fakeBackend(failAt = "") {
  const calls: string[] = [];
  const backend = {
    runId,
    prepare: async () => {
      calls.push("prepare");
    },
    build: async (source: string) => {
      calls.push(`build:${source}`);
      return { source, imageId: IMAGE, driverHash: "e".repeat(64), hidden: privateValue };
    },
    createOwner: async (source: string) => {
      calls.push("owner");
      return { source, pid: 9, attachBase };
    },
    createPhase: async (source: string, phase: string, attach: Record<string, unknown>) => {
      calls.push(`start:${phase}`);
      expect(attach.version).toBe(source);
      return {
        started: { protocol: PROTOCOL, source, apiPid: 10, worker: worker(source) },
        call: async (method: string, params: Record<string, unknown>) => {
          calls.push(`${phase}:${method}`);
          if (`${phase}:${method}` === failAt) throw new MixedFailure("rpc-remote");
          if (method === "phase.drain") return { worker: worker(source), drain: { consumed: 1 } };
          if (method === "phase.read") {
            expect(params.previousAccess).toMatchObject({ admin: { password: privateValue } });
            if (phase === "head-read")
              expect(params).toMatchObject({ previousSource: OLD, readSpec: { source: OLD } });
            else expect(params).not.toHaveProperty("readSpec");
            return {
              operations: [{ operationId: "m.me.get", status: 200 }],
              details: [{ operationId: "m.order.get", status: 200 }],
              readSpec: {
                source: OLD,
                operations: [
                  { operationId: "m.me.get", path: "/api/v1/m/me", required: [] },
                  { operationId: "m.order.get", path: "/api/v1/m/orders/{orderId}", required: [] },
                ],
              },
              raw: privateValue,
            };
          }
          expect(method).toBe("phase.chain");
          if (phase === "old-read-write")
            expect(params.admin).toMatchObject({ password: privateValue });
          return {
            report: {
              episodeCount: 20,
              final: { order: "live", item: "live", ticket: "in_service", isLive: true },
              invariants: { status: "succeeded", checksRun: 123, errors: 0, violationsFound: 0 },
              unsafe: privateValue,
            },
            initialization: phase === "head-write" ? "bootstrap" : "existing-login",
            access: {
              admin: { password: privateValue },
              chainId: phase,
              ids: { orderId: privateValue },
            },
            observedReads: ["/api/v1/m/orders/private"],
          };
        },
        close: async () => {
          calls.push(`close:${phase}`);
          return { workerStopped: true, bridgeClosed: true, exitCode: 0 };
        },
      };
    },
    cleanup: async () => {
      calls.push("cleanup");
      return {
        ok: true,
        scopeAbsenceVerified: true,
        bucketsAbsent: true,
        sharedDependenciesPreserved: true,
      };
    },
  };
  return { backend, calls };
}
afterEach(() => vi.useRealTimers());

it("W228 controller：固定CLI、真实prev定义与driver能力拒绝，严格限定no-comparable", async () => {
  expect(parseMixedArgs(["--prev", OLD, "--report", "/tmp/mixed.json"])).toMatchObject({
    prev: OLD,
    report: "/tmp/mixed.json",
  });
  for (const args of [
    ["--prev", "HEAD~1"],
    ["--command", "sh"],
    ["--prev", OLD, "--prev", OLD],
    ["--report", "/tmp/x.json\n"],
  ])
    expect(() => parseMixedArgs(args)).toThrow("arguments");
  const git = async (_command: string, args: string[]) => {
    if (args[0] === "rev-parse") return HEAD;
    if (args[0] === "ls-tree") return "infra/docker/server/Dockerfile";
    if (args[0] === "cat-file") return "";
    if (args[0] === "rev-list") return HEAD;
    throw new Error("unexpected");
  };
  expect(await selectVersions({ budget: deadline(), run: git })).toEqual({
    head: HEAD,
    previous: null,
    baseline: "none",
  });
  await expect(
    selectVersions({
      budget: deadline(),
      run: async () => {
        throw new MixedFailure("command");
      },
    }),
  ).rejects.toThrow("command");
  const comparable = async (_command: string, args: string[]) => {
    if (args[0] === "rev-parse") return HEAD;
    if (args[0] === "rev-list") return `${HEAD} ${OLD}`;
    if (args[0] === "tag" || args[0] === "merge-base") return "";
    if (args[0] === "ls-tree") return "infra/docker/server/Dockerfile";
    if (args[0] === "cat-file" && args.at(-1)!.startsWith(OLD)) throw new Error("driver absent");
    return "";
  };
  await expect(selectVersions({ budget: deadline(), run: comparable })).rejects.toThrow(
    "driver-missing",
  );
  const missing = async (command: string, args: string[]) =>
    args[0] === "ls-tree" && args[2] === OLD ? "" : comparable(command, args);
  expect(await selectVersions({ budget: deadline(), run: missing })).toMatchObject({
    previous: null,
    noComparableReason: "previous-build-definition-missing",
  });
  await expect(
    selectVersions({
      budget: deadline(),
      run: async (command: string, args: string[]) =>
        args[0] === "ls-tree" ? "" : comparable(command, args),
    }),
  ).rejects.toThrow("build-definition");
  const { backend, calls } = fakeBackend();
  const noBaseline = await fourSteps({
    versions: { head: HEAD, previous: null, baseline: "none" },
    backend,
    budget: deadline(),
  });
  expect(noBaseline.status).toBe("no-comparable");
  expect(calls).toEqual([
    "prepare",
    `build:${HEAD}`,
    "owner",
    "start:head-write",
    "head-write:phase.chain",
    "head-write:phase.drain",
    "close:head-write",
    "cleanup",
  ]);
  expect(noBaseline.steps).toHaveLength(1);
  const headFailure = fakeBackend("head-write:phase.chain");
  const failedHead = await fourSteps({
    versions: { head: HEAD, previous: null, baseline: "none" },
    backend: headFailure.backend,
    budget: deadline(),
  });
  expect(failedHead).toMatchObject({ status: "failed", failure: "rpc-remote" });
  expect(headFailure.calls.at(-1)).toBe("cleanup");
  const cleanupFailure = fakeBackend();
  cleanupFailure.backend.cleanup = async () => {
    throw new MixedFailure("cleanup");
  };
  expect(
    await fourSteps({
      versions: { head: HEAD, previous: null, baseline: "none" },
      backend: cleanupFailure.backend,
      budget: deadline(),
    }),
  ).toMatchObject({ status: "failed", failure: "cleanup" });
  const temp = makeTempDir("mixed-report-");
  try {
    const target = join(temp.dir, "report.json"),
      write = reportWriter(target);
    write({ status: "failed" });
    write({ status: "passed" });
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ status: "passed" });
    expect(() => reportWriter(target)).toThrow();
    const real = join(temp.dir, "real"),
      alias = join(temp.dir, "alias");
    mkdirSync(real);
    symlinkSync(real, alias);
    expect(() => reportWriter(join(alias, "new", "report.json"))).toThrow("report-path");
    expect(existsSync(join(real, "new"))).toBe(false);
  } finally {
    temp.cleanup();
  }
});

it("W228 controller：私有JSONL限长/单请求/同id/固定方法与取消，不接受噪声或未知响应", async () => {
  class Child extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    writes: string[] = [];
    stdin = new Writable({
      write: (chunk, _encoding, done) => {
        this.writes.push(String(chunk));
        done();
      },
    });
    kill = vi.fn(() => true);
  }
  const child = new Child(),
    peer = new RpcPeer(child, "phase");
  const first = peer.call("phase.start", {}, 1000);
  expect(() => peer.call("phase.read", {}, 1000)).toThrow("rpc-state");
  const input = JSON.parse(child.writes[0]!);
  expect(input).toMatchObject({ protocol: PROTOCOL, id: 1, method: "phase.start" });
  child.stderr.write(privateValue);
  child.stdout.write(
    JSON.stringify({ protocol: PROTOCOL, id: 1, ok: true, result: { access: privateValue } }) +
      "\n",
  );
  expect(await first).toEqual({ access: privateValue });
  expect(() => peer.call("owner.init", {}, 1000)).toThrow("rpc-state");
  expect(() => peer.call("phase.read", { raw: "x".repeat(MAX_FRAME) }, 1000)).toThrow("rpc-frame");
  const second = peer.call("phase.read", {}, 1000),
    rejection = expect(second).rejects.toThrow("rpc-frame");
  child.stdout.write(JSON.stringify({ protocol: PROTOCOL, id: 1, ok: true, result: {} }) + "\n");
  await rejection;
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  vi.useFakeTimers();
  const timedChild = new Child(),
    timed = new RpcPeer(timedChild, "owner");
  const pending = timed.call("owner.init", {}, 50),
    timedRejection = expect(pending).rejects.toThrow("rpc-timeout");
  await vi.advanceTimersByTimeAsync(50);
  await timedRejection;
  const noisyChild = new Child(),
    noisy = new RpcPeer(noisyChild, "phase");
  const noise = noisy.call("phase.start", {}, 1000),
    noiseRejection = expect(noise).rejects.toThrow("rpc-frame");
  noisyChild.stdout.write(`plain log ${privateValue}\n`);
  await noiseRejection;
  const readChild = new Child(),
    diagnosed = new RpcPeer(readChild, "phase");
  const read = diagnosed.call("phase.read", {}, 1000),
    readRejected = expect(read).rejects.toMatchObject({
      code: "read-failed",
      operationId: "m.me.get",
    });
  readChild.stdout.write(
    JSON.stringify({
      protocol: PROTOCOL,
      id: 1,
      ok: false,
      errorCode: "read_failed",
      operationId: "m.me.get",
    }) + "\n",
  );
  await readRejected;
  const wrong = diagnosed.call("phase.read", {}, 1000),
    wrongRejected = expect(wrong).rejects.toThrow("rpc-frame");
  readChild.stdout.write(
    JSON.stringify({
      protocol: PROTOCOL,
      id: 2,
      ok: false,
      errorCode: "owner_failed",
      operationId: "m.me.get",
    }) + "\n",
  );
  await wrongRejected;
  for (const one of [child, timedChild, noisyChild, readChild]) {
    one.stdin.destroy();
    one.stdout.destroy();
    one.stderr.destroy();
    one.emit("close", 1, null);
  }
});

it("W228 controller：四步对应SHA/独立worker真实事实/两20集链与两向读，报告仅白名单", async () => {
  const { backend, calls } = fakeBackend();
  const report = await fourSteps({ versions, backend, budget: deadline() });
  expect(report.status).toBe("passed");
  expect(report.owner).toEqual({ source: HEAD, pid: 9 });
  expect(report.steps.map((step: { phase: string }) => step.phase)).toEqual([
    "head-write",
    "old-read-write",
    "head-read",
  ]);
  expect(calls.filter((name) => name.endsWith(":phase.chain"))).toHaveLength(2);
  expect(calls.filter((name) => name.endsWith(":phase.read"))).toHaveLength(2);
  expect(calls.indexOf("close:head-write")).toBeLessThan(calls.indexOf("start:old-read-write"));
  expect(calls.indexOf("close:old-read-write")).toBeLessThan(calls.indexOf("start:head-read"));
  expect(calls.at(-1)).toBe("cleanup");
  expect(JSON.stringify(report)).not.toContain(privateValue);
  expect(JSON.stringify(report)).not.toMatch(
    /password|merchantHeaders|ownerToken|observedReads|\/api\/v1/,
  );
  expect(report.cleanup).toMatchObject({ scopeAbsenceVerified: true, bucketsAbsent: true });
  const invalid = worker(HEAD);
  invalid.pid = 10;
  expect(() => workerEvidence(invalid, HEAD, 10)).toThrow("worker-evidence");
  invalid.pid = 12;
  invalid.backlog.mediaPending = 1;
  expect(() => workerEvidence(invalid, HEAD, 10, true)).toThrow("not-drained");
  invalid.backlog.mediaPending = 0;
  invalid.lease.version = OLD;
  expect(() => workerEvidence(invalid, HEAD, 10)).toThrow("worker-evidence");
});

it("W228 controller：任一读/排空/清理失败非零，600秒含清理且取消不伪绿", async () => {
  const failed = fakeBackend("old-read-write:phase.read");
  const report = await fourSteps({ versions, backend: failed.backend, budget: deadline() });
  expect(report.status).toBe("failed");
  expect(report.failure).toBe("rpc-remote");
  expect(failed.calls).not.toContain("start:head-read");
  expect(failed.calls.at(-1)).toBe("cleanup");
  const unclean = fakeBackend();
  unclean.backend.cleanup = async () => ({
    ok: false,
    scopeAbsenceVerified: false,
    bucketsAbsent: false,
    sharedDependenciesPreserved: true,
  });
  expect((await fourSteps({ versions, backend: unclean.backend, budget: deadline() })).status).toBe(
    "failed",
  );
  let now = 0;
  const timed = deadline(() => now);
  now = 540_000;
  expect(() => timed.remaining()).toThrow("deadline");
  expect(timed.remaining(true)).toBe(60_000);
  now = 600_000;
  expect(() => timed.remaining(true)).toThrow("deadline");
  const abort = new AbortController();
  abort.abort();
  const cancelled = fakeBackend();
  expect(
    (
      await fourSteps({
        versions,
        backend: cancelled.backend,
        budget: deadline(undefined, abort.signal),
        signal: abort.signal,
      })
    ).status,
  ).toBe("failed");
  expect(cancelled.calls).toEqual(["cleanup"]);
});

it("W228 controller：私网只撤成功连接的已核ID，失败继续精确清理且共享服务绝不stop/rm", async () => {
  const calls: string[][] = [],
    ids = { postgres: "1".repeat(64), redis: "2".repeat(64), minio: "3".repeat(64) },
    network = "4".repeat(64);
  const labels: Record<string, string> = {};
  const runner = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "context") return JSON.stringify("unix:///local/docker.sock");
    if (args[0] === "inspect") {
      const target = args.at(-1)!;
      const service = (Object.keys(ids) as (keyof typeof ids)[]).find(
        (key) => target === `lyx-${key}` || target === ids[key],
      )!;
      expect(service).toBeDefined();
      return JSON.stringify({
        id: ids[service],
        name: `/lyx-${service}`,
        running: true,
        health: "healthy",
        labels: { "com.docker.compose.project": "liyoxi", "com.docker.compose.service": service },
        networks: { original: { NetworkID: "5".repeat(64) } },
      });
    }
    if (args[0] === "network" && args[1] === "create") {
      for (let i = 0; i < args.length; i++)
        if (args[i] === "--label") {
          const [key, value] = args[i + 1]!.split("=");
          labels[key!] = value!;
        }
      return network;
    }
    if (args[0] === "network" && args[1] === "connect") {
      if (args.at(-1) === ids.redis) throw new MixedFailure("command");
      return "";
    }
    if (args[0] === "network" && args[1] === "inspect")
      return JSON.stringify({ Id: network, Labels: labels });
    if (args[0] === "network" && ["disconnect", "rm"].includes(args[1]!)) return "";
    throw new Error("unexpected command");
  };
  const backend = dockerBackend({ root: repoRoot, budget: deadline(), run: runner });
  try {
    await backend.prepare();
    await expect(backend.createOwner(HEAD)).rejects.toThrow("command");
    expect(await backend.cleanup()).toEqual({
      ok: true,
      ownerStarted: false,
      sharedDependenciesPreserved: true,
    });
    expect(calls.filter((args) => args[0] === "network" && args[1] === "disconnect")).toEqual([
      ["network", "disconnect", network, ids.postgres],
    ]);
    expect(calls.some((args) => ["stop", "rm", "restart", "prune"].includes(args[0]!))).toBe(false);
  } finally {
    await backend.cleanup();
  }
});
