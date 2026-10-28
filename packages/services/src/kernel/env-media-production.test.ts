import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "./env.js";

const root = mkdtempSync(join(tmpdir(), "lyx-w304-env-"));
const base = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://liyoxi:lyx-local-dev@localhost:5442/liyoxi",
  REDIS_URL: "redis://localhost:6389/0",
};
const valid = {
  workDir: "/tmp/lyx-production",
  socketPath: "/tmp/lyx-production/.sock/mediatool.sock",
  aigc: {
    Label: "1",
    ContentProducer: "PUBLIC-PRODUCER",
    ReservedCode1: "",
    ContentPropagator: "",
    ReservedCode2: "",
  },
  templates: {
    normalize: "fixed-normalize",
    sd: "fixed-sd",
    hd: "fixed-hd",
    sample: "fixed-sample",
    brand: "fixed-brand",
    ai: "fixed-ai",
  },
};
const probeOnly = {
  mode: "probe_only",
  workDir: "/tmp/lyx-probe-only",
  socketPath: "/tmp/lyx-probe-only/.sock/mediatool.sock",
};
const file = (name: string, body: unknown) => {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
};
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe("制作成组FILE配置", () => {
  it("未配明确降级；完整FILE保留真实主体与六模板，不补法务值", () => {
    expect(loadEnv(base).MEDIA_PRODUCTION).toBeUndefined();
    expect(
      loadEnv({ ...base, MEDIA_PRODUCTION_FILE: file("valid", valid) }).MEDIA_PRODUCTION,
    ).toEqual(valid);
  });
  it.each(["local", "test"])("%s 显式纯体检只需目录和socket，不补主体或云模板", (appEnv) => {
    const loaded = loadEnv({
      ...base,
      APP_ENV: appEnv,
      MEDIA_PRODUCTION_FILE: file(`probe-only-${appEnv}`, probeOnly),
    }).MEDIA_PRODUCTION;
    expect(loaded).toEqual(probeOnly);
    expect(loaded).not.toHaveProperty("aigc");
    expect(loaded).not.toHaveProperty("templates");
  });
  it.each(["stg", "prod"])("%s 拒绝纯体检，完整制作配置仍兼容且诊断不透路径", (appEnv) => {
    const databaseFile = join(root, `database-${appEnv}`);
    const redisFile = join(root, `redis-${appEnv}`);
    writeFileSync(databaseFile, base.DATABASE_URL);
    writeFileSync(redisFile, base.REDIS_URL);
    const source = {
      APP_ENV: appEnv,
      DATABASE_URL_FILE: databaseFile,
      REDIS_URL_FILE: redisFile,
    };
    expect(
      loadEnv({ ...source, MEDIA_PRODUCTION_FILE: file(`full-${appEnv}`, valid) }).MEDIA_PRODUCTION,
    ).toEqual(valid);
    const restricted = {
      ...probeOnly,
      workDir: "/tmp/fictional-sensitive-probe",
      socketPath: "/tmp/fictional-sensitive-probe/.sock/private.sock",
    };
    try {
      loadEnv({ ...source, MEDIA_PRODUCTION_FILE: file(`restricted-${appEnv}`, restricted) });
      expect.fail("预发或生产不能启用纯体检模式");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).issues).toEqual([
        { key: "MEDIA_PRODUCTION_FILE", reason: "probe_only 仅允许 local/test 环境" },
      ]);
      expect(String(error)).not.toContain(root);
      expect(String(error)).not.toContain("fictional-sensitive");
      expect(String(error)).not.toContain("private.sock");
    }
  });
  it("纯体检拒绝隐式模式、混入主体或模板、未知字段及越界socket", () => {
    const invalid = [
      { workDir: probeOnly.workDir, socketPath: probeOnly.socketPath },
      { ...probeOnly, mode: "unknown" },
      { ...valid, mode: "full" },
      { ...probeOnly, aigc: valid.aigc },
      { ...probeOnly, templates: valid.templates },
      { ...probeOnly, extra: "fictional-sensitive" },
      { ...probeOnly, workDir: "relative/path" },
      { ...probeOnly, workDir: "/tmp/../other" },
      { ...probeOnly, socketPath: "/other/.sock/mediatool.sock" },
      { ...probeOnly, socketPath: "/tmp/lyx-probe-only/.sock/../escape" },
      { ...probeOnly, socketPath: "/tmp/lyx-probe-only/.sock/" },
    ];
    for (const [index, value] of invalid.entries())
      expect(() =>
        loadEnv({ ...base, MEDIA_PRODUCTION_FILE: file(`invalid-probe-${index}`, value) }),
      ).toThrow(EnvError);
  });
  it("半组/额外字段/任意相对路径或越工作根socket受控拒绝", () => {
    const invalid = [
      { ...valid, aigc: { Label: "1" } },
      { ...valid, templates: { sd: "fixed-sd" } },
      { ...valid, arbitraryUrl: "https://example.invalid/" },
      { ...valid, workDir: "/tmp/../other" },
      { ...valid, socketPath: "/other/.sock/mediatool.sock" },
      { ...valid, socketPath: "/tmp/lyx-production/.sock/../escape" },
      { ...valid, templates: { ...valid.templates, ai: "bad template" } },
    ];
    for (const [index, value] of invalid.entries())
      expect(() =>
        loadEnv({ ...base, MEDIA_PRODUCTION_FILE: file(`invalid-${index}`, value) }),
      ).toThrow();
  });
  it("FILE读失败和非法主体文本诊断不透路径/原值；明文环境项不被静默采纳", () => {
    for (const source of [
      { ...base, MEDIA_PRODUCTION_FILE: join(root, "missing") },
      {
        ...base,
        MEDIA_PRODUCTION_FILE: file("unsafe-text", {
          ...valid,
          aigc: { ...valid.aigc, ContentProducer: "fictional-sensitive\nvalue" },
        }),
      },
      { ...base, MEDIA_PRODUCTION: "fictional-sensitive" },
    ]) {
      let error: unknown;
      try {
        loadEnv(source);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect(String(error)).not.toContain(root);
      expect(String(error)).not.toContain("fictional-sensitive");
    }
  });
});
