#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import {
  PROTOCOL,
  SHA,
  MixedFailure,
  requireFact,
  object,
  deadline,
  execute,
  dockerBackend,
} from "./mixed-version-smoke-runtime.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DRIVER = "apps/api/test/e2e/mixed-http-driver.ts";
const WORKER = "apps/worker/test/e2e/mixed-worker.ts";
export function parseMixedArgs(argv) {
  const options = { report: resolve(ROOT, "infra/dist/mixed-smoke.json") },
    seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i],
      value = argv[i + 1];
    requireFact(
      ["--prev", "--report"].includes(flag) &&
        !seen.has(flag) &&
        typeof value === "string" &&
        value.length > 0,
      "arguments",
    );
    seen.add(flag);
    if (flag === "--prev") {
      requireFact(SHA.test(value), "arguments");
      options.prev = value;
    } else {
      requireFact(
        value.endsWith(".json") && ![...value].some((char) => char.charCodeAt(0) < 32),
        "arguments",
      );
      options.report = resolve(value);
    }
  }
  return options;
}

export async function selectVersions({ root = ROOT, prev, budget, run = execute }) {
  const git = (args) => run("git", args, { cwd: root, timeoutMs: budget.remaining(false, 10_000) });
  const head = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
  requireFact(SHA.test(head), "source");
  const definition = (source) =>
    git(["ls-tree", "--name-only", source, "--", "infra/docker/server/Dockerfile"]);
  requireFact((await definition(head)) === "infra/docker/server/Dockerfile", "build-definition");
  for (const path of [DRIVER, WORKER])
    try {
      await git(["cat-file", "-e", `${head}:${path}`]);
    } catch {
      throw new MixedFailure("driver-missing");
    }
  let previous = prev,
    baseline = "explicit";
  if (!previous) {
    const parents = (await git(["rev-list", "--parents", "--max-count=1", head])).split(" ");
    requireFact(parents[0] === head && parents.every((one) => SHA.test(one)), "source");
    const parent = parents[1];
    if (!parent) return { head, previous: null, baseline: "none" };
    requireFact(SHA.test(parent), "source");
    const tags = await git(["tag", "--merged", parent, "--list", "v[0-9]*"]);
    if (tags) {
      const tag = await git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", parent]);
      requireFact(/^v[0-9][A-Za-z0-9._-]*$/.test(tag), "source");
      previous = await git(["rev-parse", "--verify", `${tag}^{commit}`]);
      baseline = "tag";
    } else {
      previous = parent;
      baseline = "first-parent-bootstrap";
    }
  }
  requireFact(SHA.test(previous) && previous !== head, "source");
  await git(["merge-base", "--is-ancestor", previous, head]);
  if ((await definition(previous)) !== "infra/docker/server/Dockerfile")
    return {
      head,
      previous: null,
      baseline,
      noComparableReason: "previous-build-definition-missing",
      previousCandidate: previous,
    };
  for (const path of [DRIVER, WORKER])
    try {
      await git(["cat-file", "-e", `${previous}:${path}`]);
    } catch {
      throw new MixedFailure("driver-missing");
    }
  const changed = (
    await git([
      "diff",
      "--name-only",
      previous,
      head,
      "--",
      "apps/api/src",
      "apps/worker/src",
      "packages",
    ])
  )
    .split("\n")
    .filter((path) => path && !path.includes("/testing/") && !/\.test\.[cm]?tsx?$/.test(path));
  return { head, previous, baseline, productionChangedFiles: changed.length };
}

