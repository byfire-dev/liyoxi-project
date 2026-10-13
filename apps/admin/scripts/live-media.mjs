// 只准备测试输入。最终 file/job/check/ready 仍由原 live 的真实执行器产生。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { selectedLiveTests } from "./live-selection.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const mediaKeys = ["video", "resume-video", "probe-facts"];

async function runTool(args, { input, capture = false, timeout = 60_000 } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn("docker", args, { cwd: root, stdio: ["pipe", "pipe", "inherit"] });
    let output = "";
    let killTimer;
    const stop = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 10_000);
    };
    const timer = setTimeout(stop, timeout);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    child.stdout.on("data", (chunk) => {
      if (capture) output += chunk;
      else process.stdout.write(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (code === 0) accept(output.trim());
      else reject(new Error(`测试媒体 Docker ${args[0]} 失败（${signal ?? code}）`));
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}

export async function prepareLiveMedia(args, { run = runTool } = {}) {
  if (!/^(24|26)\./.test(process.versions.node))
    throw new Error("真实后台验收需要 Node24，或夜间兼容检查使用的 Node26");
  if (process.env.APP_ENV && process.env.APP_ENV !== "test")
    throw new Error("真实后台验收只允许 APP_ENV=test");
  const { values } = parseArgs({
    args,
    options: Object.fromEntries(
      [...mediaKeys, "mediatool-image", "test-file"].map((key) => [key, { type: "string" }]),
    ),
  });
  const supplied = mediaKeys.filter((key) => values[key] !== undefined);
  if (supplied.length !== 0 && supplied.length !== mediaKeys.length)
    throw new Error("复用输入须同时提供 --video、--resume-video 和 --probe-facts");
  if (values["mediatool-image"] && !imagePattern.test(values["mediatool-image"]))
    throw new Error("--mediatool-image 必须为已验证的完整 sha256 镜像 ID");
  selectedLiveTests(values["test-file"]);
  if (supplied.length === 3 && values["mediatool-image"]) return { args, close: () => undefined };

  const directory = mkdtempSync("/tmp/lyx-w302-live-media-");
  const runId = randomBytes(8).toString("hex");
  const container = `lyx-w302-fixtures-${runId}`;
  const volume = `${container}-work`;
  let volumeCreated = false;
  let containerCreated = false;
  let volumeAttempted = false;
  let containerAttempted = false;
  async function ownedExists(kind, name) {
    const names = await run(
      [
        kind,
        "ls",
        ...(kind === "container" ? ["--all"] : []),
        "--filter",
        `name=^${kind === "container" ? "/" : ""}${name}$`,
        "--format",
        kind === "container" ? "{{.Names}}" : "{{.Name}}",
      ],
      { capture: true },
    );
    if (!names.split("\n").includes(name)) return false;
    const label = await run(
      [
        kind,
        "inspect",
        "--format",
        kind === "container"
          ? '{{index .Config.Labels "lyx.test.run"}}'
          : '{{index .Labels "lyx.test.run"}}',
        name,
      ],
      { capture: true },
    );
    if (label !== runId) throw new Error(`测试媒体 ${kind} ${name} 归属无法确认，保留对象`);
    return true;
  }
  try {
    if (!values["mediatool-image"]) {
      const imageFile = join(directory, "image-id");
      // Dockerfile 固定基础镜像与 ffmpeg；默认构建可复用本机缓存，不更新依赖。
      await run(["build", "--iidfile", imageFile, "infra/docker/mediatool"], {
        timeout: 30 * 60_000,
      });
      const image = readFileSync(imageFile, "utf8").trim();
      if (!imagePattern.test(image)) throw new Error("Docker 未返回精确镜像 ID");
      values["mediatool-image"] = image;
    }
    if (supplied.length === 0) {
      const output = join(directory, "legal-media");
      mkdirSync(output, { mode: 0o700 });
      volumeAttempted = true;
      await run(["volume", "create", "--label", `lyx.test.run=${runId}`, volume]);
      volumeCreated = true;
      containerAttempted = true;
      await run([
        "create",
        "--name",
        container,
        "--label",
        `lyx.test.run=${runId}`,
        "--interactive",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--cpus",
        "1",
        "--memory",
        "1g",
        "--pids-limit",
        "128",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--mount",
        `type=volume,source=${volume},target=/work`,
        "--entrypoint",
        "node",
        values["mediatool-image"],
        "--input-type=module",
      ]);
      containerCreated = true;
      let generationError;
      try {
        await run(["start", "--attach", "--interactive", container], {
          input: readFileSync(new URL("./live-media-generate.mjs", import.meta.url), "utf8"),
          timeout: 240_000,
        });
      } catch (error) {
        generationError = error;
      }
      // CLI 失败或中断不等于容器已停；确认终止后才取输入和回收卷。
      await run(["stop", "--time", "10", container]);
      const running = await run(["inspect", "--format", "{{.State.Running}}", container], {
        capture: true,
      });
      if (running !== "false") throw new Error("无法确认测试造片容器已终止，保留其卷");
      try {
        await run(["cp", `${container}:/work/legal-media/.`, output]);
      } catch (error) {
        if (!generationError) throw error;
        generationError = new AggregateError(
          [generationError, error],
          "造片失败且无法取回部分输入",
        );
      }
      await run(["rm", container]);
      containerCreated = false;
      containerAttempted = false;
      await run(["volume", "rm", volume]);
      volumeCreated = false;
      volumeAttempted = false;
      if (generationError) throw generationError;
      values.video = join(output, "standard-20s.mp4");
      values["resume-video"] = join(output, "multipart-20s.mp4");
      values["probe-facts"] = join(output, "manifest.json");
    }
    return {
      args: Object.entries(values).flatMap(([key, value]) => [`--${key}`, value]),
      close(success) {
        if (success) rmSync(directory, { recursive: true });
        else console.error(`本轮真实媒体输入保留于 ${directory}`);
      },
    };
  } catch (error) {
    // 只回收本轮且已确认终止的资源；不能确认时保留并报失败。
    try {
      if (containerCreated || (containerAttempted && (await ownedExists("container", container)))) {
        await run(["stop", "--time", "10", container]);
        const running = await run(["inspect", "--format", "{{.State.Running}}", container], {
          capture: true,
        });
        if (running !== "false") throw new Error("测试造片容器状态未知", { cause: error });
        await run(["rm", container]);
        containerCreated = false;
        containerAttempted = false;
      }
      if (volumeCreated || (volumeAttempted && (await ownedExists("volume", volume))))
        await run(["volume", "rm", volume]);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `测试媒体准备及清理失败；容器 ${container}；卷 ${volume}；保留 ${directory}`,
        { cause: cleanupError },
      );
    }
    throw new Error(`测试媒体准备失败；保留 ${directory}`, { cause: error });
  }
}
