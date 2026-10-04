import { describe, expect, it } from "vitest";

import { createFakeProviders, createRecordingLogger } from "../testing/index.js";
import {
  createProviders,
  describeProviders,
  LOCAL_MINIO,
  logProviderStatus,
  PROVIDER_NAMES,
} from "./index.js";
import type { ProviderAppEnv, ProviderName, ProviderSettings } from "./index.js";

// 启动日志的用例（W0-19 任务书 第 7 节第 2 条）：十二个接口各一行，接口名加生效状态；日志里没有任何配置值。

const UNCONFIGURED = Object.fromEntries(
  PROVIDER_NAMES.map((name) => [name, "unconfigured"]),
) as Record<ProviderName, string>;

/** 什么都不配时各环境的生效状态（01 第 9 节“未配置时”一列） */
const EXPECTED: Record<ProviderAppEnv, Record<ProviderName, string>> = {
  local: {
    ...UNCONFIGURED,
    wechat: "local",
    sms: "local",
    storage: "local",
    media: "local",
    esign: "stamp",
  },
  test: {
    ...UNCONFIGURED,
    wechat: "local",
    sms: "local",
    storage: "local",
    media: "local",
    esign: "stamp",
  },
  stg: UNCONFIGURED,
  prod: UNCONFIGURED,
};

function start(appEnv: ProviderAppEnv, settings?: ProviderSettings) {
  const logger = createRecordingLogger();
  const providers = createProviders({ appEnv, logger, settings });
  return { logger, providers };
}

describe("启动时打印各 Provider 的生效状态", () => {
  it.each(Object.keys(EXPECTED) as ProviderAppEnv[])(
    "%s：十二个接口各一行（接口名加生效状态），顺序照 ADR-039，最后一行汇总",
    (appEnv) => {
      const { logger } = start(appEnv);
      const expected = EXPECTED[appEnv];
      expect(logger.lines.slice(0, 12)).toEqual(
        PROVIDER_NAMES.map((name) => ({
          level: "info",
          fields: { provider: name, status: expected[name] },
          message: `provider ${name}: ${expected[name]}`,
        })),
      );
      expect(logger.lines.slice(12)).toEqual([
        { level: "info", fields: { providers: expected }, message: "providers ready" },
      ]);
    },
  );

  it("stg、prod 打开图片章开关：esign 一行是 stamp，另有一条告警", () => {
    for (const appEnv of ["stg", "prod"] as const) {
      const { logger } = start(appEnv, { esign: { imageSeal: true } });
      const lines = logger.lines.filter((line) => line.level === "info").slice(0, 12);
      expect(lines.map((line) => line.message)).toEqual(
        PROVIDER_NAMES.map(
          (name) => `provider ${name}: ${name === "esign" ? "stamp" : "unconfigured"}`,
        ),
      );
      expect(logger.lines.filter((line) => line.level === "warn")).toHaveLength(1);
    }
  });
});

describe("日志里没有任何配置值", () => {
  // 形似真实配置的值在这里拼出来，再断言它们没有进日志
  const endpoint = `http://${["minio", "mark-7f3a", "internal"].join(".")}:9000`;
  const accessKey = ["ak", "mark", "91c2"].join("-");
  const secretKey = ["sk", "mark", "55e1"].join("-");
  const bucket = ["bucket", "mark", "0d4b"].join("-");
  const settings: ProviderSettings = {
    sms: { driver: "console" },
    storage: {
      driver: "minio",
      minio: {
        endpoint,
        accessKey,
        secretKey,
        buckets: { secure: bucket, asset: bucket, media: bucket, pub: bucket },
      },
    },
    esign: { imageSeal: true },
  };

  it.each(["local", "test"] as const)("%s：给了连接参数，启动日志里一个也不出现", (appEnv) => {
    const { logger } = start(appEnv, settings);
    const text = JSON.stringify(logger.lines);
    for (const value of [endpoint, accessKey, secretKey, bucket, "mark"]) {
      expect(text).not.toContain(value);
    }
  });

  it.each(["local", "test", "stg", "prod"] as const)(
    "%s：缺省的本地连接参数也不出现；每一行只有接口名与状态",
    (appEnv) => {
      const { logger } = start(appEnv);
      const text = JSON.stringify(logger.lines);
      for (const value of [LOCAL_MINIO.endpoint, LOCAL_MINIO.secretKey, "9100", "lyx-local"]) {
        expect(text).not.toContain(value);
      }
      for (const line of logger.lines.slice(0, 12)) {
        expect(Object.keys(line.fields).sort()).toEqual(["provider", "status"]);
      }
      expect(Object.keys(logger.lines[12]?.fields ?? {})).toEqual(["providers"]);
    },
  );
});

describe("describeProviders 与 logProviderStatus", () => {
  it("十二项，带能不能用", () => {
    const { providers } = start("local");
    const entries = describeProviders(providers);
    expect(entries.map((entry) => entry.name)).toEqual([...PROVIDER_NAMES]);
    expect(Object.fromEntries(entries.map((entry) => [entry.name, entry.configured]))).toEqual({
      wechat: true,
      wechatPay: false,
      sms: true,
      storage: true,
      media: true,
      ocr: false,
      asr: false,
      llm: false,
      wecom: false,
      esign: true,
      invoice: false,
      mail: false,
    });
  });

  it("测试装配里的替身：十二行都是 fake", () => {
    const logger = createRecordingLogger();
    logProviderStatus(logger, createFakeProviders());
    expect(logger.lines.slice(0, 12).map((line) => line.message)).toEqual(
      PROVIDER_NAMES.map((name) => `provider ${name}: fake`),
    );
  });
});
