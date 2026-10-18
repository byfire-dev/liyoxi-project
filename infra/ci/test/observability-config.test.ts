import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir, repoRoot } from "./helpers.js";

interface Secret {
  file: string;
  uid: number;
  required: boolean;
  services: string;
  env: string;
  what: string;
}
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
const manifest = (JSON.parse(read("infra/deploy/secrets.manifest.json")) as { secrets: Secret[] })
  .secrets;
const IDS = [
  "cos",
  "ci",
  "asr",
  "asr-callback",
  "ocr",
  "mail",
  "llm",
  "media-production",
  "client-errors",
  "alerts",
  "server-errors",
  "wechat",
];
const OPTIONAL = [
  "cos-signer-keys.json",
  "cos-sts-issuer-keys.json",
  "cos-worker-keys.json",
  "ci-worker-keys.json",
  "ci-callback-key",
  "asr-tencent.json",
  "asr-callback-key",
  "ocr-tencent.json",
  "mail-tencent.json",
  "llm-domestic.json",
  "media-production.json",
  "client-error-projects.json",
  "alerts.json",
  "server-errors.json",
  "wechat-secret",
  "wechat-message-token",
  "wechat-message-aes-key",
];
const CORE = [
  "postgres-password",
  "migrator-database-url",
  "database-url",
  "backup-database-url",
  "redis-auth.conf",
  "redis-url",
  "data-keys.json",
  "bidx-keys.json",
  "auth-keys.json",
];
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const marker = "fixture-only-observability";
function world() {
  const temp = makeTempDir("lyx-observability-config-");
  cleanups.push(temp.cleanup);
  chmodSync(temp.dir, 0o700);
  const secrets = join(temp.dir, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  for (const file of CORE) writeFileSync(join(secrets, file), marker, { mode: 0o400 });
  writeFileSync(
    join(temp.dir, "docker"),
    `#!/bin/bash\nprintf '%s\\n' "$*" >>"$OBSERVABILITY_CALLS"\n`,
  );
  chmodSync(join(temp.dir, "docker"), 0o755);
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("LYX_") && key !== "SSH_ORIGINAL_COMMAND",
      ),
    ),
    PATH: `${temp.dir}:${process.env.PATH ?? ""}`,
    LYX_SRC: repoRoot,
    LYX_NODE_HOME: temp.dir,
    LYX_SECRETS_DIR: secrets,
    LYX_NODE_PROJECT: "lyxt-observability",
    LYX_NODE_PREFIX: "lyxt-observability",
    LYX_SECRETS_SKIP_OWNER: "1",
    OBSERVABILITY_CALLS: join(temp.dir, "calls"),
  };
  return { dir: temp.dir, secrets, env };
}
function run(w: ReturnType<typeof world>, script: string, args: string[] = [], selector?: string) {
  const result = spawnSync(
    "bash",
    script === "selector"
      ? ["-c", '. "$LYX_SRC/infra/deploy/lib.sh"; node_providers']
      : [join(repoRoot, script), ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...w.env, ...(selector === undefined ? {} : { LYX_NODE_PROVIDERS: selector }) },
    },
  );
  if (result.error) throw result.error;
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls: existsSync(w.env.OBSERVABILITY_CALLS)
      ? readFileSync(w.env.OBSERVABILITY_CALLS, "utf8")
      : "",
  };
}
function optional(w: ReturnType<typeof world>, file: string, value = marker) {
  const path = join(w.secrets, file);
  if (existsSync(path)) chmodSync(path, 0o600);
  writeFileSync(path, value, { mode: 0o400 });
  chmodSync(path, 0o400);
  return path;
}

