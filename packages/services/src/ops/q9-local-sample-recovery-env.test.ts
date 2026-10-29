import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_KEYS, loadEnv } from "../kernel/index.js";
import type { EnvSource } from "../kernel/index.js";
import type * as Kernel from "../kernel/index.js";
import { q9LocalSampleRecoveryEnv } from "./q9-local-sample-recovery-env.js";

vi.mock("../kernel/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Kernel>();
  return { ...actual, loadEnv: vi.fn(actual.loadEnv) };
});

const local: EnvSource = {
  APP_ENV: "local",
  DATABASE_URL: "postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/liyoxi",
  REDIS_URL: "redis://127.0.0.1:6389/0",
  MINIO_ENDPOINT: "http://127.0.0.1:9100",
  MINIO_PUBLIC_ENDPOINT: "http://127.0.0.1:9100",
  LYX_Q9_MEDIA_WORK_DIR: "/work",
  LYX_Q9_MEDIA_SOCKET: "/work/.sock/mediatool.sock",
};

beforeEach(() => vi.mocked(loadEnv).mockClear());

describe("Q9本地恢复的连接与配置读取边界", () => {
  it("显式公开local配置通过；只将六个公开字段交给真实loadEnv", () => {
    const env = q9LocalSampleRecoveryEnv(local);
    expect(env).toMatchObject({
      APP_ENV: "local",
      LOG_LEVEL: "fatal",
      DATABASE_URL: local.DATABASE_URL,
      REDIS_URL: local.REDIS_URL,
      MINIO: { endpoint: local.MINIO_ENDPOINT, publicEndpoint: local.MINIO_PUBLIC_ENDPOINT },
      MEDIA_PRODUCTION: {
        mode: "local_sample_watermark",
        workDir: "/work",
        socketPath: "/work/.sock/mediatool.sock",
      },
    });
    expect(loadEnv).toHaveBeenCalledExactlyOnceWith({
      APP_ENV: "local",
      LOG_LEVEL: "fatal",
      DATABASE_URL: local.DATABASE_URL,
      REDIS_URL: local.REDIS_URL,
      MINIO_ENDPOINT: local.MINIO_ENDPOINT,
      MINIO_PUBLIC_ENDPOINT: local.MINIO_PUBLIC_ENDPOINT,
    });
  });

  const invalid: Array<[string, EnvSource]> = [
    ["test", { APP_ENV: "test" }],
    ["stg", { APP_ENV: "stg" }],
    ["prod", { APP_ENV: "prod" }],
    ["缺少环境", { APP_ENV: undefined }],
    [
      "公网PG",
      { DATABASE_URL: "postgresql://liyoxi:lyx-local-dev@db.example.invalid:5442/liyoxi" },
    ],
    ["局域网PG", { DATABASE_URL: "postgresql://liyoxi:lyx-local-dev@192.168.1.4:5442/liyoxi" }],
    ["错误PG端口", { DATABASE_URL: "postgresql://liyoxi:lyx-local-dev@127.0.0.1:5432/liyoxi" }],
    ["错误数据库", { DATABASE_URL: "postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/lyx_stack" }],
    ["非公开PG账号", { DATABASE_URL: "postgresql://other:private@127.0.0.1:5442/liyoxi" }],
    ["PG查询参数", { DATABASE_URL: `${local.DATABASE_URL}?host=db.example.invalid` }],
    ["公网Redis", { REDIS_URL: "redis://redis.example.invalid:6389/0" }],
    ["错误Redis端口", { REDIS_URL: "redis://127.0.0.1:6379/0" }],
    ["错误Redis库", { REDIS_URL: "redis://127.0.0.1:6389/1" }],
    ["Redis用户信息", { REDIS_URL: "redis://user:private@127.0.0.1:6389/0" }],
    ["Redis空用户信息", { REDIS_URL: "redis://@127.0.0.1:6389/0" }],
    ["公网MinIO内部地址", { MINIO_ENDPOINT: "http://minio.example.invalid:9100" }],
    ["公网MinIO签名地址", { MINIO_PUBLIC_ENDPOINT: "https://minio.example.invalid:9100" }],
    ["错误MinIO端口", { MINIO_ENDPOINT: "http://127.0.0.1:9000" }],
    ["MinIO用户信息", { MINIO_ENDPOINT: "http://user:private@127.0.0.1:9100" }],
    ["MinIO空用户信息", { MINIO_PUBLIC_ENDPOINT: "http://@127.0.0.1:9100" }],
    ["MinIO路径", { MINIO_ENDPOINT: "http://127.0.0.1:9100/bucket" }],
    ["缺少MinIO签名地址", { MINIO_PUBLIC_ENDPOINT: undefined }],
    ["相对媒体目录", { LYX_Q9_MEDIA_WORK_DIR: "work" }],
    ["根目录媒体路径", { LYX_Q9_MEDIA_WORK_DIR: "/" }],
  ];
  it.each(invalid)("%s在loadEnv和任何FILE读取前拒绝", (_label, patch) => {
    expect(() => q9LocalSampleRecoveryEnv({ ...local, ...patch })).toThrow(
      expect.objectContaining({ error: "VALIDATION_FAILED" }),
    );
    expect(loadEnv).not.toHaveBeenCalled();
  });

  it("忽略全部恶意FILE与云配置；连禁止字段的getter也不读取", () => {
    const source = {
      ...local,
      ...Object.fromEntries(
        ENV_KEYS.filter((key) => key.endsWith("_FILE")).map((key) => [
          key,
          `/q9-path-that-does-not-exist/${key}.json`,
        ]),
      ),
      COS_REGION: "remote-region",
      COS_SIGNER_KEYS: "never-forward",
      WECHAT_APPID: "remote-appid",
      LLM_DOMESTIC: "never-forward",
    };
    Object.defineProperty(source, "AUTH_KEYS_FILE", {
      get: () => {
        throw new Error("不允许读取后台密钥路径");
      },
    });
    const env = q9LocalSampleRecoveryEnv(source);
    expect(Object.keys(vi.mocked(loadEnv).mock.calls[0]![0]!).sort()).toEqual([
      "APP_ENV",
      "DATABASE_URL",
      "LOG_LEVEL",
      "MINIO_ENDPOINT",
      "MINIO_PUBLIC_ENDPOINT",
      "REDIS_URL",
    ]);
    for (const key of ["DATA_KEYS", "BIDX_KEYS", "AUTH_KEYS", "COS", "WECHAT", "LLM_DOMESTIC"])
      expect(env).not.toHaveProperty(key);
  });
});