export function workerEvidence(row, source, apiPid, settled = false) {
  requireFact(
    object(row) &&
      Number.isSafeInteger(row.pid) &&
      row.pid > 0 &&
      row.pid !== apiPid &&
      row.version === source &&
      row.active === true &&
      row.lease?.held === true &&
      row.lease.version === source &&
      Number.isSafeInteger(row.errors) &&
      row.errors === 0,
    "worker-evidence",
  );
  const pending = [
    "unpublished",
    "unsettled",
    "deadDeliveries",
    "dueTimers",
    "deadTimers",
    "mediaPending",
    "mediaFailed",
  ];
  requireFact(
    object(row.backlog) &&
      pending.every((key) => Number.isSafeInteger(row.backlog[key]) && row.backlog[key] >= 0),
    "worker-evidence",
  );
  requireFact(
    Array.isArray(row.queues) &&
      row.queues.length > 0 &&
      new Set(row.queues.map((queue) => queue.name)).size === row.queues.length,
    "worker-evidence",
  );
  for (const queue of row.queues)
    requireFact(
      ["outbox_delivery", "timer_run", "notify", "media_job", "promote"].includes(queue.name) &&
        ["waiting", "active", "failed10Min"].every(
          (key) => Number.isSafeInteger(queue[key]) && queue[key] >= 0,
        ),
      "worker-evidence",
    );
  if (settled)
    requireFact(
      pending.every((key) => row.backlog[key] === 0) &&
        row.queues.every(
          (queue) =>
            queue.waiting === 0 &&
            queue.active === 0 &&
            queue.failed10Min === 0 &&
            queue.paused === false,
        ),
      "not-drained",
    );
  return {
    pid: row.pid,
    version: source,
    leaseHeld: true,
    errors: 0,
    backlog: Object.fromEntries(pending.map((key) => [key, row.backlog[key]])),
    queues: row.queues.map((queue) => ({
      name: queue.name,
      waiting: queue.waiting,
      active: queue.active,
      failed10Min: queue.failed10Min,
    })),
  };
}
function chainEvidence(result) {
  const row = result?.report;
  requireFact(
    row?.episodeCount === 20 &&
      row.final?.order === "live" &&
      row.final.item === "live" &&
      row.final.ticket === "in_service" &&
      row.final.isLive === true &&
      row.invariants?.status === "succeeded" &&
      row.invariants.violationsFound === 0 &&
      row.invariants.errors === 0 &&
      Number.isSafeInteger(row.invariants.checksRun) &&
      row.invariants.checksRun > 0 &&
      object(result.access) &&
      Array.isArray(result.observedReads),
    "chain-evidence",
  );
  requireFact(["bootstrap", "existing-login"].includes(result.initialization), "chain-evidence");
  return {
    episodeCount: 20,
    final: { order: "live", item: "live", ticket: "in_service", isLive: true },
    invariants: { checksRun: row.invariants.checksRun, errors: 0, violationsFound: 0 },
    initialization: result.initialization,
  };
}
function readEvidence(row) {
  requireFact(
    object(row) &&
      Array.isArray(row.operations) &&
      row.operations.length > 0 &&
      Array.isArray(row.details),
    "read-evidence",
  );
  const project = (values) =>
    values.map((value) => {
      requireFact(
        object(value) &&
          /^(m|admin|portal)\.[A-Za-z0-9.]+$/.test(value.operationId) &&
          value.status === 200,
        "read-evidence",
      );
      return { operationId: value.operationId, status: 200 };
    });
  const operations = project(row.operations),
    details = project(row.details);
  requireFact(
    new Set(operations.map((row) => row.operationId)).size === operations.length,
    "read-evidence",
  );
  return { operations, details };
}

