import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  ftruncateSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import COS from "cos-nodejs-sdk-v5";
import { ConfigError, loadConfig } from "./config.ts";
export const fixtureSizes = [30, 50, 60, 100, 150, 200, 300, 500] as const;
// ISO BMFF free box adds inert bytes while retaining playable H.264/AAC + front moov.
export function padMp4(file: string, target: number) {
  const size = statSync(file).size;
  const padding = target - size;
  if (padding < 8 || padding > 0xffffffff) throw new Error("FIXTURE_SIZE_INVALID");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(padding);
  header.write("free", 4, "ascii");
  const fd = openSync(file, "r+");
  try {
    writeSync(fd, header, 0, 8, size);
    ftruncateSync(fd, target);
  } finally {
    closeSync(fd);
  }
}
export async function fixtures() {
  const config = loadConfig(process.env);
  if (config.mode === "fake") {
    console.log(`替身计划：${fixtureSizes.join(",")} MB；不生成、不上传媒体。`);
    return;
  }
  const root = path.resolve(import.meta.dirname, "../../dist/fixtures");
  mkdirSync(root, { recursive: true });
  const seed = path.join(root, "seed.mp4");
  const encoded = spawnSync(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=360x640:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100",
      "-t",
      "6",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "28",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-movflags",
      "+faststart",
      seed,
    ],
    { stdio: "ignore" },
  );
  if (encoded.error || encoded.status !== 0) throw new Error("FFMPEG_REQUIRED");
  const secret = config.secrets!;
  const cos = new COS({
    SecretId: secret.COS_SECRET_ID,
    SecretKey: secret.COS_SECRET_KEY,
    FileParallelLimit: 1,
    ChunkParallelLimit: 2,
    ChunkSize: 4 * 1024 * 1024,
    Timeout: 120_000,
  });
  for (const sizeMb of fixtureSizes) {
    const file = path.join(root, `${sizeMb}mb.mp4`);
    copyFileSync(seed, file);
    padMp4(file, sizeMb * 1_000_000);
    await new Promise<void>((resolve, reject) =>
      cos.sliceUploadFile(
        {
          Bucket: secret.COS_BUCKET,
          Region: secret.COS_REGION,
          Key: `${secret.COS_TEST_PREFIX}${sizeMb}mb.mp4`,
          FilePath: file,
          ContentType: "video/mp4",
        },
        (error) => (error ? reject(new Error("FIXTURE_UPLOAD_FAILED")) : resolve()),
      ),
    );
    console.log(`${sizeMb} MB 已生成并上传`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  fixtures().catch((error: unknown) => {
    console.error(
      error instanceof ConfigError
        ? error.message
        : error instanceof Error &&
            ["FFMPEG_REQUIRED", "FIXTURE_UPLOAD_FAILED", "FIXTURE_SIZE_INVALID"].includes(
              error.message,
            )
          ? error.message
          : "FIXTURES_FAILED",
    );
    process.exitCode = 1;
  });
