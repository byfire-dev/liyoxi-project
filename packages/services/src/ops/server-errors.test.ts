import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { EnvError, loadEnv } from "../kernel/index.js";
import { createClientErrorForwarder } from "./client-errors.js";
import {
  createServerErrorReporter,
  drainServerErrors,
  installServerErrorHandlers,
} from "./server-errors.js";
import type { ServerErrorOptions } from "./server-errors.js";

const temp = mkdtempSync(join(tmpdir(), "lyx-server-errors-"));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const dsn = "https://fictionalserver@errors.example.invalid/42";
const base = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://lyx:fictional@localhost:5442/lyx_test",
  REDIS_URL: "redis://localhost:6389/0",
};
const clock = { now: () => new Date(Date.now()) },
  logger = { info: vi.fn() };
const instances: { close(): Promise<void> }[] = [];
function instance(extra: Partial<ServerErrorOptions> = {}) {
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
  const reporter = createServerErrorReporter({
    component: "api",
    release: "sha-0123456789ab",
    artifactRoot: new URL("file:///app/apps/api/dist/"),
    clock,
    logger,
    dsn,
    fetch: send,
    ...extra,
  });
  instances.push(reporter);
  return { reporter, send };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
});
afterEach(async () => {
  await Promise.all(instances.splice(0).map((one) => one.close()));
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));

it("W227服务端：独立FILE/角色/选择器与固定dist帧，默认关闭且零原始错误和PII", async () => {
  expect(loadEnv(base).SERVER_ERRORS).toBeUndefined();
  const file = join(temp, "server-errors.json"),
    config = { api: { dsn }, worker: { dsn: "https://fictionalworker@errors.example.invalid/43" } };
  writeFileSync(file, JSON.stringify(config));
  expect(loadEnv({ ...base, SERVER_ERRORS_FILE: file }).SERVER_ERRORS).toEqual(config);
  const link = join(temp, "link.json");
  symlinkSync(file, link);
  for (const input of [
    {},
    { api: { dsn: "http://fictional@host.invalid/1" } },
    { api: { dsn: `${dsn}?secret=raw` } },
    { api: { dsn }, extra: true },
    { api: { dsn, token: "raw" } },
  ]) {
    writeFileSync(file, JSON.stringify(input));
    expect(() => loadEnv({ ...base, SERVER_ERRORS_FILE: file })).toThrow(EnvError);
  }
  for (const source of [
    { SERVER_ERRORS: "raw-secret" },
    { SERVER_ERRORS_FILE: link },
    { SERVER_ERRORS_FILE: join(temp, "missing") },
  ]) {
    try {
      loadEnv({ ...base, ...source });
      throw new Error("must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect(String(error)).not.toMatch(/raw-secret|lyx-server-errors-|fictionalserver/);
    }
  }
  writeFileSync(file, " ".repeat(4_097));
  expect(() => loadEnv({ ...base, SERVER_ERRORS_FILE: file })).toThrow(EnvError);
  const manifest = JSON.parse(
    readFileSync(join(repo, "infra/deploy/secrets.manifest.json"), "utf8"),
  );
  expect(
    manifest.secrets.filter((one: { file: string }) => one.file === "server-errors.json"),
  ).toEqual([
    {
      file: "server-errors.json",
      uid: 1000,
      required: false,
      services: "api worker check-env",
      env: "SERVER_ERRORS_FILE",
      what: "可选服务端自身错误上游：API/worker仅消费本组件DSN，check-env离线校验",
    },
  ]);
  const overlay = readFileSync(join(repo, "infra/compose/providers/server-errors.yml"), "utf8");
  expect(overlay.match(/SERVER_ERRORS_FILE: \/run\/secrets\/server-errors.json/g)).toHaveLength(3);
  const selected = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; node_providers; provider_files server-errors',
      "fixture",
      join(repo, "infra/deploy/lib.sh"),
    ],
    {
      env: {
        PATH: process.env.PATH,
        LYX_SRC: repo,
        LYX_NODE_HOME: temp,
        LYX_NODE_PROVIDERS: "server-errors",
      },
      encoding: "utf8",
    },
  );
  expect(selected.status).toBe(0);
  expect(selected.stdout).toBe("server-errors\nserver-errors.json\n");
  const off = instance({ dsn: undefined });
  const getter = vi.fn(() => {
    throw new Error("must not inspect");
  });
  off.reporter.capture(Object.defineProperty({}, "stack", { get: getter }), "api.5xx");
  expect(getter).not.toHaveBeenCalled();
  expect(off.send).not.toHaveBeenCalled();
  const actual = instance();
  const error = Object.assign(new TypeError("SELECT password FROM raw_secret 13800138000"), {
    cause: { token: "raw-secret" },
    details: "raw-body",
  });
  error.stack =
    "TypeError: raw-secret\n at fail (/app/apps/api/dist/server.js:5:9)\n at file:///app/apps/api/dist/chunk-AB12CD34.js:1:2\n at /app/apps/worker/dist/index.js:1:1\n at /private/user/secret.js:1:1\n at /app/apps/api/dist/server.js?token=raw-secret:1:1\n at /app/apps/api/dist/../dist/server.js:1:1";
  actual.reporter.capture(error, "api.5xx", "private scope");
  await actual.reporter.drain();
  const raw = String(actual.send.mock.calls[0]![1]!.body),
    event = JSON.parse(raw.split("\n")[2]!);
  expect(event).toMatchObject({
    release: "sha-0123456789ab",
    dist: "api",
    tags: { kind: "api.5xx" },
  });
  expect(event.exception.values[0]).toEqual({
    type: "TypeError",
    value: "API request failed",
    stacktrace: {
      frames: [
        {
          filename: "chunk-AB12CD34.js",
          abs_path: "app:///api/chunk-AB12CD34.js",
          lineno: 1,
          colno: 2,
          in_app: true,
        },
        {
          filename: "server.js",
          abs_path: "app:///api/server.js",
          lineno: 5,
          colno: 9,
          in_app: true,
        },
      ],
    },
  });
  expect(raw).not.toMatch(
    /SELECT|password|raw-secret|raw_secret|raw-body|13800138000|private scope|\/app\/apps|\/private\/|cause|details|debug_meta/,
  );
});