/** Same protocol/ordering with an injectable IO boundary for the five small pure risk groups. */
export async function fourSteps({
  versions,
  backend,
  budget,
  signal,
  checkpoint = () => undefined,
}) {
  const report = {
    schemaVersion: 1,
    status: "failed",
    ...versions,
    builds: [],
    steps: [],
    cleanup: { ok: false },
  };
  let phase;
  try {
    budget.remaining();
    report.stage = "dependencies";
    checkpoint(report);
    await backend.prepare();
    for (const source of versions.previous ? [versions.head, versions.previous] : [versions.head]) {
      report.stage = source === versions.head ? "build-head" : "build-previous";
      checkpoint(report);
      const row = await backend.build(source);
      requireFact(
        row?.source === source &&
          /^sha256:[a-f0-9]{64}$/.test(row.imageId) &&
          /^[a-f0-9]{64}$/.test(row.driverHash),
        "image-identity",
      );
      report.builds.push({ source, imageId: row.imageId, driverHash: row.driverHash });
    }
    report.stage = "owner-init";
    checkpoint(report);
    const owner = await backend.createOwner(versions.head),
      attachBase = owner.attachBase;
    requireFact(
      owner.source === versions.head &&
        Number.isSafeInteger(owner.pid) &&
        owner.pid > 0 &&
        object(attachBase?.scope) &&
        object(attachBase.storage),
      "owner-init",
    );
    requireFact(
      attachBase.scope.runId === backend.runId &&
        attachBase.scope.databaseName === `lyx_test_api_${backend.runId}_0_m1` &&
        attachBase.scope.redisPrefix === `lyx:test:${backend.runId}:0:` &&
        /^[a-f0-9]{32}$/.test(attachBase.scope.ownerToken) &&
        Number.isFinite(Date.parse(attachBase.scope.startedAt)) &&
        Object.keys(attachBase.storage.buckets).sort().join() === "asset,media,pub,secure" &&
        Object.entries(attachBase.storage.buckets).every(
          ([kind, name]) => name === `lyx-test-mixed-${backend.runId}-${kind}`,
        ),
      "owner-init",
    );
    report.owner = { source: owner.source, pid: owner.pid };
    const writes = [];
    let oldReadSpec;
    const phases = versions.previous
      ? [
          [versions.head, "head-write"],
          [versions.previous, "old-read-write"],
          [versions.head, "head-read"],
        ]
      : [[versions.head, "head-write"]];
    for (const [index, [source, kind]] of phases.entries()) {
      budget.remaining();
      report.stage = kind;
      checkpoint(report);
      phase = await backend.createPhase(source, kind, {
        ...attachBase,
        version: source,
        chainId: `${backend.runId.slice(0, 10)}${index}`,
      });
      const started = phase.started;
      requireFact(
        started?.protocol === PROTOCOL &&
          started.source === source &&
          Number.isSafeInteger(started.apiPid) &&
          started.apiPid > 0,
        "phase-identity",
      );
      const step = {
        phase: kind,
        source,
        apiPid: started.apiPid,
        worker: workerEvidence(started.worker, source, started.apiPid),
      };
      if (index > 0) {
        const prior = writes[index - 1];
        const read = await phase.call(
          "phase.read",
          {
            previousAccess: prior.access,
            observedReads: prior.observedReads,
            ...(index === 2 ? { previousSource: versions.previous, readSpec: oldReadSpec } : {}),
          },
          30_000,
        );
        step.reads = readEvidence(read);
        if (index === 1) {
          requireFact(
            read.readSpec?.source === versions.previous && Array.isArray(read.readSpec.operations),
            "read-spec",
          );
          oldReadSpec = read.readSpec;
        }
        const spec = oldReadSpec.operations;
        requireFact(
          spec.length > 0 &&
            spec.every(
              (row) =>
                typeof row.operationId === "string" &&
                typeof row.path === "string" &&
                row.path.startsWith("/api/v1/") &&
                Array.isArray(row.required),
            ) &&
            new Set(spec.map((row) => row.operationId)).size === spec.length,
          "read-spec",
        );
        const plain = spec.filter((row) => !row.path.includes("{"));
        requireFact(
          plain.length === step.reads.operations.length &&
            plain
              .map((row) => row.operationId)
              .sort()
              .join() ===
              step.reads.operations
                .map((row) => row.operationId)
                .sort()
                .join(),
          "read-spec",
        );
        requireFact(
          step.reads.details.every((row) =>
            spec.some((item) => item.operationId === row.operationId),
          ),
          "read-spec",
        );
        const readDrain = await phase.call("phase.drain");
        workerEvidence(readDrain.worker, source, started.apiPid, true);
      }
      if (index < 2) {
        const result = await phase.call(
          "phase.chain",
          index ? { admin: writes[0].access.admin } : {},
          240_000,
        );
        step.chain = chainEvidence(result);
        writes.push(result);
      }
      const drain = await phase.call("phase.drain");
      step.worker = workerEvidence(drain.worker, source, started.apiPid, true);
      const closed = await phase.close();
      requireFact(
        closed?.workerStopped === true && closed.bridgeClosed === true && closed.exitCode === 0,
        "phase-cleanup",
      );
      step.close = { workerStopped: true, bridgeClosed: true, exitCode: 0 };
      phase = undefined;
      report.steps.push(step);
      checkpoint(report);
    }
    requireFact(!signal?.aborted, "cancelled");
    report.status = versions.previous ? "passed" : "no-comparable";
  } catch (error) {
    report.failure = error instanceof MixedFailure ? error.code : "controller";
    if (error instanceof MixedFailure && error.operationId) report.operationId = error.operationId;
  } finally {
    try {
      report.cleanup = await backend.cleanup();
    } catch {
      report.cleanup = { ok: false };
    }
    if (!report.cleanup.ok || signal?.aborted || budget.elapsed() > 600_000) {
      report.status = "failed";
      report.failure ??= "cleanup";
    }
    report.elapsedMs = Math.round(budget.elapsed());
    checkpoint(report);
  }
  return report;
}

/** Create the destination once; subsequent atomic updates replace only this invocation's own file. */
export function reportWriter(path) {
  const parent = dirname(path);
  for (let dir = parent; ; dir = dirname(dir)) {
    // macOS has these two fixed system aliases; user-created symlinks are still rejected.
    const systemAlias =
      process.platform === "darwin" &&
      ((dir === "/tmp" && realpathSync(dir) === "/private/tmp") ||
        (dir === "/var" && realpathSync(dir) === "/private/var"));
    requireFact(!existsSync(dir) || !lstatSync(dir).isSymbolicLink() || systemAlias, "report-path");
    if (dir === dirname(dir)) break;
  }
  mkdirSync(parent, { recursive: true });
  writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  return (report) => {
    writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  };
}
export async function main(argv = process.argv.slice(2)) {
  let save,
    current = { schemaVersion: 1, status: "failed", failure: "preflight" };
  const abort = new AbortController(),
    budget = deadline(undefined, abort.signal);
  const stop = () => {
    abort.abort();
    current.status = "failed";
    current.failure = "cancelled";
    save?.(current);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const options = parseMixedArgs(argv);
    save = reportWriter(options.report);
    save(current);
    const versions = await selectVersions({ prev: options.prev, budget });
    const backend = dockerBackend({ root: ROOT, budget, signal: abort.signal });
    current = await fourSteps({
      versions,
      backend,
      budget,
      signal: abort.signal,
      checkpoint: (value) => {
        current = value;
        save(value);
      },
    });
  } catch (error) {
    current = {
      schemaVersion: 1,
      status: "failed",
      failure: error instanceof MixedFailure ? error.code : "preflight",
      elapsedMs: Math.round(budget.elapsed()),
    };
    save?.(current);
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
  process.stdout.write(`${JSON.stringify({ status: current.status })}\n`);
  return current.status === "passed" || current.status === "no-comparable" ? 0 : 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
