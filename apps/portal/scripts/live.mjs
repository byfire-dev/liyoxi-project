import { fork, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { collectSafeArtifacts, publishSafeArtifacts } from "./live-artifacts.mjs";
import { createLiveEdge, createOwnedDirectory, createTestTls } from "./live-edge.mjs";
import {
  apiEnvironment,
  assertVersion,
  childEvent,
  createHandshake,
  diagnosticLine,
  startMessage,
} from "./live-protocol.mjs";

const PORTAL = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(PORTAL, "../..");
const fail = () => new Error("PORTAL_LIVE_PROCESS_FAILED");
function killed(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw fail();
  }
}
function exitOf(child) {
  return new Promise((accept) => {
    child.once("error", () => accept({ code: null }));
    child.once("close", (code) => accept({ code }));
  });
}
async function finishChild(child, exited, stop) {
  if (!child) return true;
  if (child.exitCode !== null || child.signalCode !== null) return (await exited).code === 0;
  let timer;
  const overdue = new Promise((accept) => {
    timer = setTimeout(() => {
      killed(child, "SIGKILL");
      void exited.then(() => accept(false));
    }, 10_000);
  });
  try {
    stop();
    return await Promise.race([exited.then((result) => result.code === 0), overdue]);
  } finally {
    clearTimeout(timer);
  }
}
function toolEnvironment() {
  const env = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "CI",
    "PLAYWRIGHT_BROWSERS_PATH",
  ])
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  if (process.env.LYX_E2E_CHANNEL) {
    if (process.env.LYX_E2E_CHANNEL !== "chrome") throw fail();
    env.LYX_E2E_CHANNEL = "chrome";
  }
  return env;
}

