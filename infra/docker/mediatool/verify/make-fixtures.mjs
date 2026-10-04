// @ts-check
// 造测试片（任务书 第 10 节第 5 项）。在 mediatool 镜像里跑：用镜像里那个钉死版本的 ffmpeg 现场生成，不入库。
// 用法：node make-fixtures.mjs [small|bench]。bench 另造一条约 200MB 的片子。产物都放共享目录的 fx/ 下。
//
// 这里的 ffmpeg / ffprobe 是直接调的，不经过服务，也不带服务那一套输入约束：
// 一是造片，二是做“对照”（不带约束时会怎样），对照结果写进 manifest.json 的 controls，用例拿它与服务的表现对比。
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";

import { aliasReference, rotate90, singleSync } from "./lib/mp4.mjs";
import { AIGC, ARMED, BIG, FX, PORTRAIT, ROTATED, SLOW, UPSTREAM_AIGC, WORK } from "./lib/spec.mjs";

const mode = process.argv[2] ?? "small";
const dir = join(WORK, FX);
const at = (/** @type {string} */ name) => join(dir, name);
const started = Date.now();
const log = (/** @type {string} */ line) =>
  console.log(`[fixtures +${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);

/** @param {string[]} args */
function ffmpeg(args) {
  execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-nostdin", "-y", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
}

/** 不抛错的调用，给对照用 @param {string} bin @param {string[]} args */
function attempt(bin, args) {
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: 20_000 });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "").trim().replace(/\s+/g, " ").slice(-300),
  };
}

/** 直接用 ffprobe 读容器级的标签 @param {string} name @returns {Record<string, string>} */
function formatTags(name) {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_format", "-of", "json", at(name)], {
    encoding: "utf8",
  });
  return JSON.parse(out).format?.tags ?? {};
}

/** @param {string} name */
const hasAigc = (name) => Object.keys(formatTags(name)).some((key) => key.toLowerCase() === "aigc");

/** 访问时间拨回 ARMED：之后还是 ARMED 就说明没有人读过 @param {string} path */
const arm = (path) => utimesSync(path, ARMED, statSync(path).mtime);
/** @param {string} path */
const wasRead = (path) => statSync(path).atime.getTime() !== ARMED.getTime();

const video = (/** @type {{ width: number, height: number, fps: number }} */ spec, noisy = false) =>
  `testsrc2=size=${spec.width}x${spec.height}:rate=${spec.fps}${noisy ? ",noise=alls=30:allf=t+u" : ""}`;
const TONE = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"];
const H264_HIGH = ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high"];
const AAC = ["-c:a", "aac", "-b:a", "128k", "-ac", "2"];

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// ---------- 正常的片子 ----------

// 竖屏 1080×1920 的 H.264 + AAC，moov 在前
ffmpeg([
  ...["-f", "lavfi", "-i", video(PORTRAIT)],
  ...TONE,
  ...["-t", String(PORTRAIT.seconds), ...H264_HIGH, "-pix_fmt", "yuv420p", "-g", "60", ...AAC],
  ...["-movflags", "+faststart", "-f", "mp4", at("portrait.mp4")],
]);
// 同一条片子，moov 在后（不带 faststart 的重封装）
ffmpeg(["-i", at("portrait.mp4"), "-map", "0", "-c", "copy", "-f", "mp4", at("slowstart.mp4")]);
// 横着编码、带旋转元数据：显示出来是竖的
ffmpeg([
  ...["-f", "lavfi", "-i", video(ROTATED)],
  ...TONE,
  ...["-t", String(ROTATED.seconds), ...H264_HIGH, "-pix_fmt", "yuv420p", ...AAC],
  ...["-movflags", "+faststart", "-f", "mp4", at("rotated.mp4")],
]);
const rotated = readFileSync(at("rotated.mp4"));
rotate90(rotated, ROTATED.height);
writeFileSync(at("rotated.mp4"), rotated);
// 带时间码轨的 mov（剪辑软件导出的常见形态）：多一条 mp4 装不下的数据轨
ffmpeg([
  ...["-f", "lavfi", "-i", "testsrc2=size=320x568:rate=30", "-t", "1"],
  ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"],
  ...["-timecode", "00:00:00:00", "-f", "mov", at("timecode.mov")],
]);
// 已带 AIGC 的一条（上游工具写的）
const stamp = (
  /** @type {object} */ aigc,
  /** @type {string} */ movflags,
  /** @type {string} */ name,
) =>
  ffmpeg([
    ...["-i", at("portrait.mp4"), "-map", "0", "-c", "copy"],
    ...["-metadata", `AIGC=${JSON.stringify(aigc)}`, "-movflags", movflags, "-f", "mp4", at(name)],
  ]);
stamp(UPSTREAM_AIGC, "+faststart+use_metadata_tags", "tagged.mp4");
// 反例：加标时去掉 use_metadata_tags
stamp(AIGC, "+faststart", "stamped-no-umt.mp4");
// 对照用：已带标识的片子做一次普通的流拷贝重封装
ffmpeg([
  ...["-i", at("tagged.mp4"), "-map", "0", "-c", "copy"],
  ...["-movflags", "+faststart", "-f", "mp4", at("tagged-remuxed.mp4")],
]);
log("正常的片子与加标反例已生成");

// ---------- 有恶意的输入 ----------

// 伪装成 mp4 的播放列表：引用同目录下的一个文件与一个外部地址（192.0.2.1 是 RFC 5737 留给文档的地址）
ffmpeg([
  ...["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10", "-t", "1"],
  ...[
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-f",
    "mpegts",
    at("canary.ts"),
  ],
]);
writeFileSync(
  at("playlist.mp4"),
  [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:1",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXTINF:1.0,",
    "canary.ts",
    "#EXTINF:1.0,",
    "http://192.0.2.1/lyx-x02-canary.ts",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n"),
);

// 带外部引用的 mov：视频数据在 dref-target.mov 里，dref.mov 自己的媒体数据是空的
ffmpeg([
  ...["-f", "lavfi", "-i", "testsrc2=size=320x568:rate=10", "-t", "2"],
  ...[
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-f",
    "mov",
    at("dref-target.mov"),
  ],
]);
writeFileSync(
  at("dref.mov"),
  aliasReference(readFileSync(at("dref-target.mov")), "dref-target.mov"),
);

// 跑不完的输入：只有第一帧是同步帧，抽末尾的一帧要把前面的全解一遍
ffmpeg([
  ...["-f", "lavfi", "-i", video({ ...PORTRAIT, fps: SLOW.fps }, true), "-t", "8"],
  ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "240"],
  ...["-b:v", "4M", "-maxrate", "4M", "-bufsize", "8M", "-f", "mp4", at("slow-seg.mp4")],
]);
ffmpeg([
  ...["-stream_loop", String(SLOW.seconds / 8 - 1), "-i", at("slow-seg.mp4")],
  ...["-c", "copy", "-f", "mp4", at("slow.mp4")],
]);
rmSync(at("slow-seg.mp4"));
const slow = readFileSync(at("slow.mp4"));
const syncBefore = singleSync(slow);
writeFileSync(at("slow.mp4"), slow);
log(`有恶意的输入已生成（slow.mp4 原有 ${syncBefore} 个同步帧，改成只剩 1 个）`);

// ---------- 对照：不带服务那一套约束时会怎样 ----------

// 访问时间在这个卷上管不管用
writeFileSync(at("atime-probe.bin"), "x");
arm(at("atime-probe.bin"));
readFileSync(at("atime-probe.bin"));
const atimeTracked = wasRead(at("atime-probe.bin"));
rmSync(at("atime-probe.bin"));

// 播放列表：不强制解复用器，让 ffprobe 自己按内容认
arm(at("canary.ts"));
const loose = attempt("ffprobe", [
  "-v",
  "error",
  "-show_format",
  "-show_streams",
  "-of",
  "json",
  at("playlist.mp4"),
]);
let looseFormat = null;
let looseStreams = 0;
try {
  const parsed = JSON.parse(loose.stdout);
  looseFormat = parsed.format?.format_name ?? null;
  looseStreams = (parsed.streams ?? []).length;
} catch {
  // 没有输出
}
const playlist = {
  code: loose.code,
  formatName: looseFormat,
  streams: looseStreams,
  referencedFileRead: wasRead(at("canary.ts")),
  stderr: loose.stderr,
};

// 外部引用：打开 enable_drefs 时抽得出帧，说明这条 mov 的引用是活的
const drefArgs = (/** @type {string} */ flag) => [
  ...["-hide_banner", "-v", "error", "-nostdin", "-y", "-enable_drefs", flag, "-i", at("dref.mov")],
  ...["-frames:v", "1", "-f", "image2", "-update", "1", at(`dref-control-${flag}.jpg`)],
];
const frameOut = (/** @type {string} */ flag) =>
  existsSync(at(`dref-control-${flag}.jpg`)) && statSync(at(`dref-control-${flag}.jpg`)).size > 0;
arm(at("dref-target.mov"));
const drefOn = attempt("ffmpeg", drefArgs("1"));
const dref = {
  followedWhenEnabled: drefOn.code === 0 && frameOut("1"),
  targetReadWhenEnabled: wasRead(at("dref-target.mov")),
  stderrWhenEnabled: drefOn.stderr,
  frameWhenDisabled: false,
};
attempt("ffmpeg", drefArgs("0"));
dref.frameWhenDisabled = frameOut("0");
for (const flag of ["0", "1"]) rmSync(at(`dref-control-${flag}.jpg`), { force: true });

const controls = {
  atimeTracked,
  aigcReadableWithUseMetadataTags: formatTags("tagged.mp4").AIGC === JSON.stringify(UPSTREAM_AIGC),
  aigcDroppedWithoutUseMetadataTags: !hasAigc("stamped-no-umt.mp4"),
  aigcDroppedByPlainRemux: !hasAigc("tagged-remuxed.mp4"),
  playlist,
  dref,
};
log(`对照：${JSON.stringify(controls)}`);

// ---------- 约 200MB 的片子（只在 bench 时造） ----------

if (mode === "bench") {
  // 一段 20 秒、约 8Mbps 的片子流拷贝接 10 遍：约 200MB、200 秒，每 2 秒一个关键帧
  const rate = Math.round((BIG.targetBytes * 8) / BIG.seconds / 1000) - 128 - 40;
  ffmpeg([
    ...["-f", "lavfi", "-i", video(PORTRAIT, true)],
    ...TONE,
    ...["-t", "20", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "60"],
    ...["-b:v", `${rate}k`, "-minrate", `${rate}k`, "-maxrate", `${rate}k`, "-bufsize", `${rate}k`],
    ...["-x264-params", "nal-hrd=cbr", ...AAC, "-f", "mp4", at("big-seg.mp4")],
  ]);
  ffmpeg([
    ...["-stream_loop", String(BIG.seconds / 20 - 1), "-i", at("big-seg.mp4")],
    ...["-map", "0", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", at("big.mp4")],
  ]);
  rmSync(at("big-seg.mp4"));
  log(`big.mp4：${(statSync(at("big.mp4")).size / 1024 / 1024).toFixed(1)}MB`);
}

// ---------- 业主给的样片（任务书 第 8 节）：有就拷进来加测 ----------

/** @type {{ file: string, original: string }[]} */
const samples = [];
if (existsSync("/samples")) {
  const names = readdirSync("/samples").filter((name) => /\.(mp4|mov|m4v)$/i.test(name));
  if (names.length > 0) mkdirSync(join(WORK, "samples"), { recursive: true });
  names.sort().forEach((name, index) => {
    const file = `sample-${String(index + 1).padStart(2, "0")}${extname(name).toLowerCase()}`;
    copyFileSync(join("/samples", name), join(WORK, "samples", file));
    samples.push({ file, original: name });
  });
}

const version = execFileSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8" });
const files = Object.fromEntries(readdirSync(dir).map((name) => [name, statSync(at(name)).size]));
writeFileSync(
  at("manifest.json"),
  JSON.stringify(
    {
      mode,
      ffmpeg: version.split("\n")[0],
      armedAt: ARMED.toISOString(),
      files,
      controls,
      samples,
    },
    null,
    2,
  ),
);
log(`完成：${Object.keys(files).length} 个文件，样片 ${samples.length} 条`);
