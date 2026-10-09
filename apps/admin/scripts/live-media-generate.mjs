// 仅在固定 mediatool 镜像、CPU1 的本轮命名卷内执行；生成真实字节，不 padding。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { probe } from "/app/ops.mjs";

const output = "/work/legal-media";
if (existsSync(output)) throw new Error("本轮输入已存在，不覆盖或自动重造");
mkdirSync(output, { mode: 0o700 });
const version = execFileSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8" }).split(
  "\n",
)[0];
if (!version.startsWith("ffmpeg version 5.1.9")) throw new Error("固定 ffmpeg 版本不符");
const results = [];
for (const [name, noisy] of [
  ["standard-20s.mp4", false],
  ["multipart-20s.mp4", true],
]) {
  const path = `${output}/${name}`;
  const video = `testsrc2=size=720x1280:rate=30${noisy ? ",noise=alls=80:allf=t+u" : ""}`;
  const args = [
    "-hide_banner",
    "-v",
    "error",
    "-nostdin",
    "-n",
    "-filter_threads",
    "1",
    "-filter_complex_threads",
    "1",
    "-f",
    "lavfi",
    "-i",
    video,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-t",
    "20",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    "1",
    ...(noisy ? ["-b:v", "10M", "-maxrate", "10M", "-bufsize", "20M"] : ["-crf", "23"]),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    path,
  ];
  const started = new Date().toISOString();
  execFileSync("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"], timeout: 240_000 });
  const raw = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", path],
    { encoding: "utf8", timeout: 10_000 },
  );
  writeFileSync(`${path}.ffprobe.json`, raw, { flag: "wx" });
  const probed = await probe({ path: `legal-media/${name}`, demuxers: ["mov"] });
  writeFileSync(`${path}.probe-report.json`, `${JSON.stringify(probed, null, 2)}\n`, {
    flag: "wx",
  });
  const facts = JSON.parse(raw);
  const videos = facts.streams.filter((stream) => stream.codec_type === "video");
  const audios = facts.streams.filter((stream) => stream.codec_type === "audio");
  const size = statSync(path).size;
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  const checks = {
    duration: Number(facts.format.duration) >= 20 && Number(facts.format.duration) <= 20.1,
    video:
      videos.length === 1 &&
      videos[0].codec_name === "h264" &&
      ["Main", "High"].includes(videos[0].profile) &&
      videos[0].pix_fmt === "yuv420p" &&
      videos[0].width === 720 &&
      videos[0].height === 1280,
    audio: audios.length === 1 && audios[0].codec_name === "aac",
    faststart: probed.report.moovBeforeMdat === true,
    serviceDuration:
      probed.report.format.durationMs >= 20_000 && probed.report.format.durationMs <= 20_100,
    size: !noisy || size > 20 * 1024 * 1024,
  };
  results.push({
    name,
    started,
    ended: new Date().toISOString(),
    args,
    version,
    size,
    sha256: hash.digest("hex"),
    checks,
  });
  const passed = results.every((result) => Object.values(result.checks).every(Boolean));
  writeFileSync(
    `${output}/manifest.json`,
    `${JSON.stringify(
      {
        state: passed ? "GENERATED_OBSERVATION" : "FAILED_OBSERVATION",
        singleGeneration: true,
        noPadding: true,
        results,
      },
      null,
      2,
    )}\n`,
  );
  if (!passed) throw new Error("合法输入校验失败，保留首次结果，不自动重试");
}