async function run() {
  if (process.argv.length !== 2 || Number(process.versions.node.split(".")[0]) !== 24) throw fail();
  const version = assertVersion(process.env.LYX_BUILD),
    backendEnv = apiEnvironment(process.env);
  const runId = randomBytes(6).toString("hex"),
    begun = performance.now();
  const owned = await createOwnedDirectory(runId),
    stage = join(owned.directory, "stage");
  let edge,
    api,
    apiExit,
    browser,
    browserExit,
    apiClosed = false,
    processPassed = false,
    cleanup = true;
  let artifacts,
    unsafe = false,
    interrupted = false;
  const diagnostics = [];
  const note = (stageName, code) => {
    const event = { stage: stageName, code };
    diagnostics.push(event);
    process.stdout.write(diagnosticLine(event));
  };
  const interrupt = () => {
    interrupted = true;
    if (browser) killed(browser, "SIGTERM");
    if (api?.stopLive) api.stopLive();
    else if (api) killed(api, "SIGTERM");
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await mkdir(stage, { mode: 0o700 });
    note("scope", "STARTED");
    const tls = await createTestTls(owned.directory);
    edge = await createLiveEdge({ directory: owned.directory, tls });
    const staticRoot = join(owned.directory, "static");
    // Do not let Vite diagnostics capture source inputs; build failures use the fixed outer code.
    const logger = {
      hasWarned: false,
      info() {},
      warn() {},
      warnOnce() {},
      error() {},
      clearScreen() {},
      hasErrorLogged() {
        return false;
      },
    };
    await build({
      root: PORTAL,
      configFile: join(PORTAL, "vite.config.ts"),
      envFile: false,
      mode: "portal-live",
      customLogger: logger,
      build: {
        outDir: staticRoot,
        emptyOutDir: false,
        sourcemap: false,
        rolldownOptions: { input: join(PORTAL, "test/e2e/browser-session.html") },
      },
    });
    if (interrupted) throw fail();
    const start = startMessage({
      runId,
      portalOrigin: edge.origin,
      version,
      directory: owned.directory,
    });
    const handshake = createHandshake(start);
    api = fork(join(ROOT, "apps/api/test/portal-shell-live-server.ts"), [], {
      cwd: join(ROOT, "apps/api"),
      execPath: process.execPath,
      execArgv: ["--import", "tsx"],
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...backendEnv, LYX_BUILD: version },
    });
    apiExit = exitOf(api);
    let stopRequested = false;
    api.stopLive = () => {
      stopRequested = true;
      const message = handshake.stop();
      if (api.connected) api.send(message, () => {});
    };
    // No raw API/loader output is retained or forwarded, including failed startup output.
    api.stdout.on("data", () => {});
    api.stderr.on("data", () => {});
    const ready = await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(fail()), 60_000);
      const settle = (event) => {
        clearTimeout(timer);
        accept(event);
      };
      api.once("error", () => {
        clearTimeout(timer);
        reject(fail());
      });
      api.once("close", () => {
        clearTimeout(timer);
        reject(fail());
      });
      api.on("message", (raw) => {
        try {
          if (stopRequested && raw?.event === "ready") {
            childEvent(raw, start); // A queued ready must still be owned, but cannot activate after stop.
            return;
          }
          const event = handshake.receive(raw);
          if (event.event === "ready") {
            note("runtime", "READY");
            settle(event);
          } else if (event.event === "closed") {
            apiClosed = true;
            note("closing", "CLOSED");
          } else {
            note(event.stage, "FAILED");
            clearTimeout(timer);
            reject(fail());
          }
        } catch {
          unsafe = true;
          clearTimeout(timer);
          reject(fail());
        }
      });
      api.send(start, (error) => {
        if (error) {
          clearTimeout(timer);
          reject(fail());
        }
      });
    });
    await edge.activate({ apiPort: ready.apiPort, root: staticRoot });
    await writeFile(
      join(owned.directory, "context.json"),
      `${JSON.stringify({ runId, version, origin: edge.origin, controlSocketPath: start.controlSocketPath, stageDirectory: stage, actors: ready.actors })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    if (interrupted) throw fail();
    const playwrightCli = fileURLToPath(import.meta.resolve("@playwright/test/cli"));
    browser = spawn(process.execPath, [playwrightCli, "test", "--config", "playwright.config.ts"], {
      cwd: PORTAL,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...toolEnvironment(), LYX_PORTAL_LIVE_RUN_ID: runId, LYX_BUILD: version },
    });
    browserExit = exitOf(browser);
    browser.stdout.on("data", () => {});
    browser.stderr.on("data", () => {});
    processPassed = (await browserExit).code === 0 && !interrupted;
    note("control", processPassed ? "READY" : "FAILED");
  } catch {
    note("runtime", "FAILED");
  } finally {
    try {
      if (browser && !(await finishChild(browser, browserExit, () => killed(browser, "SIGTERM"))))
        processPassed = false;
    } catch {
      cleanup = false;
    }
    // Read strict candidates after the reporter has stopped and before deleting private files.
    try {
      artifacts = await collectSafeArtifacts(stage);
    } catch {
      unsafe = true;
    }
    try {
      if (api) {
        const exited = await finishChild(api, apiExit, () =>
          api.stopLive ? api.stopLive() : killed(api, "SIGTERM"),
        );
        if (!exited || !apiClosed) cleanup = false;
      }
    } catch {
      cleanup = false;
    }
    try {
      await edge?.close();
    } catch {
      cleanup = false;
    }
    try {
      await owned.close();
    } catch {
      cleanup = false;
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  if (unsafe || !artifacts) throw new Error("PORTAL_LIVE_SAFE_OUTPUT_REJECTED");
  const result = await publishSafeArtifacts(join(PORTAL, "dist/e2e-live-safe"), {
    runId,
    version,
    durationMs: performance.now() - begun,
    cleanup: cleanup ? "confirmed" : "unconfirmed",
    processPassed,
    diagnostics,
    artifacts,
  });
  process.stdout.write(
    `${JSON.stringify({ event: "portal.live.finished", runId, success: result.success, cleanup: result.cleanup })}\n`,
  );
  if (!result.success) process.exitCode = 1;
}

void run().catch(() => {
  process.stderr.write("PORTAL_LIVE_FAILED\n");
  process.exitCode = 1;
});
