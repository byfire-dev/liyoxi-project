import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  assertProject,
  envelope,
  ERROR_HOST,
  receiverOverlay,
  runObservability,
  upstreamDsn,
  verifyReceipts,
  waitForGatewayReady,
} from "../../deploy/observability-rehearsal.mjs";
import { TEST_CA, TEST_CERT, TEST_KEY } from "../../deploy/test/fixtures/observability-tls.mjs";
import { repoRoot } from "./helpers.js";

it("自有项目/只读测试CA/固定收件协议及停worker后失败恢复；纯检查不运行容器或网络", async () => {
  const project = "lyxrh-abc123";
  const dimension = `${project}/obs-abcdef`;
  for (const invalid of ["liyoxi-node", "lyxrh-abc12", "lyxrh-ABC123", "../lyxrh-abc123"])
    expect(() => assertProject(invalid)).toThrow();
  const ca = new X509Certificate(TEST_CA),
    leaf = new X509Certificate(TEST_CERT);
  expect(leaf.verify(ca.publicKey)).toBe(true);
  expect(leaf.checkPrivateKey(createPrivateKey(TEST_KEY))).toBe(true);
  for (const host of [ERROR_HOST, "qyapi.weixin.qq.com"]) expect(leaf.checkHost(host)).toBe(host);
  expect(leaf.checkHost("wrong.lyx-rehearse.invalid")).toBeUndefined();
  const overlay = receiverOverlay({
    project,
    home: "/tmp/lyx-rehearse-fixture",
    image: "liyoxi/server:local",
  });
  expect(Object.keys(overlay.services)).toEqual(["api", "worker", "receiver"]);
  expect(overlay.services.api).toEqual(overlay.services.worker);
  expect(overlay.services.api.environment).toEqual({ NODE_EXTRA_CA_CERTS: "/rehearsal/ca.pem" });
  expect(overlay.services.api.volumes[0]).toMatch(/:ro$/);
  expect(overlay.services.receiver).not.toHaveProperty("ports");
  expect(overlay.services.receiver.networks.default.aliases).toContain("qyapi.weixin.qq.com");
  const ids = ["a".repeat(32), "b".repeat(32)] as const;
  const records = ids.map((id, index) => {
    const n = 101 + index;
    const event = JSON.stringify({
      event_id: id,
      exception: { values: [{ value: `rehearsal-${n} [redacted]` }] },
    });
    return {
      path: `/relay/api/${n}/envelope/`,
      host: ERROR_HOST,
      type: "application/x-sentry-envelope",
      auth: `Sentry sentry_version=7, sentry_key=upstream_fixture_${n}`,
      body: `${JSON.stringify({ dsn: upstreamDsn(n), event_id: id, sent_at: "2026-10-15T00:00:00Z" })}\n${JSON.stringify({ type: "event", length: Buffer.byteLength(event) })}\n${event}\n`,
    };
  });
  const robots = ["告警", "已恢复"].map((phase) => ({
    path: `/cgi-bin/webhook/send?key=${project}_robot`,
    host: "qyapi.weixin.qq.com",
    type: "application/json; charset=utf-8",
    body: JSON.stringify({
      msgtype: "text",
      text: { content: `狸有戏运维\n${phase} P2 webhook.backlog:${dimension}` },
    }),
  }));
  const valid = [...records, ...robots];
  const expected = { project, dimension, eventIds: ids, alerts: true };
  expect(verifyReceipts(valid, expected)).toMatchObject({
    envelopes: 2,
    targetRobots: 2,
    backgroundRobots: 0,
    total: 4,
  });
  const background = {
    ...robots[0],
    body: JSON.stringify({
      msgtype: "text",
      text: { content: "狸有戏运维\n已恢复 P2 recurring.missed:prior" },
    }),
  };
  const prefixCollision = {
    ...robots[0],
    body: robots[0]!.body.replace("obs-abcdef", "obs-abcdef-extra"),
  };
  expect(verifyReceipts([...valid, background, prefixCollision], expected)).toMatchObject({
    targetRobots: 2,
    backgroundRobots: 2,
    total: 6,
  });
  expect(() =>
    verifyReceipts(valid, { ...expected, dimension: `${project}/obs-123456` }),
  ).toThrow();
  for (const broken of [
    [...valid, records[0]],
    [{ ...records[0], auth: "Sentry sentry_key=request-controlled" }, ...valid.slice(1)],
    [{ ...records[0], host: "other.invalid" }, ...valid.slice(1)],
    [
      { ...records[0], body: records[0]!.body.replace('"length":', '"length":1,"ignored":') },
      ...valid.slice(1),
    ],
    [
      { ...records[0], body: records[0]!.body.replace("[redacted]", "fixture_secret") },
      ...valid.slice(1),
    ],
    [...records, robots[1], robots[0]],
    [...valid, robots[0]],
    [
      ...records,
      { ...robots[0], body: robots[0]!.body.replace("obs-abcdef", "obs-123456") },
      robots[1],
    ],
    [...valid, background, background, background, background, background],
  ])
    expect(() => verifyReceipts(broken, expected)).toThrow();
  const wire = envelope(101, ids[0]).split("\n");
  expect(JSON.parse(wire[1]!).length).toBe(Buffer.byteLength(wire[2]!));
  expect(JSON.parse(wire[2]!).exception.values[0].stack).toContain("public.js");

  for (const status of [200, 502]) {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date", "performance"] });
    try {
      const times: number[] = [];
      const pending = waitForGatewayReady(
        async () => {
          times.push(performance.now());
          return { status };
        },
        "api.localhost",
        "configured",
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(times).toEqual([]);
      await vi.runAllTimersAsync();
      const seen = await pending;
      expect(times[0]).toBe(10_001);
      expect(performance.now()).toBeLessThanOrEqual(15_000);
      if (status === 200) expect(seen).toBeUndefined();
      else expect((seen as Error).message).toBe("观测错误接口未就绪:configured:status=502");
    } finally {
      vi.useRealTimers();
    }
  }

  for (const readiness of ["eventually", "timeout"] as const) {
    const home = mkdtempSync(join(tmpdir(), "lyx-rehearse-ready-"));
    mkdirSync(join(home, "secrets"));
    const requests: { method: string; timeoutMs?: number }[] = [];
    const failure = new Error("pure stop-after-ready-and-posts");
    let ready = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "Date", "performance"] });
    try {
      const start = performance.now();
      const pending = runObservability({
        root: repoRoot,
        home,
        env: {
          LYX_NODE_PROJECT: project,
          LYX_NODE_PREFIX: project,
          LYX_NODE_PROVIDERS: "",
          LYX_NODE_HOME: home,
          LYX_SECRETS_DIR: join(home, "secrets"),
        },
        config: { tag: "sha-cccccccccccc", images: { server: "liyoxi/server:sha-cccccccccccc" } },
        hosts: { api: "api.localhost", admin: "admin.localhost" },
        flags: { errors: true, alerts: true },
        request: async (host, path, options) => {
          requests.push(options);
          if (options.method === "GET") {
            expect([host, path, options.headers.Origin]).toEqual([
              "api.localhost",
              "/readyz",
              "http://api.localhost",
            ]);
            ready = readiness === "eventually" && requests.length === 2;
            return { status: ready ? 200 : 502 };
          }
          expect(ready).toBe(true);
          return { status: 202 };
        },
        bootstrap: () => {
          throw failure;
        },
        step: () => {
          throw new Error("pure readiness must not stop/start worker");
        },
        run: (args) => ({
          status: 0,
          stderr: "",
          stdout:
            args[0] === "inspect"
              ? JSON.stringify([
                  {
                    Config: {
                      Labels: {
                        "com.docker.compose.project": project,
                        "com.docker.compose.service": args.at(-1)!.replace(`${project}-`, ""),
                      },
                    },
                  },
                ])
              : args[0] === "container"
                ? ""
                : JSON.stringify({ evt: "telemetry.forward", outcome: "unconfigured" }),
        }),
      }).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const seen = await pending;
      expect(performance.now() - start).toBeLessThanOrEqual(15_000);
      expect(
        requests
          .filter((one) => one.method === "GET")
          .every((one) => one.timeoutMs! > 0 && one.timeoutMs! <= 1_000),
      ).toBe(true);
      expect(requests.filter((one) => one.method === "POST")).toHaveLength(
        readiness === "eventually" ? 2 : 0,
      );
      if (readiness === "eventually") expect(seen).toBe(failure);
      else expect((seen as Error).message).toBe("观测错误接口未就绪:default:status=502");
    } finally {
      vi.useRealTimers();
      rmSync(home, { recursive: true, force: true });
    }
  }

  const tag = "sha-cccccccccccc";
  for (const mode of ["absent", "rm-fails", "foreign", "create-fails"] as const) {
    const home = mkdtempSync(join(tmpdir(), "lyx-rehearse-pure-"));
    mkdirSync(join(home, "secrets"));
    const env = {
      LYX_NODE_PROJECT: project,
      LYX_NODE_PREFIX: project,
      LYX_NODE_PROVIDERS: "",
      LYX_NODE_HOME: home,
      LYX_SECRETS_DIR: join(home, "secrets"),
    };
    const steps: string[][] = [],
      commands: string[][] = [],
      requests: unknown[][] = [];
    const fixtureId = "c".repeat(64),
      receiverId = "d".repeat(64);
    const failure = new Error("pure fixture stop-before-enable");
    let bootstrapTag: string | undefined;
    try {
      const seen = await runObservability({
        root: repoRoot,
        home,
        env,
        config: { tag, images: { server: `liyoxi/server:${tag}` } },
        hosts: { api: "api.localhost", admin: "admin.localhost" },
        flags: { errors: true, alerts: true },
        bootstrap: (_args, source) => {
          bootstrapTag = source.LYX_TAG;
        },
        request: async (...args: unknown[]) => {
          requests.push(args);
          return { status: args[1] === "/readyz" ? 200 : 202 };
        },
        step: (...args: string[]) => {
          steps.push(args);
          if (args[0] === "check-env" && mode !== "create-fails") throw failure;
        },
        run: (args: string[]) => {
          commands.push(args);
          let stdout = "",
            status = 0;
          const last = args.at(-1)!;
          if (args[0] === "container")
            stdout =
              mode === "absent"
                ? ""
                : args.join().includes("observability-fixture")
                  ? fixtureId
                  : receiverId;
          else if (args[0] === "inspect") {
            const fixture = last === fixtureId;
            const cleanup = fixture || last === receiverId;
            const service = cleanup
              ? fixture
                ? "worker"
                : "receiver"
              : last.replace(`${project}-`, "");
            stdout = JSON.stringify([
              {
                Id: last,
                Name: `/${project}-${fixture ? "observability-fixture" : service}`,
                Config: {
                  Labels: {
                    "com.docker.compose.project":
                      mode === "foreign" && fixture ? "another-project" : project,
                    "com.docker.compose.service": service,
                    "io.liyoxi.observability": project,
                  },
                },
              },
            ]);
          } else if (args[0] === "rm") status = mode === "rm-fails" && last === fixtureId ? 1 : 0;
          else {
            if (mode === "create-fails" && args.includes("create")) status = 1;
            stdout = JSON.stringify({ evt: "telemetry.forward", outcome: "unconfigured" });
          }
          return { status, stdout, stderr: "" };
        },
      }).catch((error: unknown) => error);
      if (mode === "create-fails") {
        expect(seen).toBeInstanceOf(Error);
        expect((seen as Error).message).toContain("Docker步骤失败:compose");
        expect(commands.find((args) => args.includes("create"))?.slice(-5)).toEqual([
          "create",
          "--no-build",
          "--pull",
          "never",
          "worker",
        ]);
      } else if (mode === "absent") expect(seen).toBe(failure);
      else {
        expect(seen).toBeInstanceOf(AggregateError);
        expect((seen as AggregateError).errors).toContain(failure);
      }
      expect(bootstrapTag).toBe(tag);
      expect(steps).toEqual([
        ["stop", "worker"],
        ["check-env", tag],
        ["up", tag],
      ]);
      expect(commands.filter((args) => args[0] === "container")).toHaveLength(2);
      expect(commands.filter((args) => args[0] === "rm").map((args) => args.at(-1))).toEqual(
        mode === "absent" ? [] : mode === "foreign" ? [receiverId] : [fixtureId, receiverId],
      );
      expect(
        commands.some(
          (args) => args.includes("build") || args.includes("pull") || args.includes("prune"),
        ),
      ).toBe(false);
      expect(env.LYX_NODE_PROVIDERS).toBe("");
      expect(requests).toHaveLength(3);
      const admin = requests[2]![2] as { headers: Record<string, string> };
      expect(admin.headers).toMatchObject({
        Origin: "http://admin.localhost",
        "X-LYX-Admin": "1",
        "Content-Type": "application/x-sentry-envelope",
      });
      const file = JSON.parse(
        readFileSync(join(home, "secrets/client-error-projects.json"), "utf8"),
      );
      expect(file.projects.map((one: { upstreamDsn: string }) => one.upstreamDsn)).toEqual([
        upstreamDsn(101),
        upstreamDsn(102),
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});
