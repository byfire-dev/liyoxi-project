#!/usr/bin/env node
// W302-only live entry. No production harness switch, cloud account, or business API interception.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { prepareLiveMedia } from "./live-media.mjs";
import { selectedLiveTests } from "./live-selection.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ADMIN = join(ROOT, "apps/admin");
const id = randomBytes(8).toString("hex"),
  name = `lyx_test_admin_live_${id}`;
const prefix = `lyx:test:admin_live_${id}:`,
  temporary = join(ADMIN, "dist/tmp", `admin-live-${id}`);
const appOut = `dist/admin-live-${id}`,
  apiOut = `dist/w302-live-${id}`,
  stateFile = join(temporary, "state.json");
const contextFile = join(temporary, "context.json"),
  inputFile = join(temporary, "media-input.json"),
  children = new Set(),
  gracefulChildren = new Set();
const logs = join(ADMIN, "dist/e2e-live-logs");
let proxy,
  databaseRequested = false,
  interrupted = false;
const processKeys = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "CI",
  "GITHUB_ACTIONS",
  "PNPM_HOME",
  "PLAYWRIGHT_BROWSERS_PATH",
  "LYX_E2E_CHANNEL",
  "NPM_CONFIG_ENGINE_STRICT",
];
const toolEnv = Object.fromEntries(
  processKeys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
);

