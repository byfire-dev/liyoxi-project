import assert from "node:assert/strict";
import test from "node:test";
import {
  apiEnvironment,
  childEvent,
  createHandshake,
  diagnosticLine,
  portalOrigin,
  resultLine,
  startMessage,
} from "./live-protocol.mjs";

const runId = "012345abcdef";
const start = startMessage({
  runId,
  portalOrigin: "https://portal.localhost:4443",
  version: "sha-fixture",
  directory: `/tmp/lyx-portal-${runId}`,
});
const id = (n) => `01950000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const ready = {
  v: 1,
  event: "ready",
  runId,
  version: start.version,
  apiPort: 12345,
  controlSocketPath: start.controlSocketPath,
  actors: {
    owner: { entityId: id(1), storeId: id(2) },
    clerk: { entityId: id(1), storeId: id(2) },
    otherOwner: { entityId: id(3), storeId: id(4) },
  },
};
const rejected = (action) => assert.throws(action, /^Error: PORTAL_LIVE_BOUNDARY_REJECTED$/);

test("IPC readiness binds this run/version/socket and all three real actor scopes", () => {
  assert.deepEqual(childEvent(ready, start), ready);
  for (const invalid of [
    { ...ready, token: "public-counterexample" },
    { ...ready, runId: "ffffffffffff" },
    { ...ready, version: "another-build" },
    { ...ready, apiPort: 0 },
    { ...ready, apiPort: 65536 },
    { ...ready, controlSocketPath: "/tmp/unowned.sock" },
    {
      ...ready,
      actors: {
        ...ready.actors,
        owner: { ...ready.actors.owner, cookie: "public-counterexample" },
      },
    },
    { ...ready, actors: { ...ready.actors, clerk: ready.actors.otherOwner } },
    { ...ready, actors: { ...ready.actors, otherOwner: ready.actors.owner } },
  ])
    rejected(() => childEvent(invalid, start));
});

test("IPC lifecycle cannot swap a ready upstream or announce cleanup without stopping", () => {
  const gate = createHandshake(start);
  assert.equal(gate.receive(ready).event, "ready");
  rejected(() => gate.receive(ready));
  rejected(() => gate.receive({ v: 1, event: "closed", runId }));
  assert.deepEqual(gate.stop(), { v: 1, type: "stop" });
  assert.deepEqual(gate.stop(), { v: 1, type: "stop" });
  assert.equal(gate.receive({ v: 1, event: "closed", runId }).event, "closed");
  rejected(() => gate.receive(ready));
  const aborted = createHandshake(start);
  aborted.stop();
  rejected(() => aborted.receive(ready));
  assert.equal(
    aborted.receive({ v: 1, event: "failed", stage: "closing", code: "CLOSE_FAILED" }).event,
    "failed",
  );
  rejected(() =>
    childEvent(
      {
        v: 1,
        event: "failed",
        stage: "closing",
        code: "CLOSE_FAILED",
        cause: "public-counterexample",
      },
      start,
    ),
  );
});

test("exact HTTPS origin and canonical owned socket path have no redirect or external target", () => {
  assert.equal(portalOrigin(start.portalOrigin), start.portalOrigin);
  assert.equal(
    startMessage({
      runId,
      portalOrigin: start.portalOrigin,
      version: "dev",
      directory: `/private/tmp/lyx-portal-${runId}`,
    }).controlSocketPath,
    `/private/tmp/lyx-portal-${runId}/control.sock`,
  );
  for (const origin of [
    "http://portal.localhost:4443",
    "https://api.localhost:4443",
    "https://portal.localhost:4443/",
    "https://portal.localhost:4443?a=b",
    "https://user:pass@portal.localhost:4443",
    "https://portal.localhost",
  ])
    rejected(() => portalOrigin(origin));
  for (const directory of [
    "/tmp",
    `/tmp/lyx-portal-${runId}/../outside`,
    `/tmp/lyx-portal-${runId}-other`,
    `/home/lyx-portal-${runId}`,
  ])
    rejected(() =>
      startMessage({ runId, portalOrigin: start.portalOrigin, version: "dev", directory }),
    );
});

test("safe outputs reject a public sentinel instead of serializing unknown fields or exception causes", () => {
  const sentinel = "PUBLIC-PORTAL-ERROR-SENTINEL";
  const safe = diagnosticLine({ stage: "runtime", code: "READY" });
  assert.deepEqual(JSON.parse(safe), {
    event: "portal.live.diagnostic",
    stage: "runtime",
    code: "READY",
  });
  for (const invalid of [
    { stage: sentinel, code: "FAILED" },
    { stage: "runtime", code: "FAILED", message: sentinel },
    { stage: "runtime", code: "FAILED", cause: { token: sentinel } },
  ]) {
    let captured;
    try {
      diagnosticLine(invalid);
    } catch (error) {
      captured = error;
    }
    assert.ok(captured instanceof Error);
    assert.equal(`${captured.message}${JSON.stringify(captured)}`.includes(sentinel), false);
    assert.equal(Object.hasOwn(captured, "cause"), false);
  }
  const result = { runId, passed: 3, failed: 0, durationMs: 12.5, cleanup: "confirmed" };
  assert.equal(JSON.parse(resultLine(result)).durationMs, 13);
  for (const invalid of [
    { ...result, error: sentinel },
    { ...result, durationMs: Infinity },
    { ...result, durationMs: -1 },
    { ...result, passed: 1.5 },
    { ...result, cleanup: "assumed" },
  ])
    rejected(() => resultLine(invalid));
});

test("API environment keeps only explicit local test inputs and cannot inherit debug or provider secrets", () => {
  const local = {
    DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:5432/postgres",
    REDIS_URL: "redis://127.0.0.1:6379",
    PATH: "/usr/bin:/bin",
  };
  assert.deepEqual(
    apiEnvironment({
      ...local,
      APP_ENV: "prod",
      NODE_OPTIONS: "public-counterexample",
      VITEST: "true",
      DEBUG: "*",
      AUTH_KEY: "public-counterexample",
      PORTAL_PUBLIC_ORIGIN: "https://other.invalid",
    }),
    { ...local, APP_ENV: "test", LOG_LEVEL: "warn" },
  );
  for (const invalid of [
    { ...local, DATABASE_URL: "postgresql://example.invalid/db" },
    { ...local, REDIS_URL: "redis://example.invalid" },
    { ...local, REDIS_URL: "https://127.0.0.1" },
    { ...local, DATABASE_URL: undefined },
  ])
    rejected(() => apiEnvironment(invalid));
});
