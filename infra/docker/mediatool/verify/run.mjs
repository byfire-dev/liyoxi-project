// @ts-check
// 狸有戏 · mediatool 验证的编排（X-02 任务书 第 7 节）。在宿主机上跑，只用 Node 内置模块；本机要有 Docker。
//
//   pnpm mediatool:verify   构建镜像 → 起 compose.verify.yml → 造测试片 → 在调用端容器里跑 verify/cases/ 的用例
//                           → 用 docker inspect 核对容器配置、看有没有残留进程 → 收尾（容器与卷都删掉）
//   pnpm mediatool:bench    同样的流程，另造一条约 200MB 的片子，跑 verify/bench.mjs 量耗时
//
// 环境变量（都可以不设）：
//   LYX_MEDIATOOL_PROJECT  Compose 的项目名。同一台机器上两份检出同时跑时各设一个，免得互相拆台
//   LYX_MEDIATOOL_OUT      报告写到哪个目录，缺省是系统临时目录下的 lyx-mediatool-out（不写进仓库）
// 业主给的样片放 ~/.lyx/samples/x02/ 即自动加测（任务书 第 8 节）；没有就跳过并注明。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "verify" && mode !== "bench") {
  console.error("用法：node infra/docker/mediatool/verify/run.mjs verify|bench");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const IMAGE = "liyoxi/mediatool:verify";
const project = process.env.LYX_MEDIATOOL_PROJECT ?? "lyx-mediatool-verify";
const outDir = process.env.LYX_MEDIATOOL_OUT ?? join(tmpdir(), "lyx-mediatool-out");
const compose = ["compose", "-f", join(root, "compose.verify.yml"), "-p", project];

// Dockerfile 里钉死的版本（去掉 Debian 的纪元前缀），用例拿它核对镜像里实际装的
const pinned = /^ARG FFMPEG_DEB_VERSION=(?:\d+:)?(\S+)$/m.exec(
  readFileSync(join(root, "Dockerfile"), "utf8"),
)?.[1];
if (!pinned) throw new Error("Dockerfile 里找不到 ARG FFMPEG_DEB_VERSION");

const samplesDir = join(homedir(), ".lyx", "samples", "x02");
const hasSamples = existsSync(samplesDir);
const env = {
  ...process.env,
  LYX_EXPECT_FFMPEG: pinned,
  LYX_X02_SAMPLES: hasSamples ? samplesDir : join(here, "no-samples"),
};

/** @type {string[]} */
const failures = [];
const started = Date.now();
const stamp = () => `+${((Date.now() - started) / 1000).toFixed(0)}s`;
const say = (/** @type {string} */ line) => console.log(`\n== [${stamp()}] ${line}`);

/**
 * @param {string[]} args
 * @param {{ capture?: boolean, timeoutMs?: number }} [options]
 */
