// W2-27：只消费已核验的同次私有构建；不重构建、不注入debug ID、不发布公开artifact。
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verify } from "./source-maps.mjs";

const roots = {
  api: "server",
  worker: "server",
  admin: "gateway",
  portal: "gateway",
  weapp: "weapp-build",
};
const components = Object.keys(roots);
const MAX_BINARY = 64 * 1024 * 1024;
const fail = () => {
  throw new Error("source_map_upload_failed");
};
const requireValue = (value) => {
  if (!value) fail();
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function uploadConfiguration(raw) {
  requireValue(typeof raw === "string" && Buffer.byteLength(raw) <= 4096);
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    fail();
  }
  const slug = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(value);
  requireValue(
    config &&
      Object.keys(config).sort().join() === "organization,projects" &&
      slug(config.organization),
  );
  requireValue(
    config.projects && Object.keys(config.projects).sort().join() === [...components].sort().join(),
  );
  requireValue(components.every((name) => slug(config.projects[name])));
  return config;
}

/** 命令只含非敏感发布身份；令牌永远不进入argv、输出或收据。 */
export function uploadArguments(component, tag) {
  requireValue(components.includes(component) && /^sha-[a-f0-9]{12}$/.test(tag));
  return [
    "sourcemaps",
    "upload",
    "--release",
    tag,
    "--dist",
    component,
    "--url-prefix",
    `app:///${component}`,
    "--no-rewrite",
    "--strict",
    "--wait-for",
    "60",
    "--ext",
    "js",
    "--ext",
    "map",
    component,
  ];
}

/** 有界下载、禁重定向、先验官方hash，验证前绝不执行。测试注入固定字节fetch。 */
export async function downloadVerified(lock, file, fetcher = fetch) {
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 20_000);
  let response;
  try {
    response = await fetcher(lock.url, { redirect: "error", signal: abort.signal });
    requireValue(response.status === 200 && response.body);
    const declared = response.headers.get("content-length");
    requireValue(declared === null || (/^\d+$/.test(declared) && Number(declared) <= MAX_BINARY));
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      requireValue(size <= MAX_BINARY);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    requireValue(size > 0 && hash(bytes) === lock.sha256);
    await fs.writeFile(file, bytes, { mode: 0o500, flag: "wx" });
  } finally {
    clearTimeout(timer);
    abort.abort();
    await response?.body?.cancel().catch(() => undefined);
  }
}

const execute = (file, args, options) =>
  new Promise((resolveRun, reject) => {
    execFile(
      file,
      args,
      { ...options, encoding: "utf8", maxBuffer: 4096, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (error) reject(new Error("source_map_upload_command_failed"));
        else resolveRun(stdout);
      },
    );
  });
function commandEnvironment(home, token, config, component) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: home,
    SENTRY_URL: "https://sentry.io/",
    SENTRY_ORG: config.organization,
    ...(component ? { SENTRY_PROJECT: config.projects[component] } : {}),
    ...(token ? { SENTRY_AUTH_TOKEN: token } : {}),
    SENTRY_HTTP_MAX_RETRIES: "0",
    SENTRY_DISABLE_UPDATE_CHECK: "true",
    SENTRY_LOAD_DOTENV: "0",
    SENTRY_NO_PROGRESS_BAR: "1",
    SENTRY_LOG_LEVEL: "error",
  };
}

async function readApprovedFile(base, entry) {
  const path = entry.path;
  requireValue(typeof path === "string" && /^[A-Za-z0-9_./-]{1,512}$/.test(path));
  requireValue(!path.split("/").some((part) => !part || part === "." || part === ".."));
  const file = join(base, path);
  requireValue((await fs.realpath(file)) === file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireValue(
      stat.isFile() && stat.size > 0 && stat.size <= MAX_BINARY && stat.size === entry.size,
    );
    const bytes = await handle.readFile();
    requireValue(bytes.length === entry.size && hash(bytes) === entry.sha256);
    return bytes;
  } finally {
    await handle.close();
  }
}

