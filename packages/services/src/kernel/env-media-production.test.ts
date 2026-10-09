import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

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
