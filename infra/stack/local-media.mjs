// @ts-check
// 只做本机接入检查、生成非密钥配置；不读 .env/密钥，不构建、起停容器或迁移数据。
// 显式提供既有 DATA_KEYS_FILE/BIDX_KEYS_FILE/AUTH_KEYS_FILE 的绝对路径，以及
// MINIO_PUBLIC_ENDPOINT 与 LYX_LOCAL_MEDIA_BIND（保留既有 API 的监听范围，无默认地址）。
// LYX_LOCAL_MEDIA_PROVIDER_KEYS 必须列出旧进程所有可选配置键，
// 并显式导出对应变量；确实全未启用时写 none。不能从空 shell 推断旧进程未启用 Provider。
// prepare 后按输出的两个 -f 参数使用 Compose；保留其他 Provider 的文件只读挂载。
import { constants, accessSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { DEPS, UsageError, docker, root, runMain } from "./lib.mjs";

const requiredFiles = {
  DATA_KEYS_FILE: "/run/secrets/data-keys.json",
  BIDX_KEYS_FILE: "/run/secrets/bidx-keys.json",
  AUTH_KEYS_FILE: "/run/secrets/auth-keys.json",
};
const providerKeys = new Set([
  "ADMIN_IP_ALLOWLIST",
  "CERT_DOMAINS",
  "STAGING_PAY_ENTITY_IDS",
  "BACKUP_FILE",
  "ALERTS_FILE",
  "SMS_SECRET_ID_FILE",
  "SMS_SECRET_KEY_FILE",
  "SMS_SDK_APP_ID",
  "SMS_REGION",
  "WECHAT_PAY_FILE",
  "WECHAT_APPID",
  "WECHAT_SECRET_FILE",
  "WECHAT_MESSAGE_TOKEN_FILE",
  "WECHAT_MESSAGE_AES_KEY_FILE",
  "CLIENT_ERROR_PROJECTS_FILE",
  "SERVER_ERRORS_FILE",
  "COS_REGION",
  "COS_BUCKET_SECURE",
  "COS_BUCKET_ASSET",
  "COS_BUCKET_MEDIA",
  "COS_BUCKET_PUB",
  "COS_SIGNER_KEYS_FILE",
  "COS_STS_ISSUER_KEYS_FILE",
  "COS_WORKER_KEYS_FILE",
  "CI_REGION",
  "CI_BUCKET_SECURE",
  "CI_BUCKET_ASSET",
  "CI_BUCKET_MEDIA",
  "CI_BUCKET_PUB",
  "CI_WORKER_KEYS_FILE",
  "CI_CALLBACK_KEY_FILE",
  "CI_CALLBACK_ORIGIN",
  "ASR_TENCENT_FILE",
  "OCR_TENCENT_FILE",
  "MAIL_TENCENT_FILE",
  "LLM_DOMESTIC_FILE",
  "ASR_CALLBACK_ORIGIN",
  "ASR_CALLBACK_KEY_FILE",
]);
const workerOnly =
  /^(?:BACKUP_FILE|ALERTS_FILE|MAIL_TENCENT_FILE|COS_WORKER_KEYS_FILE|CI_(?:REGION|BUCKET_.+|WORKER_KEYS_FILE))$/;
const apiOnly = /^(?:CLIENT_ERROR_PROJECTS_FILE|COS_(?:SIGNER|STS_ISSUER)_KEYS_FILE)$/;

/** 只检查路径和文件元信息；不读取文件字节。 @param {string} key @param {string | undefined} path */
function assertFile(key, path) {
  if (!path || !isAbsolute(path) || /(?:^|\/)\.env(?:\.|$)/.test(path)) {
    throw new UsageError(`${key} 必须显式提供现有文件的绝对路径，不能是 .env`);
  }
  try {
    if (!statSync(path).isFile()) throw new Error();
    accessSync(path, constants.R_OK);
  } catch {
    throw new UsageError(`${key} 指向的现有文件不可读或不是普通文件`);
  }
}

/** @param {string} source @param {string} target */
const bind = (source, target) => ({
  type: "bind",
  source,
  target,
  read_only: true,
  bind: { create_host_path: false },
});

await runMain(() => {
  const action = process.argv[2];
  if (process.argv.length !== 3 || !["check", "prepare"].includes(action ?? "")) {
    throw new UsageError(
      "用法：node infra/stack/local-media.mjs check|prepare（不提供启动/停止入口）",
    );
  }
  if (process.env.APP_ENV && process.env.APP_ENV !== "local") {
    throw new UsageError("此入口只支持 APP_ENV=local");
  }
  if (process.env.MEDIA_PRODUCTION_FILE) {
    throw new UsageError("已有 MEDIA_PRODUCTION_FILE：先核对旧媒体配置，不能自动降为 probe_only");
  }
  const apiBind = process.env.LYX_LOCAL_MEDIA_BIND?.trim();
  const firstOctet = Number(apiBind?.split(".")[0]);
  if (
    !apiBind ||
    !isIPv4(apiBind) ||
    firstOctet >= 224 ||
    (firstOctet === 0 && apiBind !== "0.0.0.0")
  ) {
    throw new UsageError(
      "LYX_LOCAL_MEDIA_BIND 必须显式提供现有 API 的 IPv4 监听地址（可为 0.0.0.0 或 127.0.0.1）；不接受主机名、端口、广播或组播地址",
    );
  }
  for (const key of Object.keys(requiredFiles)) assertFile(key, process.env[key]);
  try {
    const endpoint = new URL(process.env.MINIO_PUBLIC_ENDPOINT ?? "");
    if (
      endpoint.protocol !== "http:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== "/"
    )
      throw new Error();
  } catch {
    throw new UsageError("MINIO_PUBLIC_ENDPOINT 必须显式提供现有本地 HTTP 存储源地址");
  }
  const manifest = process.env.LYX_LOCAL_MEDIA_PROVIDER_KEYS?.trim();
  if (!manifest) {
    throw new UsageError(
      "须先核对旧 API/worker 已启用的可选配置键，再提供 LYX_LOCAL_MEDIA_PROVIDER_KEYS（全未启用才写 none）；不读取旧 .env，也不会猜测为未配置",
    );
  }
  const declared = manifest === "none" ? [] : manifest.split(/[\s,]+/).filter(Boolean);
  if (
    declared.some((key) => !providerKeys.has(key)) ||
    new Set(declared).size !== declared.length
  ) {
    throw new UsageError("LYX_LOCAL_MEDIA_PROVIDER_KEYS 有未知或重复键名，须先核对");
  }
  for (const key of providerKeys) {
    if (Boolean(process.env[key]?.trim()) !== declared.includes(key)) {
      throw new UsageError(`${key} 的显式环境与已核对的旧配置清单不一致，拒绝遗漏或新增 Provider`);
    }
    if (declared.includes(key) && key.endsWith("_FILE")) assertFile(key, process.env[key]);
  }
  const directory =
    process.env.LYX_LOCAL_MEDIA_DIR ?? join(homedir(), ".config/liyoxi/local/media-probe");
  const fromRoot = relative(root, directory);
  if (!isAbsolute(directory) || !fromRoot.startsWith("..")) {
    throw new UsageError("LYX_LOCAL_MEDIA_DIR 必须是仓库外的用户配置目录绝对路径");
  }
  for (const container of DEPS.containers) {
    const result = docker(
      ["inspect", "--type", "container", "--format", "{{.State.Running}}", container],
      { capture: true, timeoutMs: 10_000 },
    );
    if (result.status !== 0 || result.stdout.trim() !== "true")
      throw new UsageError(`本机共享依赖 ${container} 未运行；本脚本不会启动它`);
  }
  if (
    docker(["network", "inspect", DEPS.network, "--format", "{{.Name}}"], {
      capture: true,
      timeoutMs: 10_000,
    }).status !== 0
  ) {
    throw new UsageError("缺少本机共享依赖网络；本脚本不会创建它");
  }
  console.log(
    `检查通过：既有三份登录/加密文件可挂载；可选配置键 ${declared.join(", ") || "none"}；复用 liyoxi / Redis 0。未读取文件内容。`,
  );
  console.log(`保留 API 监听地址 ${apiBind}:3000；切换前须确认与既有本机及真机访问范围一致。`);
  if (action === "check") return;

  const mediaFile = join(directory, "media-production.json");
  const overrideFile = join(directory, "compose.override.json");
  const files = { ...requiredFiles, MEDIA_PRODUCTION_FILE: "/run/secrets/media-production.json" };
  /** @type {NodeJS.ProcessEnv} */
  const sources = { ...process.env, MEDIA_PRODUCTION_FILE: mediaFile };
  /** @type {Record<string, { environment: Record<string, string>, volumes: ReturnType<typeof bind>[] }>} */
  const services = {};
  for (const role of ["api", "worker"]) {
    /** @type {Record<string, string>} */
    const environment = {};
    const volumes = Object.entries(files).map(([key, target]) => bind(sources[key] ?? "", target));
    for (const key of declared) {
      if ((role === "api" && workerOnly.test(key)) || (role === "worker" && apiOnly.test(key)))
        continue;
      const value = process.env[key] ?? "";
      if (key.endsWith("_FILE")) {
        const target = `/run/secrets/${key.toLowerCase().replaceAll("_", "-")}`;
        environment[key] = target;
        volumes.push(bind(value, target));
      } else environment[key] = value;
    }
    services[role] = { environment, volumes };
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // 不覆盖任何已有配置；重跑时先人工核对已生成文件。
  try {
    writeFileSync(
      mediaFile,
      `${JSON.stringify({ mode: "probe_only", workDir: "/work", socketPath: "/work/.sock/mediatool.sock" }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    writeFileSync(overrideFile, `${JSON.stringify({ services }, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    throw new UsageError(
      "配置目录中已有文件或写入失败；不会覆盖。请核对已生成的媒体配置和 Compose override",
    );
  }
  console.log(`已生成 ${mediaFile} 与 ${overrideFile}（不含密钥内容）。`);
  console.log(`Compose 参数：-f ${join(root, "infra/stack/local-media.yml")} -f ${overrideFile}`);
  console.log(
    "尚未构建或启动。切换前须核对镜像包含本次代码、容器 UID 1000 能读只读文件，先停旧 worker/API，再启动；不迁移、不播种、不删卷。回退时先停新 worker，再恢复原命令。",
  );
});
