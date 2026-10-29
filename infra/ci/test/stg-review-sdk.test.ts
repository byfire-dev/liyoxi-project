import { afterEach, expect, it, vi } from "vitest";
import type * as NodeModule from "node:module";
import type * as NodeFs from "node:fs";
import { uploadReview } from "../../deploy/review-upload-sdk.mjs";

const sdk = vi.hoisted(() => ({
  Project: vi.fn(function (options: unknown) {
    return { options };
  }),
  upload: vi.fn(async (_options: unknown) => {}),
  version: "2.1.31",
  require: vi.fn(),
}));
vi.mock("node:module", async (original) => ({
  ...(await original<typeof NodeModule>()),
  createRequire: (path: string) => {
    sdk.require(path);
    return (name: string) =>
      name === "miniprogram-ci/package.json" ? { version: sdk.version } : sdk;
  },
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof NodeFs>()),
  lstatSync: (path: string) => ({
    isDirectory: () => path === "/artifacts/project",
    isFile: () => path === "/run/secrets/weapp-upload-private-key",
  }),
}));
const consoles = { log: console.log, info: console.info, warn: console.warn, error: console.error };
afterEach(() => {
  Object.assign(console, consoles);
  vi.clearAllMocks();
  sdk.version = "2.1.31";
});
const options = {
  project: "/artifacts/project",
  key: "/run/secrets/weapp-upload-private-key",
  appid: "wx0123456789abcdef",
  version: "1.2.3",
};
const env = { LYX_WEAPP_UPLOAD_ENABLED: "true", STG_FREEZE: "true" };
it("固定SDK只上传机器人2的语义版本，不调用真实网络", async () => {
  await uploadReview(options, env);
  expect(sdk.require).toHaveBeenCalledWith("/app/package.json");
  expect(sdk.Project).toHaveBeenCalledOnce();
  expect(sdk.upload).toHaveBeenCalledOnce();
  expect(sdk.upload.mock.calls[0]?.[0]).toMatchObject({
    robot: 2,
    version: "1.2.3",
    setting: { es6: true, minify: true },
  });
});
it("错误SDK与参数/冻结/固定路径拒绝，不构造项目或调用上传", async () => {
  for (const [input, flags] of [
    [{ ...options, version: "sha-aaaaaaaaaaaa" }, env],
    [{ ...options, version: "01.2.3" }, env],
    [{ ...options, key: "/some/other/key" }, env],
    [{ ...options, project: "/tmp/project" }, env],
    [options, { ...env, STG_FREEZE: "false" }],
    [options, { ...env, LYX_WEAPP_UPLOAD_ENABLED: "false" }],
  ] as const)
    await expect(uploadReview(input, flags)).rejects.toThrow();
  expect(sdk.require).not.toHaveBeenCalled();
  sdk.version = "2.1.30";
  await expect(uploadReview(options, env)).rejects.toThrow("SDK 不符合固定版本与能力");
  expect(sdk.Project).not.toHaveBeenCalled();
  expect(sdk.upload).not.toHaveBeenCalled();
});