/** 只复制manifest逐项批准的字节；CLI不扫描原目录，未登记文件永不出站。 */
export async function snapshotFiles(root, manifest, target) {
  let pairs = 0;
  for (const component of components) {
    for (const pair of manifest.components[component].files) {
      for (const entry of [pair, pair.map]) {
        const bytes = await readApprovedFile(join(root, roots[component], component), entry),
          destination = join(target, component, entry.path);
        await fs.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await fs.writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
      }
      pairs++;
    }
  }
  return pairs;
}

/** adapters仅供无网络测试；正式CLI始终使用锁定下载与execFile。 */
export async function uploadMaps(input, adapters = {}) {
  if (!input.token) return { status: "unconfigured", uploadedComponents: 0 };
  requireValue(
    typeof input.token === "string" && input.token.length <= 4096 && !/[\s\0]/.test(input.token),
  );
  const config = uploadConfiguration(input.configuration);
  requireValue(
    (process.platform === "linux" && process.arch === "x64") ||
      adapters.testPlatform === "linux-x64",
  );
  const root = await fs.realpath(input.root);
  requireValue(root === resolve(input.root));
  await verify(root, input.source, input.tag);
  const manifest = JSON.parse(await fs.readFile(join(root, "manifest.json"), "utf8"));
  const lock = JSON.parse(
    await fs.readFile(new URL("./sentry-cli.lock.json", import.meta.url), "utf8"),
  );
  requireValue(
    lock.version === "3.8.0" &&
      lock.linuxX64.url ===
        "https://downloads.sentry-cdn.com/sentry-cli/3.8.0/sentry-cli-Linux-x86_64" &&
      /^[a-f0-9]{64}$/.test(lock.linuxX64.sha256),
  );
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lyx-map-upload-")));
  const run = adapters.run ?? execute,
    install = adapters.install ?? downloadVerified;
  const binary = join(home, "sentry-cli");
  const started = performance.now();
  try {
    await fs.chmod(home, 0o700);
    // 最近配置在本轮自有目录；不读仓库/用户的.env或CLI登录态。
    await fs.writeFile(
      join(home, ".sentryclirc"),
      "[http]\nverify_ssl=true\nmax_retries=0\n[update]\ndisable_check=true\n",
      { mode: 0o600, flag: "wx" },
    );
    const pairs = await snapshotFiles(root, manifest, home);
    await install(lock.linuxX64, binary);
    const version = await run(binary, ["--version"], {
      cwd: home,
      env: commandEnvironment(home, undefined, config),
      timeout: 5000,
    });
    requireValue(version.trim() === `sentry-cli ${lock.version}`);
    for (const component of components) {
      const remaining = 300_000 - (performance.now() - started);
      requireValue(remaining > 0);
      await run(binary, uploadArguments(component, input.tag), {
        cwd: home,
        env: commandEnvironment(home, input.token, config, component),
        timeout: Math.min(90_000, remaining),
      });
      for (const pair of manifest.components[component].files)
        for (const entry of [pair, pair.map]) await readApprovedFile(join(home, component), entry);
    }
    // --no-rewrite及原manifest共同约束发布字节；命令成功不等于SaaS已正确符号化。
    await verify(root, input.source, input.tag);
    return {
      status: "uploaded",
      uploadedComponents: components.length,
      pairs,
      source: input.source,
      tag: input.tag,
      cli: lock.version,
    };
  } finally {
    // 路径仅来自本函数mkdtemp，不接受调用者指定清理目标。
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function main() {
  requireValue(process.argv.length === 5);
  const result = await uploadMaps({
    root: process.argv[2],
    source: process.argv[3],
    tag: process.argv[4],
    token: process.env.SENTRY_AUTH_TOKEN,
    configuration: process.env.LYX_SENTRY_UPLOAD_CONFIG,
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    process.stderr.write("source_map_upload_failed\n");
    process.exitCode = 1;
  });