function localUrl(key, protocols) {
  const raw = process.env[key];
  if (!raw) throw new Error(`${key} requires the public local test connection`);
  const url = new URL(raw);
  if (!protocols.includes(url.protocol) || !["127.0.0.1", "localhost"].includes(url.hostname))
    throw new Error(`${key} must use loopback`);
  return url;
}
function terminate(child, signal = "SIGTERM") {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (signal !== "SIGKILL" && gracefulChildren.has(child)) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
function start(command, args, env, cwd = ROOT) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}
function run(command, args, env, { capture = false, cwd = ROOT, cleanup = false } = {}) {
  if (interrupted && !cleanup) throw new Error("W302 live was interrupted");
  const child = start(command, args, env, cwd);
  return new Promise((accept, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      if (capture) output += chunk;
      else process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0
        ? accept(output)
        : reject(new Error(`${command} ${args.join(" ")} exited ${signal ?? code}`)),
    );
  });
}
async function stopChildren() {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise((accept) => {
          const timer = setTimeout(() => terminate(child, "SIGKILL"), 10_000);
          child.once("close", () => {
            clearTimeout(timer);
            accept();
          });
          terminate(child);
        }),
    ),
  );
}
function keys() {
  const b64 = (byte) => Buffer.alloc(32, byte).toString("base64");
  const source = {
    DATA_KEYS_FILE: { current: "test", keys: { test: b64(0x51) } },
    BIDX_KEYS_FILE: { phone: b64(0x52), uscc: b64(0x53) },
    AUTH_KEYS_FILE: {
      ticket: b64(0x71),
      device: b64(0x72),
      mfa: { current: "t1", keys: { t1: b64(0x73) } },
    },
  };
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => {
      const path = join(temporary, `${key}.json`);
      writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      return [key, path];
    }),
  );
}
function fixtureFile(source, label) {
  if (!source || extname(source) !== ".mp4")
    throw new Error(`--${label} requires a validated legal MP4 fixture`);
  const actual = realpathSync(source);
  const allowed =
    actual.startsWith(`${ROOT}${sep}packages${sep}services${sep}`) ||
    actual.startsWith("/private/tmp/lyx-w302-") ||
    actual.startsWith("/tmp/lyx-w302-");
  if (!allowed)
    throw new Error("Video fixtures must be repository fixtures or owned W302 temporary files");
  const bytes = readFileSync(actual),
    path = join(temporary, `${label}.mp4`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
async function buildApi(env) {
  // Build the real document CPU worker before the private bundle replaces server.js.
  await run(process.execPath, ["scripts/build.mjs", "--outdir", apiOut], env, {
    cwd: join(ROOT, "apps/api"),
  });
  if (!existsSync(join(ROOT, "apps/api", apiOut, "document-converter.js")))
    throw new Error("The actual document converter build artifact is missing");
  // Compile API-owned handlers with the real build constant. Workspace test helpers keep their
  // package-local dependency resolution through the existing tsx loader.
  const source = `
    import { build } from "esbuild";
    const result = await build({
      entryPoints: ["test/upload-batch-live-server.ts"],
      outfile: process.argv[1], bundle: true, format: "esm", platform: "node",
      target: "node24", sourcemap: true, metafile: true, logLevel: "warning",
      define: { __LYX_BUILD__: JSON.stringify(process.env.LYX_BUILD?.trim() || "dev") },
      plugins: [{ name: "external-node-modules", setup(context) {
        context.onResolve({ filter: /^[^./]/ }, (args) => ({ path: args.path, external: true }));
      }}],
    });
    console.log("W302 private API bundle complete: " + Object.keys(result.metafile.outputs).length + " outputs");
  `;
  await run(
    "pnpm",
    [
      "--silent",
      "--filter",
      "@liyoxi/api",
      "exec",
      "node",
      "--input-type=module",
      "--eval",
      source,
      `${apiOut}/server.js`,
    ],
    env,
  );
  copyFileSync(
    join(ROOT, "apps/api/test/upload-batch-live-mediatool-helper.mjs"),
    join(ROOT, "apps/api", apiOut, "upload-batch-live-mediatool-helper.mjs"),
  );
}
function startApi(env, image) {
  const loader = createRequire(join(ROOT, "packages/services/package.json")).resolve("tsx");
  // A wrapper may relay a second signal before async shutdown finishes. Signal the actual
  // server once so its existing job/relay shutdown can confirm termination and clean its scope.
  const child = start(
    process.execPath,
    [
      "--import",
      loader,
      join(ROOT, "apps/api", apiOut, "server.js"),
      "--test-redis-prefix",
      prefix,
      "--input-manifest",
      inputFile,
      "--mediatool-image",
      image,
    ],
    env,
    join(ROOT, "packages/services"),
  );
  gracefulChildren.add(child);
  const log = createWriteStream(join(logs, `w302-api-${id}.log`));
  child.stderr.on("data", (chunk) => log.write(chunk));
  child.once("close", () => log.end());
  return new Promise((accept, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error("W302 private server did not start within 60 seconds")),
      60_000,
    );
    const fail = () => {
      clearTimeout(timer);
      reject(new Error("W302 private server exited before readiness"));
    };
    child.once("error", fail);
    child.once("close", fail);
    child.stdout.on("data", (chunk) => {
      log.write(chunk);
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          event.evt === "w302.live.listening" &&
          typeof event.apiOrigin === "string" &&
          typeof event.cosOrigin === "string"
        ) {
          clearTimeout(timer);
          child.off("close", fail);
          child.off("error", fail);
          accept(event);
        }
      }
    });
  });
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};
async function serveProduction(apiOrigin) {
  const directory = join(ADMIN, appOut);
  proxy = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const target = new URL(`${url.pathname}${url.search}`, apiOrigin);
      const upstream = httpRequest(
        target,
        { method: incoming.method, headers: incoming.headers },
        (result) => {
          response.writeHead(result.statusCode ?? 502, result.headers);
          result.pipe(response);
        },
      );
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end("Test API unavailable");
      });
      incoming.on("aborted", () => upstream.destroy());
      incoming.pipe(upstream);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    let path;
    try {
      path = resolve(directory, `.${decodeURIComponent(url.pathname)}`);
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (path !== directory && !path.startsWith(`${directory}${sep}`)) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (!extname(path)) path = join(directory, "index.html");
    if (!existsSync(path)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME[extname(path)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    const stream = createReadStream(path);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  });
  await new Promise((accept, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", accept);
  });
  return `http://127.0.0.1:${proxy.address().port}`;
}
async function main(args) {
  if (
    !/^(24|26)\./.test(process.versions.node) ||
    (process.env.APP_ENV && process.env.APP_ENV !== "test")
  )
    throw new Error("W302 live requires Node24 (or nightly Node26) and APP_ENV=test");
  const { values } = parseArgs({
    args,
    options: {
      video: { type: "string" },
      "resume-video": { type: "string" },
      "probe-facts": { type: "string" },
      "mediatool-image": { type: "string" },
      "test-file": { type: "string" },
    },
  });
  const image = values["mediatool-image"];
  const testFiles = selectedLiveTests(values["test-file"]);
  if (!/^sha256:[a-f0-9]{64}$/.test(image ?? ""))
    throw new Error("--mediatool-image requires the exact verified original image ID");
  const original = localUrl("DATABASE_URL", ["postgres:", "postgresql:"]);
  const redis = localUrl("REDIS_URL", ["redis:"]);
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  mkdirSync(logs, { recursive: true });
  const baseEnv = {
    ...toolEnv,
    APP_ENV: "test",
    DATABASE_URL: original.toString(),
    REDIS_URL: redis.toString(),
    LOG_LEVEL: "info",
    LYX_BUILD: `w302-live-${id}`,
    LYX_TEST_SESSION: id.slice(0, 12),
    MINIO_ENDPOINT: "http://127.0.0.1:9100",
    MINIO_PUBLIC_ENDPOINT: "http://127.0.0.1:9100",
    ...keys(),
  };
  const database = new URL(original);
  database.pathname = `/${name}`;
  database.search = "";
  database.searchParams.set("options", "-c role=lyx_app");
  const testEnv = { ...baseEnv, DATABASE_URL: database.toString() };
  try {
    const video = fixtureFile(values.video, "video"),
      resumeVideo = fixtureFile(values["resume-video"], "resume-video");
    if (resumeVideo.size <= 20 * 1024 * 1024)
      throw new Error(
        "The legal resume fixture must exceed the unchanged 20MiB multipart threshold",
      );
    if (!values["probe-facts"])
      throw new Error("--probe-facts requires actual verified two-video probe JSON");
    const probePath = realpathSync(values["probe-facts"]);
    if (!probePath.startsWith("/private/tmp/lyx-w302-") && !probePath.startsWith("/tmp/lyx-w302-"))
      throw new Error("Probe facts must be an owned W302 file");
    const facts = JSON.parse(readFileSync(probePath, "utf8")),
      raw = {};
    if (!Array.isArray(facts.results))
      throw new Error("Actual generated-media manifest is missing");
    for (const [label, actual] of [
      ["video", video],
      ["resumeVideo", resumeVideo],
    ]) {
      const expected = facts.results.find(
        (entry) => entry.sha256 === actual.sha256 && entry.size === actual.size,
      );
      if (!expected || !["standard-20s.mp4", "multipart-20s.mp4"].includes(expected.name))
        throw new Error("Actual video bytes differ from their verified probe facts");
      const reportPath = realpathSync(
        join(dirname(probePath), `${expected.name}.probe-report.json`),
      );
      if (dirname(reportPath) !== dirname(probePath))
        throw new Error("Actual probe report is outside its owned directory");
      const bytes = readFileSync(reportPath),
        report = JSON.parse(bytes.toString("utf8")).report;
      if (!report) throw new Error("Actual tool report is missing");
      raw[label] = { ...actual, report };
      console.log(
        JSON.stringify({
          evt: "w302.input.proof",
          label,
          size: actual.size,
          sha256: actual.sha256,
          reportSha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      );
    }
    const rawFile = join(temporary, "input-probe-reports.json");
    writeFileSync(rawFile, JSON.stringify(raw), { mode: 0o600 });
    const projected = JSON.parse(
      await run(
        "pnpm",
        [
          "--silent",
          "--filter",
          "@liyoxi/services",
          "exec",
          "tsx",
          "--input-type=module",
          "--eval",
          'import { readFileSync } from "node:fs"; import { outputBatchInputFromProbe } from "@liyoxi/services/testing"; const x=JSON.parse(readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify({video:outputBatchInputFromProbe(x.video,x.video.report),resumeVideo:outputBatchInputFromProbe(x.resumeVideo,x.resumeVideo.report)}));',
          rawFile,
        ],
        testEnv,
        { capture: true },
      ),
    );
    video.probe = projected.video.probe;
    resumeVideo.probe = projected.resumeVideo.probe;
    databaseRequested = true;
    console.log(`W302 live owned database ${name}; Redis ${prefix}`);
    await run("pnpm", ["test:db:seeded", "--name", name], baseEnv);
    const bootstrap = await run(
      "pnpm",
      ["staff:bootstrap", "--name", "验收管理员", "--phone", "13800138001"],
      testEnv,
      { capture: true },
    );
    const activationCode = /激活码：([A-Z0-9]{8})/.exec(bootstrap)?.[1];
    if (!activationCode) throw new Error("The real staff bootstrap returned no activation code");
    const fixtures = JSON.parse(
      await run(
        "pnpm",
        [
          "--silent",
          "--filter",
          "@liyoxi/services",
          "admin:live:data",
          "--name",
          name,
          "--test-redis-prefix",
          prefix,
        ],
        testEnv,
        { capture: true },
      ),
    );
    writeFileSync(
      inputFile,
      `${JSON.stringify({ current: fixtures.fixtures.w302.scope, legacy: fixtures.fixtures["zz-delivery-flow"].scope, w120: fixtures.fixtures.w120.stage === "awaiting_actual_media" ? fixtures.fixtures.w120 : undefined, w312: fixtures.fixtures.w312, w318: fixtures.fixtures["merchant-assets-write"].scope, w418Invoice: fixtures.fixtures.w418?.invoices?.scope, video, resumeVideo })}\n`,
      { mode: 0o600 },
    );
    await run(
      "pnpm",
      [
        "--filter",
        "@liyoxi/admin",
        "exec",
        "vite",
        "build",
        "--mode",
        "production",
        "--outDir",
        appOut,
      ],
      baseEnv,
    );
    await run(process.execPath, ["scripts/check-build.mjs", appOut, "--app", "admin"], baseEnv, {
      cwd: ADMIN,
    });
    await buildApi(baseEnv);
    const server = await startApi(testEnv, image);
    const w120Pending = fixtures.fixtures.w120;
    if (w120Pending.stage === "awaiting_actual_media") {
      if (!server.w120?.unknownMetadataRejectedWithoutWrites || server.w120.items?.length !== 2)
        throw new Error("W120 actual production/QC fixture did not finish");
      fixtures.fixtures.w120 = {
        ...server.w120,
        items: server.w120.items.map((item) => {
          const pending = w120Pending.items.find(
            (p) =>
              p.scope.itemId === item.itemId &&
              p.scope.ticketId === item.ticketId &&
              p.outcome === item.outcome,
          );
          if (!pending) throw new Error("W120 completed fixture scope changed");
          return { ...item, headers: pending.headers };
        }),
      };
    } else if (
      w120Pending.stage !== undefined ||
      !w120Pending.unknownMetadataRejectedWithoutWrites ||
      w120Pending.items?.length !== 2
    ) {
      throw new Error("W120 completed legacy fixture is missing its original proof");
    }
    if (!(await fetch(`${server.apiOrigin}/readyz`)).ok)
      throw new Error("The actual API is not ready");
    const origin = await serveProduction(server.apiOrigin);
    fixtures.fixtures.w302 = {
      ...fixtures.fixtures.w302,
      bridgeOrigin: server.cosOrigin,
      video,
      resumeVideo,
    };
    fixtures.w302BridgeOrigin = server.cosOrigin;
    writeFileSync(
      contextFile,
      `${JSON.stringify({ origin, name: "验收管理员", phone: "13800138001", password: "Liyoxi-2026-ok", activationCode, storageState: stateFile, fixtures })}\n`,
      { mode: 0o600 },
    );
    await run(
      "pnpm",
      ["--filter", "@liyoxi/admin", "exec", "playwright", "test", "--project=live", ...testFiles],
      {
        ...toolEnv,
        LYX_ADMIN_LIVE: "1",
        LYX_ADMIN_LIVE_ORIGIN: origin,
        LYX_ADMIN_LIVE_CONTEXT: contextFile,
        LYX_ADMIN_LIVE_STATE: stateFile,
      },
    );
  } finally {
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise((accept) => proxy.close(accept));
    }
    await stopChildren();
    try {
      if (databaseRequested)
        await run(
          "pnpm",
          [
            "--silent",
            "--filter",
            "@liyoxi/services",
            "admin:live:data",
            "--cleanup",
            "--name",
            name,
            "--test-redis-prefix",
            prefix,
          ],
          baseEnv,
          { cleanup: true },
        );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
      rmSync(join(ADMIN, appOut), { recursive: true, force: true });
      rmSync(join(ROOT, "apps/api", apiOut), { recursive: true, force: true });
    }
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    interrupted = true;
    for (const child of children) terminate(child);
  });
export async function runLiveOutputBatch(args = process.argv.slice(2)) {
  const prepared = await prepareLiveMedia(args);
  let passed = false;
  try {
    await main(prepared.args);
    passed = true;
  } finally {
    prepared.close(passed);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runLiveOutputBatch().catch((error) => {
    console.error(`真实后台验收失败：${error.message}`);
    process.exitCode = 1;
  });
