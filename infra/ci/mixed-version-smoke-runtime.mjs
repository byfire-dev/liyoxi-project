import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PROTOCOL = "w228-rpc-v1";
export const MAX_FRAME = 1024 * 1024;
export const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-f0-9]{64}$/;
const ownLabels = (runId, nonce) => ({ "lyx.mixed.run": runId, "lyx.mixed.owner": nonce });
export class MixedFailure extends Error {
  constructor(code, operationId) {
    super(code);
    this.code = code;
    if (operationId !== undefined) this.operationId = operationId;
  }
}
export const requireFact = (condition, code) => {
  if (!condition) throw new MixedFailure(code);
};
export const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function deadline(now = () => performance.now(), signal) {
  const start = now();
  return {
    elapsed: () => Math.max(0, now() - start),
    remaining(cleanup = false, cap = Infinity) {
      if (!cleanup && signal?.aborted) throw new MixedFailure("cancelled");
      const ms = (cleanup ? 600_000 : 540_000) - (now() - start);
      requireFact(ms > 0, "deadline");
      return Math.min(ms, cap);
    },
  };
}

/** No shell, no raw stderr in receipts, and only the process group we just started is signalled. */
export function execute(command, args, { cwd, timeoutMs, signal } = {}) {
  requireFact(timeoutMs > 0, "deadline");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      failed = false,
      timer,
      killTimer;
    const kill = (kind) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(kind);
        else process.kill(-child.pid, kind);
      } catch {
        /* own child already ended */
      }
    };
    const cancel = () => {
      failed = true;
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      if (failed) return;
      output += chunk;
      if (Buffer.byteLength(output) > 4 * MAX_FRAME) cancel();
    });
    child.stderr.resume();
    child.once("error", () => {
      failed = true;
    });
    timer = setTimeout(cancel, timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", cancel);
      if (failed || code !== 0) reject(new MixedFailure("command"));
      else resolve(output.trim());
    });
  });
}

/** Private, single-flight JSONL. Non-protocol stdout and stale/unsolicited responses fail closed. */
export class RpcPeer {
  constructor(child, mode) {
    this.child = child;
    this.mode = mode;
    this.sequence = 0;
    this.buffer = "";
    this.pending = undefined;
    this.broken = false;
    this.exited = new Promise((resolve) =>
      child.once("close", (code, signal) => {
        this.ended = true;
        this.rejectPending("rpc-exit");
        resolve({ code, signal });
      }),
    );
    child.once("error", () => this.break("rpc-exit"));
    child.stdin.on("error", () => this.break("rpc-write"));
    child.stderr.resume();
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > MAX_FRAME) return this.break("rpc-frame");
      let end;
      while ((end = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          return this.break("rpc-frame");
        }
        const diagnosed =
          row?.ok === false && row.errorCode === "read_failed" && Object.hasOwn(row, "operationId");
        const allowed =
          row?.ok === true
            ? ["protocol", "id", "ok", "result"]
            : ["protocol", "id", "ok", "errorCode", ...(diagnosed ? ["operationId"] : [])];
        if (
          !object(row) ||
          Object.keys(row).sort().join() !== allowed.sort().join() ||
          row.protocol !== PROTOCOL ||
          !this.pending ||
          row.id !== this.pending.id ||
          typeof row.ok !== "boolean" ||
          (diagnosed &&
            (typeof row.operationId !== "string" ||
              row.operationId.length > 160 ||
              !/^(m|admin|portal)\.[A-Za-z0-9.]+$/.test(row.operationId)))
        )
          return this.break("rpc-frame");
        const pending = this.pending;
        this.pending = undefined;
        clearTimeout(pending.timer);
        if (row.ok) pending.resolve(row.result);
        else
          pending.reject(
            new MixedFailure(
              row.errorCode === "read_failed" ? "read-failed" : "rpc-remote",
              diagnosed ? row.operationId : undefined,
            ),
          );
      }
    });
    child.stdout.once("end", () => {
      if (this.buffer.length) this.break("rpc-frame");
    });
  }
  rejectPending(code) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(new MixedFailure(code));
    this.pending = undefined;
  }
  break(code) {
    this.broken = true;
    this.rejectPending(code);
    this.child.kill("SIGTERM");
  }
  call(method, params, timeoutMs) {
    const methods =
      this.mode === "owner"
        ? ["owner.init", "owner.close"]
        : ["phase.start", "phase.chain", "phase.read", "phase.drain", "phase.close"];
    requireFact(
      methods.includes(method) && object(params) && !this.pending && !this.broken && !this.ended,
      "rpc-state",
    );
    const id = ++this.sequence,
      encoded = JSON.stringify({ protocol: PROTOCOL, id, method, params }) + "\n";
    requireFact(Buffer.byteLength(encoded) <= MAX_FRAME, "rpc-frame");
    return new Promise((resolve, reject) => {
      this.pending = {
        id,
        resolve,
        reject,
        timer: setTimeout(() => this.break("rpc-timeout"), timeoutMs),
      };
      this.child.stdin.write(encoded, (error) => {
        if (error) this.break("rpc-write");
      });
    });
  }
  async wait(timeoutMs) {
    let timer;
    try {
      const result = await Promise.race([
        this.exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new MixedFailure("rpc-exit")), timeoutMs);
        }),
      ]);
      requireFact(result.code === 0 && !result.signal && !this.broken, "rpc-exit");
    } finally {
      clearTimeout(timer);
    }
  }
}