describe("W2-27b1 固定观测FILE接线", () => {
  it("完整provider与optional精确登记，三观测组最小角色/FILE挂载且base不借用", () => {
    const w = world();
    expect(
      readdirSync(join(repoRoot, "infra/compose/providers"))
        .filter((name) => name.endsWith(".yml"))
        .map((name) => name.slice(0, -4))
        .sort(),
    ).toEqual([...IDS].sort());
    expect(
      manifest
        .filter((one) => one.required)
        .map((one) => one.file)
        .sort(),
    ).toEqual([...CORE].sort());
    expect(
      manifest
        .filter((one) => !one.required)
        .map((one) => one.file)
        .sort(),
    ).toEqual([...OPTIONAL].sort());
    expect(run(w, "selector", [], IDS.join(" "))).toMatchObject({
      status: 0,
      output: `${IDS.join(" ")}\n`,
    });
    for (const group of [
      {
        id: "client-errors",
        file: "client-error-projects.json",
        env: "CLIENT_ERROR_PROJECTS_FILE",
        roles: ["api", "check-env"],
      },
      { id: "alerts", file: "alerts.json", env: "ALERTS_FILE", roles: ["worker", "check-env"] },
      {
        id: "server-errors",
        file: "server-errors.json",
        env: "SERVER_ERRORS_FILE",
        roles: ["api", "worker", "check-env"],
      },
    ]) {
      expect(manifest.find((one) => one.file === group.file)).toMatchObject({
        file: group.file,
        uid: 1000,
        required: false,
        env: group.env,
        services: group.roles.join(" "),
      });
      const source = read(`infra/compose/providers/${group.id}.yml`);
      expect([...source.matchAll(/^ {2}([a-z-]+):$/gm)].map((row) => row[1])).toEqual(group.roles);
      expect(source).toContain(`  ${group.file}:\n    file: \${LYX_SECRETS_DIR:?}/${group.file}\n`);
      expect(
        source.match(new RegExp(`${group.env}: /run/secrets/${group.file}`, "g")),
      ).toHaveLength(group.roles.length);
      expect(source.match(new RegExp(`- ${group.file}`, "g"))).toHaveLength(group.roles.length);
      expect(source).not.toMatch(/env_file:|https?:\/\/|volumes:|networks:|depends_on:/);
      expect(read("infra/compose/node.yml")).not.toContain(group.file);
      expect(read("infra/compose/node.yml")).not.toContain(group.env);
      const mapped = spawnSync(
        "bash",
        ["-c", '. "$LYX_SRC/infra/deploy/lib.sh"; provider_files "$1"', "fixture", group.id],
        { env: w.env, encoding: "utf8" },
      );
      expect(mapped.status).toBe(0);
      expect(mapped.stdout).toBe(`${group.file}\n`);
    }
  });

  it("默认/显式关闭保持不挂载，拒绝未知重复，选中才需本角色文件且属性检查不泄露内容", () => {
    const w = world();
    expect(run(w, "infra/deploy/node-step.sh", ["check-env", "local"])).toMatchObject({
      status: 0,
    });
    expect(readFileSync(w.env.OBSERVABILITY_CALLS, "utf8")).not.toMatch(
      /client-errors.yml|alerts.yml/,
    );
    rmSync(w.env.OBSERVABILITY_CALLS);
    writeFileSync(join(w.dir, "node.env"), "LYX_NODE_PROVIDERS=client-errors alerts\n");
    expect(run(w, "selector")).toMatchObject({ status: 0, output: "client-errors alerts\n" });
    expect(run(w, "infra/deploy/check-secrets.sh", [], "").status).toBe(0);
    for (const selector of [
      "alerts alerts",
      "client-errors client-errors",
      "unknown",
      "../alerts",
      '"alerts"',
      "client-errors\nalerts",
    ]) {
      expect(run(w, "infra/deploy/node-step.sh", ["check-env", "local"], selector).status).not.toBe(
        0,
      );
      expect(existsSync(w.env.OBSERVABILITY_CALLS)).toBe(false);
    }
    const missing = run(w, "infra/deploy/node-step.sh", ["check-env", "local"]);
    expect(missing.status).toBe(1);
    expect(missing.output).toContain("client-error-projects.json");
    expect(missing.output).toContain("alerts.json");
    expect(missing.calls).toBe("");
    optional(w, "alerts.json");
    expect(run(w, "infra/deploy/check-secrets.sh", ["--service", "worker"]).status).toBe(0);
    expect(run(w, "infra/deploy/check-secrets.sh", ["--service", "api"]).status).toBe(1);
    optional(w, "client-error-projects.json");
    const configured = run(w, "infra/deploy/node-step.sh", ["check-env", "local"]);
    expect(configured.status).toBe(0);
    expect(configured.calls).toContain("providers/client-errors.yml -f");
    expect(configured.calls).toContain("providers/alerts.yml run --rm --no-deps -T check-env");
    expect(configured.calls).not.toContain(marker);
    expect(configured.output).not.toContain(marker);
    const file = join(w.secrets, "alerts.json");
    chmodSync(file, 0o600);
    expect(run(w, "infra/deploy/check-secrets.sh", ["--service", "worker"]).status).toBe(1);
    optional(w, "alerts.json", "");
    expect(run(w, "infra/deploy/check-secrets.sh", ["--service", "worker"]).status).toBe(1);
    rmSync(file);
    symlinkSync(join(w.secrets, "client-error-projects.json"), file);
    const linked = run(w, "infra/deploy/check-secrets.sh", ["--service", "worker"]);
    expect(linked.status).toBe(1);
    expect(linked.output).toContain("不是普通文件");
    expect(linked.output).not.toContain(marker);
  });

  it("既有loadEnv实际解析两JSON，默认未配，HTTP/URL机器人/重复号码/超长/明文拒绝且零值回显", () => {
    const w = world();
    const client = optional(
      w,
      "client-error-projects.json",
      JSON.stringify({
        projects: [
          {
            dsn: "https://public@errors.example.invalid/1",
            upstreamDsn: "https://public@upstream.example.invalid/2",
          },
        ],
      }),
    );
    const alerts = optional(
      w,
      "alerts.json",
      JSON.stringify({ robotKey: "fixture-only", oncallPhones: ["19900000009"], p2Immediate: [] }),
    );
    const invalid = (name: string, value: string) => {
      const path = join(w.secrets, name);
      writeFileSync(path, value, { mode: 0o400 });
      return path;
    };
    const core = {
      APP_ENV: "test",
      DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1/lyx_fixture",
      REDIS_URL: "redis://127.0.0.1/0",
    };
    const sources = [
      core,
      { ...core, CLIENT_ERROR_PROJECTS_FILE: client, ALERTS_FILE: alerts },
      {
        ...core,
        CLIENT_ERROR_PROJECTS_FILE: invalid(
          "client-http.json",
          JSON.stringify({ projects: [{ dsn: "http://public@errors.example.invalid/1" }] }),
        ),
      },
      {
        ...core,
        ALERTS_FILE: invalid(
          "robot-url.json",
          JSON.stringify({ robotKey: "https://example.invalid/key" }),
        ),
      },
      {
        ...core,
        ALERTS_FILE: invalid(
          "phone-duplicate.json",
          JSON.stringify({ oncallPhones: ["19900000009", "19900000009"] }),
        ),
      },
      { ...core, ALERTS_FILE: invalid("alerts-large.json", "{}" + " ".repeat(4096)) },
      { ...core, CLIENT_ERROR_PROJECTS: marker },
      { ...core, ALERTS: marker },
    ];
    const cases = join(w.dir, "cases.json");
    writeFileSync(cases, JSON.stringify(sources), { mode: 0o600 });
    const parsed = spawnSync(
      process.execPath,
      [
        join(repoRoot, "packages/services/node_modules/tsx/dist/cli.mjs"),
        "--tsconfig",
        join(repoRoot, "packages/services/tsconfig.json"),
        join(repoRoot, "infra/ci/observability-env-fixture.mjs"),
        cases,
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH } },
    );
    expect(parsed.status, parsed.stderr).toBe(0);
    const results = JSON.parse(parsed.stdout) as Array<{
      ok: boolean;
      clientErrors?: boolean;
      alerts?: boolean;
      keys?: string[];
    }>;
    expect(results[0]).toEqual({ ok: true, clientErrors: false, alerts: false });
    expect(results[1]).toEqual({ ok: true, clientErrors: true, alerts: true });
    expect(results.slice(2).map((row) => row.ok)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(results[2]!.keys).toContain("CLIENT_ERROR_PROJECTS_FILE");
    for (const index of [3, 4, 5]) expect(results[index]!.keys).toContain("ALERTS_FILE");
    expect(results[6]!.keys).toContain("CLIENT_ERROR_PROJECTS");
    expect(results[7]!.keys).toContain("ALERTS");
    expect(parsed.stdout + parsed.stderr).not.toMatch(
      /fixture-only|19900000009|example\.invalid|postgresql:\/\//,
    );
    expect(existsSync(w.env.OBSERVABILITY_CALLS)).toBe(false);
  });
});
