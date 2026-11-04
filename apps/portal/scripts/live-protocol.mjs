// Test-process boundary only. No application imports, credentials or arbitrary log payloads.
import { isAbsolute, join } from "node:path";

const RUN_ID = /^[a-f0-9]{12}$/;
const VERSION = /^[A-Za-z0-9._-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES = [
  "scope",
  "database",
  "agreements",
  "runtime",
  "http",
  "identities",
  "control",
  "closing",
];
const CODES = ["STARTED", "READY", "FAILED", "CLOSED", "OWNERSHIP_CHANGED"];

export function boundaryFailure() {
  // Never put rejected input or the original exception in an error/cause.
  return new Error("PORTAL_LIVE_BOUNDARY_REJECTED");
}

function exact(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw boundaryFailure();
}

export function assertRunId(value) {
  if (typeof value !== "string" || !RUN_ID.test(value)) throw boundaryFailure();
  return value;
}

export function assertVersion(value) {
  if (typeof value !== "string" || !VERSION.test(value)) throw boundaryFailure();
  return value;
}

export function assertPort(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw boundaryFailure();
  return value;
}

export function portalOrigin(value) {
  if (typeof value !== "string") throw boundaryFailure();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw boundaryFailure();
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "portal.localhost" ||
    !url.port ||
    url.username ||
    url.password ||
    value !== url.origin ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw boundaryFailure();
  assertPort(Number(url.port));
  return value;
}

export function startMessage({ runId, portalOrigin: origin, version, directory }) {
  assertRunId(runId);
  assertVersion(version);
  portalOrigin(origin);
  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    ![join("/tmp", `lyx-portal-${runId}`), join("/private/tmp", `lyx-portal-${runId}`)].includes(
      directory,
    )
  )
    throw boundaryFailure();
  return {
    v: 1,
    type: "start",
    runId,
    portalOrigin: origin,
    version,
    controlSocketPath: join(directory, "control.sock"),
  };
}

/** Only bounded public facts cross IPC; the API owns every authentication credential. */
export function childEvent(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw boundaryFailure();
  if (value.event === "closed") {
    exact(value, ["v", "event", "runId"]);
    if (value.v !== 1 || value.runId !== expected.runId) throw boundaryFailure();
    return { v: 1, event: "closed", runId: value.runId };
  }
  if (value.event === "failed") {
    exact(value, ["v", "event", "stage", "code"]);
    if (
      value.v !== 1 ||
      !STAGES.includes(value.stage) ||
      !["START_FAILED", "CLOSE_FAILED"].includes(value.code)
    )
      throw boundaryFailure();
    return { v: 1, event: "failed", stage: value.stage, code: value.code };
  }
  exact(value, ["v", "event", "runId", "version", "apiPort", "controlSocketPath", "actors"]);
  if (
    value.v !== 1 ||
    value.event !== "ready" ||
    value.runId !== expected.runId ||
    value.version !== expected.version ||
    value.controlSocketPath !== expected.controlSocketPath
  )
    throw boundaryFailure();
  assertPort(value.apiPort);
  exact(value.actors, ["owner", "clerk", "otherOwner"]);
  const actors = {};
  for (const name of ["owner", "clerk", "otherOwner"]) {
    const actor = value.actors[name];
    exact(actor, ["entityId", "storeId"]);
    if (
      typeof actor.entityId !== "string" ||
      !UUID.test(actor.entityId) ||
      typeof actor.storeId !== "string" ||
      !UUID.test(actor.storeId)
    )
      throw boundaryFailure();
    actors[name] = { entityId: actor.entityId, storeId: actor.storeId };
  }
  if (
    actors.owner.entityId !== actors.clerk.entityId ||
    actors.owner.storeId !== actors.clerk.storeId ||
    actors.owner.entityId === actors.otherOwner.entityId ||
    actors.owner.storeId === actors.otherOwner.storeId
  )
    throw boundaryFailure();
  return {
    v: 1,
    event: "ready",
    runId: value.runId,
    version: value.version,
    apiPort: value.apiPort,
    controlSocketPath: value.controlSocketPath,
    actors,
  };
}

/** A fresh gate is created for one child only. A duplicate ready cannot replace its upstream. */
export function createHandshake(expected) {
  let phase = "starting";
  return {
    get phase() {
      return phase;
    },
    receive(raw) {
      const event = childEvent(raw, expected);
      if (event.event === "ready") {
        if (phase !== "starting") throw boundaryFailure();
        phase = "ready";
      } else if (event.event === "failed") {
        if (phase === "closed" || phase === "failed") throw boundaryFailure();
        phase = "failed";
      } else {
        if (phase !== "stopping" && phase !== "failed") throw boundaryFailure();
        phase = "closed";
      }
      return event;
    },
    stop() {
      if (phase !== "closed" && phase !== "failed") phase = "stopping";
      return { v: 1, type: "stop" };
    },
  };
}

export function diagnosticLine(value) {
  exact(value, ["stage", "code"]);
  if (!STAGES.includes(value.stage) || !CODES.includes(value.code)) throw boundaryFailure();
  return `${JSON.stringify({ event: "portal.live.diagnostic", stage: value.stage, code: value.code })}\n`;
}

export function resultLine(value) {
  exact(value, ["runId", "passed", "failed", "durationMs", "cleanup"]);
  assertRunId(value.runId);
  if (
    ![value.passed, value.failed].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 100) ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    !["confirmed", "unconfirmed"].includes(value.cleanup)
  )
    throw boundaryFailure();
  return `${JSON.stringify({
    event: "portal.live.result",
    runId: value.runId,
    passed: value.passed,
    failed: value.failed,
    durationMs: Math.round(value.durationMs),
    cleanup: value.cleanup,
  })}\n`;
}

function localConnection(value, protocols) {
  if (typeof value !== "string") throw boundaryFailure();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw boundaryFailure();
  }
  if (
    !protocols.includes(url.protocol) ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.hash
  )
    throw boundaryFailure();
  return value;
}

export function apiEnvironment(source) {
  const env = {
    APP_ENV: "test",
    LOG_LEVEL: "warn",
    DATABASE_URL: localConnection(source.DATABASE_URL, ["postgres:", "postgresql:"]),
    REDIS_URL: localConnection(source.REDIS_URL, ["redis:"]),
  };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"])
    if (typeof source[key] === "string") env[key] = source[key];
  return env;
}