it("W227服务端：共用原transport且实例独立，关闭取消无重试，客户端不能提交服务端映射帧", async () => {
  const stalled = instance({ fetch: vi.fn<typeof fetch>(() => new Promise(() => undefined)) });
  const healthy = instance({
    component: "worker",
    artifactRoot: new URL("file:///app/apps/worker/dist/"),
  });
  const error = new Error("fixture");
  error.stack = "at /app/apps/worker/dist/index.js:2:3";
  stalled.reporter.capture(error, "api.5xx");
  healthy.reporter.capture(error, "worker.loop", "timer_scan");
  await Promise.resolve();
  await healthy.reporter.drain();
  expect(healthy.reporter.snapshot()).toMatchObject({ forwarded: 1, failed: 0, closed: false });
  await stalled.reporter.close();
  expect(stalled.reporter.snapshot()).toMatchObject({ active: 0, queued: 0, closed: true });
  healthy.reporter.capture(undefined, "worker.delivery.retry");
  await healthy.reporter.drain();
  expect(healthy.send).toHaveBeenCalledTimes(2);
  healthy.reporter.capture(new Error("startup fixture"), "process.start");
  await drainServerErrors(healthy.reporter);
  expect(healthy.reporter.snapshot()).toMatchObject({ forwarded: 3, closed: false });
  await healthy.reporter.close();
  expect(healthy.reporter.snapshot().closed).toBe(true);
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
  const client = createClientErrorForwarder({
    clock,
    logger,
    projects: [{ dsn, upstreamDsn: dsn }],
    fetch: send,
  });
  instances.push(client);
  client.accept(
    `${JSON.stringify({ dsn })}\n{"type":"event"}\n${JSON.stringify({ dist: "api", exception: { values: [{ stacktrace: { frames: [{ filename: "server.js", abs_path: "app:///api/server.js", lineno: 1, colno: 1, in_app: true }] } }] } })}`,
  );
  await client.drain();
  expect(String(send.mock.calls[0]![1]!.body)).not.toContain("app:///api/");
  const fatal = instance({ dsn: undefined }),
    target = new EventEmitter(),
    exit = vi.fn(),
    log = vi.fn();
  vi.spyOn(fatal.reporter, "drain").mockImplementation(() => new Promise(() => undefined));
  const remove = installServerErrorHandlers({ reporter: fatal.reporter, target, exit, log });
  expect(remove.hasFailed()).toBe(false);
  target.emit("uncaughtException", new Error("fixture"));
  target.emit("unhandledRejection", new Error("duplicate"));
  expect(remove.hasFailed()).toBe(true); // normal shutdown只能保非零，不能覆盖这次fatal。
  await vi.advanceTimersByTimeAsync(1_999);
  expect(exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(log).toHaveBeenCalledOnce();
  remove();
  remove();
  expect(target.listenerCount("uncaughtException")).toBe(0);
  expect(target.listenerCount("unhandledRejection")).toBe(0);
});
