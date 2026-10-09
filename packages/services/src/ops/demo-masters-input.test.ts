import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDemoMasterArgs, readDemoMasterInput } from "./demo-masters-input.js";
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lyx-w309-input-"));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true });
});
// Input codec only. These bytes are deliberately not a media file and never enter the pipeline.
const bytes = Buffer.from("explicit input codec bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
async function fixture(name: string, row: Record<string, unknown> = {}) {
  const video = join(dir, `${name}.mp4`),
    facts = join(dir, `${name}.json`);
  await writeFile(video, bytes);
  await writeFile(
    facts,
    JSON.stringify({
      results: [
        {
          name: `${name}.mp4`,
          size: bytes.length,
          sha256: digest,
          checks: {
            duration: true,
            video: true,
            audio: true,
            faststart: true,
            serviceDuration: true,
            size: true,
          },
          ...row,
        },
      ],
    }),
  );
  return { video, facts };
}
it("显式双参数严格配对、可换序，重复/额外/缺值拒绝；无参数只表示重复种子未提供新输入", () => {
  expect(parseDemoMasterArgs([])).toBeUndefined();
  expect(parseDemoMasterArgs(["--help"])).toBe("help");
  expect(parseDemoMasterArgs(["--probe-facts", "b", "--video", "a"])).toEqual({
    video: "a",
    facts: "b",
  });
  for (const args of [
    ["--video", "a"],
    ["--video"],
    ["--video", "a", "--video", "a"],
    ["--other", "a"],
    ["--video", "--probe-facts"],
  ])
    expect(() => parseDemoMasterArgs(args)).toThrow();
});
it("输入清单绑定真实大小/hash，返回只是字节身份而不是ready或probe事实", async () => {
  const input = await fixture("valid");
  expect(await readDemoMasterInput(input)).toEqual({
    path: input.video,
    size: bytes.length,
    sha256: digest,
  });
});
it("hash/大小/缺少合法性观测均拒绝，不从清单写入媒体事实", async () => {
  for (const [name, row] of [
    ["hash", { sha256: "0".repeat(64) }],
    ["size", { size: bytes.length + 1 }],
    ["checks", { checks: { video: true } }],
  ] as const)
    await expect(readDemoMasterInput(await fixture(name, row))).rejects.toThrow();
});
it("清单大小有界、匹配必须唯一，symlink不是批准的普通输入", async () => {
  const input = await fixture("bounded");
  await writeFile(input.facts, " ".repeat(65537));
  await expect(readDemoMasterInput(input)).rejects.toThrow();
  const duplicate = await fixture("duplicate");
  const row = {
    name: "duplicate.mp4",
    size: bytes.length,
    sha256: digest,
    checks: {
      duration: true,
      video: true,
      audio: true,
      faststart: true,
      serviceDuration: true,
      size: true,
    },
  };
  await writeFile(duplicate.facts, JSON.stringify({ results: [row, row] }));
  await expect(readDemoMasterInput(duplicate)).rejects.toThrow();
  const linked = join(dir, "linked.mp4");
  await symlink(duplicate.video, linked);
  await expect(readDemoMasterInput({ ...duplicate, video: linked })).rejects.toThrow();
});
it("文件系统/JSON诊断不回传显式路径或原文", async () => {
  const secretPath = join(dir, "should-never-appear.mp4");
  const error: unknown = await readDemoMasterInput({ video: secretPath, facts: secretPath }).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(secretPath);
});
it("CLI 表单边界恰为 20 MiB，超出时先于清单读取拒绝；不收窄其他清单条目", async () => {
  const input = await fixture("post-boundary");
  const limit = 20 * 1024 * 1024;
  await truncate(input.video, limit + 1);
  await expect(
    readDemoMasterInput({ video: input.video, facts: join(dir, "not-created.json") }),
  ).rejects.toThrow("20 MiB");
  await truncate(input.video, limit);
  const hash = createHash("sha256");
  hash.update(bytes);
  const zeroes = Buffer.alloc(64 * 1024);
  for (let remaining = limit - bytes.length; remaining > 0; remaining -= zeroes.length)
    hash.update(zeroes.subarray(0, Math.min(remaining, zeroes.length)));
  const sha256 = hash.digest("hex");
  const checks = {
    duration: true,
    video: true,
    audio: true,
    faststart: true,
    serviceDuration: true,
    size: true,
  };
  await writeFile(
    input.facts,
    JSON.stringify({
      results: [
        { name: "post-boundary.mp4", size: limit, sha256, checks },
        { name: "other-multipart.mp4", size: limit + 1, sha256, checks },
      ],
    }),
  );
  expect(await readDemoMasterInput(input)).toEqual({ path: input.video, size: limit, sha256 });
});