const CONTAINER =
  '{"id":{{json .Id}},"image":{{json .Image}},"name":{{json .Name}},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"labels":{{json .Config.Labels}},"networks":{{json .NetworkSettings.Networks}}}';
const IMAGE = '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}';
export function assertDependency(row, service) {
  requireFact(
    object(row) &&
      ID.test(row.id) &&
      row.name === `/lyx-${service}` &&
      row.running &&
      row.health === "healthy" &&
      row.labels?.["com.docker.compose.project"] === "liyoxi" &&
      row.labels?.["com.docker.compose.service"] === service &&
      object(row.networks) &&
      Object.keys(row.networks).length > 0,
    "dependency-identity",
  );
}

/** Own only a private network, archive/tag/container ledger; shared dependency lifecycle is never ours. */
export function dockerBackend({ root, budget, signal, run = execute, spawnProcess = spawn }) {
  const runId = randomBytes(6).toString("hex"),
    nonce = randomBytes(16).toString("hex");
  const privateRoot = mkdtempSync(join(tmpdir(), `lyx-mixed-${runId}-`));
  const dependencies = {},
    connected = [],
    containers = [],
    tags = [],
    builds = new Map();
  let networkId,
    owner,
    active,
    scopeClean = false,
    bucketsClean = false,
    cleanupDone;
  const cancel = () => {
    if (active?.peer) active.peer.break("cancelled");
    if (owner?.peer.pending) owner.peer.break("cancelled");
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const cmd = (command, args, cap = 30_000, cleanup = false) =>
    run(command, args, {
      cwd: root,
      timeoutMs: budget.remaining(cleanup, cap),
      signal: cleanup ? undefined : signal,
    });
  const docker = (args, cap, cleanup) => cmd("docker", args, cap, cleanup);
  const inspect = async (id, cleanup = false) =>
    JSON.parse(
      await docker(["inspect", "--type", "container", "--format", CONTAINER, id], 5000, cleanup),
    );
  const labels = Object.entries(ownLabels(runId, nonce)).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
  async function owned(id, cleanup = false) {
    const row = await inspect(id, cleanup);
    requireFact(
      row.id === id &&
        Object.entries(ownLabels(runId, nonce)).every(
          ([key, value]) => row.labels?.[key] === value,
        ),
      "container-ownership",
    );
    return row;
  }
  async function removeContainer(entry) {
    if (entry.removed) return;
    const row = await owned(entry.id, true);
    if (row.running) await docker(["stop", "--time", "3", entry.id], 5000, true);
    await docker(["rm", entry.id], 5000, true);
    entry.removed = true;
  }
  async function closePeer(entry, cleanup = false) {
    const result = await entry.peer.call(
      `${entry.mode}.close`,
      {},
      budget.remaining(cleanup, 30_000),
    );
    if (entry.mode === "owner") {
      requireFact(
        result?.closed === true &&
          result.scopeAbsenceVerified === true &&
          result.bucketsAbsent === true,
        "owner-cleanup",
      );
      scopeClean = true;
      bucketsClean = true;
    } else
      requireFact(result?.workerStopped === true && result.bridgeClosed === true, "phase-cleanup");
    await entry.peer.wait(budget.remaining(cleanup, 5000));
    await removeContainer(entry);
    entry.closed = true;
    if (entry === active) active = undefined;
    return entry.mode === "phase"
      ? { workerStopped: true, bridgeClosed: true, exitCode: 0 }
      : result;
  }
  async function launch(mode, source) {
    const build = builds.get(source);
    requireFact(build && networkId && !active, "phase-state");
    const env = [
      "--env",
      `APP_ENV=${mode === "owner" ? "test" : "local"}`,
      "--env",
      "LOG_LEVEL=warn",
      "--env",
      `DATABASE_URL=postgresql://liyoxi:lyx-local-dev@lyx-mixed-${runId}-postgres:5432/liyoxi`,
      "--env",
      `REDIS_URL=redis://lyx-mixed-${runId}-redis:6379/0`,
    ];
    const id = await docker([
      "create",
      "--interactive",
      "--init",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m",
      "--network",
      networkId,
      ...labels,
      ...env,
      "--workdir",
      "/repo",
      "--entrypoint",
      "node",
      build.imageId,
      "packages/services/node_modules/tsx/dist/cli.mjs",
      "apps/api/test/e2e/mixed-http-driver.ts",
      mode,
    ]);
    requireFact(ID.test(id), "container-identity");
    const entry = { id, mode, source, closed: false, removed: false };
    containers.push(entry);
    const row = await owned(id);
    requireFact(row.image === build.imageId, "container-identity");
    entry.peer = new RpcPeer(
      spawnProcess("docker", ["start", "--attach", "--interactive", id], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      }),
      mode,
    );
    if (mode === "owner") owner = entry;
    else active = entry;
    return entry;
  }
  return {
    runId,
    async prepare() {
      requireFact(
        !process.env.DOCKER_HOST || process.env.DOCKER_HOST.startsWith("unix://"),
        "docker-context",
      );
      const context = JSON.parse(
        await docker(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]),
      );
      requireFact(typeof context === "string" && context.startsWith("unix://"), "docker-context");
      for (const service of ["postgres", "redis", "minio"]) {
        const row = await inspect(`lyx-${service}`);
        assertDependency(row, service);
        dependencies[service] = row;
      }
    },
    async build(source) {
      requireFact(SHA.test(source), "source");
      const dir = join(privateRoot, source),
        archive = join(privateRoot, `${source}.tar`);
      mkdirSync(dir, { mode: 0o700 });
      await cmd("git", ["archive", "--format=tar", `--output=${archive}`, source]);
      await cmd("tar", ["-xf", archive, "-C", dir]);
      const driver = readFileSync(join(dir, "apps/api/test/e2e/mixed-http-driver.ts"));
      const baseTag = `lyx-mixed-${runId}:build-${source.slice(0, 12)}`,
        tag = `lyx-mixed-${runId}:run-${source.slice(0, 12)}`;
      tags.push(baseTag, tag);
      await cmd(
        "docker",
        [
          "build",
          "--pull=false",
          "--target",
          "build",
          "--label",
          `org.opencontainers.image.revision=${source}`,
          ...labels,
          "--build-arg",
          `LYX_BUILD=sha-${source.slice(0, 12)}`,
          "-f",
          join(dir, "infra/docker/server/Dockerfile"),
          "-t",
          baseTag,
          dir,
        ],
        240_000,
      );
      const base = JSON.parse(await docker(["image", "inspect", "--format", IMAGE, baseTag]));
      requireFact(
        /^sha256:[a-f0-9]{64}$/.test(base.id) &&
          base.labels?.["org.opencontainers.image.revision"] === source,
        "image-identity",
      );
      const layer = join(privateRoot, `layer-${source}`);
      mkdirSync(layer, { mode: 0o700 });
      writeFileSync(join(layer, ".mixed-source-sha"), `${source}\n`, { mode: 0o600, flag: "wx" });
      writeFileSync(
        join(layer, "Dockerfile"),
        `FROM ${base.id}\nCOPY .mixed-source-sha /repo/.mixed-source-sha\nLABEL org.opencontainers.image.revision="${source}" lyx.mixed.run="${runId}" lyx.mixed.owner="${nonce}"\n`,
        { mode: 0o600, flag: "wx" },
      );
      await cmd("docker", ["build", "--pull=false", "-t", tag, layer], 30_000);
      const image = JSON.parse(await docker(["image", "inspect", "--format", IMAGE, tag]));
      requireFact(
        /^sha256:[a-f0-9]{64}$/.test(image.id) &&
          image.labels?.["org.opencontainers.image.revision"] === source,
        "image-identity",
      );
      const result = {
        source,
        imageId: image.id,
        driverHash: createHash("sha256").update(driver).digest("hex"),
      };
      builds.set(source, result);
      return result;
    },
    async createOwner(source) {
      networkId = await docker([
        "network",
        "create",
        "--internal",
        ...labels,
        `lyx-mixed-${runId}`,
      ]);
      requireFact(ID.test(networkId), "network-identity");
      for (const service of ["postgres", "redis", "minio"]) {
        const row = await inspect(dependencies[service].id);
        assertDependency(row, service);
        await docker([
          "network",
          "connect",
          "--alias",
          `lyx-mixed-${runId}-${service}`,
          networkId,
          row.id,
        ]);
        connected.push(row.id);
      }
      const identity = { runId, source, nonce, networkId };
      const receipt = {
        schemaVersion: 1,
        ...identity,
        containers: Object.fromEntries(
          Object.entries(dependencies).map(([key, value]) => [key, value.id]),
        ),
      };
      const entry = await launch("owner", source);
      const result = await entry.peer.call(
        "owner.init",
        { runId, source, ownerNetwork: { expected: identity, receipt } },
        budget.remaining(false, 30_000),
      );
      requireFact(
        result?.protocol === PROTOCOL &&
          result.source === source &&
          Number.isSafeInteger(result.pid) &&
          object(result.attachBase),
        "owner-init",
      );
      return { source: result.source, pid: result.pid, attachBase: result.attachBase };
    },
    async createPhase(source, phase, attach) {
      const entry = await launch("phase", source);
      const started = await entry.peer.call(
        "phase.start",
        { source, phase, attach },
        budget.remaining(false, 30_000),
      );
      return {
        started,
        call: (method, params = {}, cap = 30_000) =>
          entry.peer.call(method, params, budget.remaining(false, cap)),
        close: () => closePeer(entry),
      };
    },
    cleanup() {
      return (cleanupDone ??= (async () => {
        let ok = true,
          sharedPreserved = true;
        signal?.removeEventListener("abort", cancel);
        const phaseEntry = active;
        if (phaseEntry) {
          try {
            await closePeer(phaseEntry, true);
          } catch {
            ok = false;
          }
          try {
            await removeContainer(phaseEntry);
          } catch {
            ok = false;
          }
          if (!phaseEntry.removed) ok = false;
        }
        if (owner && (!phaseEntry || phaseEntry.removed) && !owner.closed)
          try {
            await closePeer(owner, true);
          } catch {
            ok = false;
          }
        for (const entry of containers)
          try {
            await removeContainer(entry);
          } catch {
            ok = false;
          }
        for (const id of [...connected].reverse())
          try {
            const row = JSON.parse(
              await docker(["network", "inspect", "--format", "{{json .}}", networkId], 5000, true),
            );
            requireFact(
              row.Id === networkId &&
                Object.entries(ownLabels(runId, nonce)).every(
                  ([key, value]) => row.Labels?.[key] === value,
                ),
              "network-ownership",
            );
            await docker(["network", "disconnect", networkId, id], 5000, true);
          } catch {
            ok = false;
          }
        if (networkId)
          try {
            const row = JSON.parse(
              await docker(["network", "inspect", "--format", "{{json .}}", networkId], 5000, true),
            );
            requireFact(
              row.Id === networkId &&
                Object.entries(ownLabels(runId, nonce)).every(
                  ([key, value]) => row.Labels?.[key] === value,
                ),
              "network-ownership",
            );
            await docker(["network", "rm", networkId], 5000, true);
          } catch {
            ok = false;
          }
        for (const [service, before] of Object.entries(dependencies))
          try {
            const after = await inspect(before.id, true);
            assertDependency(after, service);
            requireFact(
              Object.entries(before.networks).every(
                ([name, value]) => after.networks[name]?.NetworkID === value.NetworkID,
              ),
              "dependency-identity",
            );
          } catch {
            ok = false;
            sharedPreserved = false;
          }
        for (const tag of tags)
          try {
            const present = await docker(
              ["image", "ls", "--no-trunc", "--filter", `reference=${tag}`, "--format", "{{.ID}}"],
              5000,
              true,
            );
            if (!present) continue;
            const row = JSON.parse(
              await docker(["image", "inspect", "--format", IMAGE, tag], 5000, true),
            );
            requireFact(
              Object.entries(ownLabels(runId, nonce)).every(
                ([key, value]) => row.labels?.[key] === value,
              ),
              "image-ownership",
            );
            await docker(["image", "rm", tag], 5000, true);
          } catch {
            ok = false;
          }
        try {
          rmSync(privateRoot, { recursive: true, force: true });
        } catch {
          ok = false;
        }
        return {
          ok: ok && (!owner || (scopeClean && bucketsClean)),
          ...(owner
            ? { scopeAbsenceVerified: scopeClean, bucketsAbsent: bucketsClean }
            : { ownerStarted: false }),
          sharedDependenciesPreserved: sharedPreserved,
        };
      })());
    },
  };
}
