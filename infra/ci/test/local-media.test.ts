import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, repoRoot } from "./helpers.js";

const script = join(repoRoot, "infra/stack/local-media.mjs");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// 只使用仓库外临时文件和假的 docker；子进程不继承本机 Provider/密钥变量。
function fixture() {
  const temp = makeTempDir("lyx-local-media-");
  cleanups.push(temp.cleanup);
  const bin = join(temp.dir, "bin");
  const calls = join(temp.dir, "docker-calls");
  const directory = join(temp.dir, "generated");
  mkdirSync(bin);
  const docker = join(bin, "docker");
  writeFileSync(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_CALLS"
case "$1" in
  inspect) printf 'true\\n' ;;
  network) printf 'liyoxi_default\\n' ;;
  *) exit 91 ;;
esac
`,
  );
  chmodSync(docker, 0o755);
  const keyFile = join(temp.dir, "fixture-key.json");
  const marker = "fixture-bytes-must-not-appear-in-output-or-config";
  writeFileSync(keyFile, marker);
  const env: NodeJS.ProcessEnv = {
    PATH: bin,
    FAKE_DOCKER_CALLS: calls,
    APP_ENV: "local",
    DATA_KEYS_FILE: keyFile,
    BIDX_KEYS_FILE: keyFile,
    AUTH_KEYS_FILE: keyFile,
    MINIO_PUBLIC_ENDPOINT: "http://192.168.1.4:9110",
    LYX_LOCAL_MEDIA_BIND: "0.0.0.0",
    LYX_LOCAL_MEDIA_PROVIDER_KEYS: "none",
    LYX_LOCAL_MEDIA_DIR: directory,
  };
  return {
    directory,
    keyFile,
    marker,
    env,
    run(action = "check", changes: NodeJS.ProcessEnv = {}) {
      const result = spawnSync(process.execPath, [script, action], {
        cwd: repoRoot,
        env: { ...env, ...changes },
        encoding: "utf8",
        timeout: 10_000,
      });
      return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
    },
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []),
  };
}

interface Service {
  environment: Record<string, string>;
  volumes: Array<{
    source: string;
    target: string;
    read_only: boolean;
    bind: { create_host_path: boolean };
  }>;
}

function readOverride(directory: string) {
  return JSON.parse(readFileSync(join(directory, "compose.override.json"), "utf8")) as {
    services: Record<"api" | "worker", Service>;
  };
}

describe("本机媒体体检接入准备（Docker 为只读命令桩）", () => {
  it("必须显式选择 API 的监听范围，不静默退回仅本机", () => {
    const one = fixture();
    for (const value of [
      undefined,
      "",
      "localhost",
      "::1",
      "192.168.1.4:3000",
      "256.1.1.1",
      "255.255.255.255",
      "224.0.0.1",
      "0.1.2.3",
    ]) {
      const result = one.run("prepare", { LYX_LOCAL_MEDIA_BIND: value });
      expect(result.status).toBe(2);
      expect(result.output).toContain("LYX_LOCAL_MEDIA_BIND 必须显式提供");
    }
    expect(one.calls()).toEqual([]);
    expect(existsSync(one.directory)).toBe(false);
  });

  it("接受显式本机、局域网和全部网卡地址，并打印保留范围", () => {
    const one = fixture();
    for (const value of ["127.0.0.1", "192.168.1.4", "0.0.0.0"]) {
      const result = one.run("check", { LYX_LOCAL_MEDIA_BIND: value });
      expect(result.status).toBe(0);
      expect(result.output).toContain(`保留 API 监听地址 ${value}:3000`);
    }
    const compose = readFileSync(join(repoRoot, "infra/stack/local-media.yml"), "utf8");
    expect(compose).toContain("${LYX_LOCAL_MEDIA_BIND:?");
    expect(compose).not.toContain("${LYX_LOCAL_MEDIA_BIND:-");
  });

  it("未确认旧 Provider 清单时拒绝，不猜测为 none", () => {
    const one = fixture();
    const result = one.run("prepare", { LYX_LOCAL_MEDIA_PROVIDER_KEYS: undefined });
    expect(result.status).toBe(2);
    expect(result.output).toContain("须先核对旧 API/worker");
    expect(one.calls()).toEqual([]);
    expect(existsSync(one.directory)).toBe(false);
  });

  it("none 与任一可选配置冲突时拒绝，包含 STAGING_PAY_ENTITY_IDS", () => {
    const one = fixture();
    for (const changes of [
      { OCR_TENCENT_FILE: one.keyFile },
      { STAGING_PAY_ENTITY_IDS: "fixture" },
    ]) {
      const result = one.run("prepare", changes);
      expect(result.status).toBe(2);
      expect(result.output).toContain("拒绝遗漏或新增 Provider");
    }
    expect(one.calls()).toEqual([]);
    expect(existsSync(one.directory)).toBe(false);
  });

  it("不能把 .env 当作密钥文件挂载", () => {
    const one = fixture();
    const result = one.run("prepare", { AUTH_KEYS_FILE: join(one.directory, ".env.local") });
    expect(result.status).toBe(2);
    expect(result.output).toContain("不能是 .env");
    expect(one.calls()).toEqual([]);
  });

  it("check 仅检查既有依赖，不生成文件或发出 Docker 写命令", () => {
    const one = fixture();
    const result = one.run();
    expect(result.status).toBe(0);
    expect(one.calls()).toHaveLength(4);
    expect(
      one.calls().every((call) => /^(?:inspect --type container|network inspect) /.test(call)),
    ).toBe(true);
    expect(existsSync(one.directory)).toBe(false);
    expect(result.output).not.toContain(one.marker);
  });

  it("只读挂载现有 FILE，保留 Provider 且只把邮件配置交给 worker", () => {
    const one = fixture();
    const result = one.run("prepare", {
      LYX_LOCAL_MEDIA_PROVIDER_KEYS: "OCR_TENCENT_FILE,MAIL_TENCENT_FILE",
      OCR_TENCENT_FILE: one.keyFile,
      MAIL_TENCENT_FILE: one.keyFile,
    });
    expect(result.status).toBe(0);
    const override = readOverride(one.directory);
    for (const service of Object.values(override.services)) {
      expect(service.environment.OCR_TENCENT_FILE).toBe("/run/secrets/ocr-tencent-file");
      expect(service.volumes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: one.keyFile, target: "/run/secrets/data-keys.json" }),
          expect.objectContaining({ source: one.keyFile, target: "/run/secrets/ocr-tencent-file" }),
        ]),
      );
      expect(
        service.volumes.every((volume) => volume.read_only && !volume.bind.create_host_path),
      ).toBe(true);
    }
    expect(override.services.api.environment.MAIL_TENCENT_FILE).toBeUndefined();
    expect(override.services.worker.environment.MAIL_TENCENT_FILE).toBe(
      "/run/secrets/mail-tencent-file",
    );
    expect(JSON.stringify(override)).not.toContain(one.marker);
    expect(result.output).not.toContain(one.marker);
  });

  it("生成 probe_only 配置，重跑不覆盖任何既有内容", () => {
    const one = fixture();
    expect(one.run("prepare").status).toBe(0);
    const mediaFile = join(one.directory, "media-production.json");
    const overrideFile = join(one.directory, "compose.override.json");
    expect(JSON.parse(readFileSync(mediaFile, "utf8"))).toEqual({
      mode: "probe_only",
      workDir: "/work",
      socketPath: "/work/.sock/mediatool.sock",
    });
    writeFileSync(mediaFile, "existing media configuration");
    writeFileSync(overrideFile, "existing compose configuration");
    const result = one.run("prepare");
    expect(result.status).toBe(2);
    expect(result.output).toContain("不会覆盖");
    expect(readFileSync(mediaFile, "utf8")).toBe("existing media configuration");
    expect(readFileSync(overrideFile, "utf8")).toBe("existing compose configuration");
  });
});