function docker(args, options = {}) {
  const result = spawnSync("docker", args, {
    env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    timeout: options.timeoutMs ?? 30 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "" };
}

/** 这一步不成就不用往下跑了 @param {string} what @param {{ status: number | null }} result */
function must(what, result) {
  if (result.status !== 0) throw new Error(`${what}失败（退出码 ${result.status}）`);
}

/** 核对一条，并记下结论 @param {string} what @param {boolean} pass @param {unknown} [actual] */
function check(what, pass, actual) {
  console.log(
    `${pass ? "ok  " : "FAIL"} ${what}${actual === undefined ? "" : `：${JSON.stringify(actual)}`}`,
  );
  if (!pass) failures.push(what);
}

/** 用 docker inspect 核对 mediatool 容器的配置（任务书 第 7 节第 5 条的后一半） */
function inspectSandbox() {
  const id = docker([...compose, "ps", "-q", "mediatool"], { capture: true }).stdout.trim();
  const info = JSON.parse(docker(["inspect", id], { capture: true }).stdout)[0];
  const host = info.HostConfig;
  const envKeys = (info.Config.Env ?? []).map((/** @type {string} */ pair) => pair.split("=")[0]);
  const secretLike =
    /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|DATABASE_URL|REDIS_URL|_DSN/i;
  const mounts = info.Mounts.map(
    (/** @type {any} */ mount) => `${mount.Type}:${mount.Destination}`,
  );
  check("NetworkMode=none", host.NetworkMode === "none", host.NetworkMode);
  check(
    "只接在 none 网络上，没有发布端口",
    Object.keys(info.NetworkSettings.Networks).join() === "none" &&
      Object.keys(info.NetworkSettings.Ports ?? {}).length === 0,
  );
  check("ReadonlyRootfs=true", host.ReadonlyRootfs === true, host.ReadonlyRootfs);
  check(
    "CapDrop=[ALL]，CapAdd 为空",
    JSON.stringify(host.CapDrop) === '["ALL"]' && (host.CapAdd ?? []).length === 0,
    host.CapDrop,
  );
  check(
    "no-new-privileges",
    (host.SecurityOpt ?? []).some((/** @type {string} */ opt) =>
      /^no-new-privileges(:true)?$/.test(opt),
    ),
    host.SecurityOpt,
  );
  check("Privileged=false", host.Privileged === false);
  check("PidsLimit=128", host.PidsLimit === 128, host.PidsLimit);
  check("内存上限 1GB", host.Memory === 1024 ** 3, host.Memory);
  check("CPU 上限 1 核", host.NanoCpus === 1e9, host.NanoCpus);
  check("/tmp 是 64MB 内存盘", /(^|,)size=64m(,|$)/.test(host.Tmpfs?.["/tmp"] ?? ""), host.Tmpfs);
  check("只挂了共享目录 /work（命名卷）", mounts.join() === "volume:/work", mounts);
  check("运行用户非 root", info.Config.User === "1000:1000", info.Config.User);
  check(
    "环境变量里没有密钥类的键",
    !envKeys.some((/** @type {string} */ key) => secretLike.test(key)),
    envKeys,
  );
  return {
    id: id.slice(0, 12),
    image: info.Image,
    envKeys,
    mounts,
    hostConfig: {
      NetworkMode: host.NetworkMode,
      ReadonlyRootfs: host.ReadonlyRootfs,
      CapDrop: host.CapDrop,
      SecurityOpt: host.SecurityOpt,
      PidsLimit: host.PidsLimit,
      Memory: host.Memory,
      NanoCpus: host.NanoCpus,
      Tmpfs: host.Tmpfs,
    },
    user: info.Config.User,
  };
}

/** 容器里现在有哪些进程：跑完用例之后只该剩服务本身 */
function leftoverProcesses() {
  const top = docker([...compose, "top", "mediatool"], { capture: true }).stdout;
  console.log(top.trim());
  const lines = top.split("\n").filter((line) => /\bff(mpeg|probe)\b/.test(line));
  check("容器里没有残留的 ffmpeg / ffprobe 进程", lines.length === 0, lines);
}

mkdirSync(outDir, { recursive: true });
/** @type {Record<string, unknown>} */
const report = { mode, pinnedFfmpeg: pinned, samples: hasSamples ? samplesDir : "无（跳过）" };
try {
  say(`构建镜像 ${IMAGE}`);
  must("docker build", docker(["build", "-t", IMAGE, root]));
  const banner = docker(
    ["run", "--rm", "--network", "none", IMAGE, "ffmpeg", "-hide_banner", "-version"],
    { capture: true },
  );
  const firstLine = banner.stdout.split("\n")[0] ?? "";
  console.log(firstLine);
  check(`镜像里的 ffmpeg 是钉死的 ${pinned}`, firstLine.startsWith(`ffmpeg version ${pinned} `));
  report.image = docker(
    ["image", "inspect", IMAGE, "--format", "{{.Id}} {{.Architecture}} {{.Size}}"],
    { capture: true },
  ).stdout.trim();

  say("起 mediatool 容器，等它健康");
  must("docker compose up", docker([...compose, "up", "-d", "--wait", "mediatool"]));

  say(
    `造测试片（${hasSamples ? `另加样片目录 ${samplesDir}` : "没有业主给的样片：只用自制测试片"}）`,
  );
  must(
    "造测试片",
    docker([
      ...compose,
      "run",
      "--rm",
      "fixtures",
      "node",
      "/verify/make-fixtures.mjs",
      mode === "bench" ? "bench" : "small",
    ]),
  );

  if (mode === "verify") {
    say("在调用端容器里跑用例");
    const cases = docker([...compose, "run", "--rm", "caller"]);
    check("verify/cases/ 的用例全部通过", cases.status === 0, cases.status);
    say("docker inspect：容器配置");
    report.inspect = inspectSandbox();
  } else {
    say("在调用端容器里量耗时");
    const bench = docker([...compose, "run", "--rm", "caller", "node", "/verify/bench.mjs"], {
      capture: true,
    });
    process.stdout.write(bench.stdout);
    const line = bench.stdout.split("\n").find((text) => text.startsWith("LYX-BENCH-REPORT "));
    if (line) report.bench = JSON.parse(line.slice("LYX-BENCH-REPORT ".length));
    check(
      "约 200MB 的测试片“体检 + 封面”合计不超过 10 秒",
      bench.status === 0 && Boolean(line),
      bench.status,
    );
  }

  say("容器里的进程");
  leftoverProcesses();
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err));
  console.error(err);
} finally {
  say("收尾：删掉容器与卷");
  const logs = docker([...compose, "logs", "--no-color", "mediatool"], { capture: true }).stdout;
  writeFileSync(join(outDir, `${mode}-mediatool.log`), logs);
  docker([...compose, "down", "-v", "--remove-orphans"]);
}

report.failures = failures;
report.seconds = Math.round((Date.now() - started) / 1000);
writeFileSync(join(outDir, `${mode}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
say(`报告：${join(outDir, `${mode}-report.json`)}`);
if (failures.length > 0) {
  console.error(`mediatool:${mode} 不通过：\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`mediatool:${mode} 通过（${report.seconds} 秒）`);
