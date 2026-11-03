import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { makeTempDir, repoRoot } from "./helpers.js";

type RunOptions = { capture?: boolean; timeout?: number };
type Run = (args: string[], options?: RunOptions) => Promise<string>;
type BuildInput = {
  imageFile: string;
  cacheDirectory?: string;
  contextDigest?: string;
  run: Run;
};
const { buildLiveMediatool } = (await import(
  pathToFileURL(join(repoRoot, "apps/admin/scripts/live-mediatool-cache.mjs")).href
)) as { buildLiveMediatool(input: BuildInput): Promise<string> };
const image = `sha256:${"a".repeat(64)}`;
const rebuiltImage = `sha256:${"b".repeat(64)}`;
const contextDigest = "c".repeat(64);
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
function fixture() {
  const { dir, cleanup } = makeTempDir("lyx-live-mediatool-cache-");
  cleanups.push(cleanup);
  return { imageFile: join(dir, "current-iid"), cacheDirectory: join(dir, "cache"), contextDigest };
}
function cached(
  input: ReturnType<typeof fixture>,
  manifest: unknown = {
    version: 1,
    contextDigest,
    imageId: image,
  },
) {
  mkdirSync(input.cacheDirectory);
  writeFileSync(join(input.cacheDirectory, "image.tar"), "tool image archive");
  writeFileSync(join(input.cacheDirectory, "image.json"), JSON.stringify(manifest));
}

it("未启用缓存保持原当前Dockerfile构建和30分钟预算，返回本轮精确iid", async () => {
  const { imageFile } = fixture();
  const calls: { args: string[]; options: RunOptions | undefined }[] = [];
  const result = await buildLiveMediatool({
    imageFile,
    async run(args, options) {
      calls.push({ args, options });
      writeFileSync(imageFile, `${image}\n`);
      return "";
    },
  });
  expect(result).toBe(image);
  expect(calls).toEqual([
    {
      args: ["build", "--iidfile", imageFile, "infra/docker/mediatool"],
      options: { timeout: 30 * 60_000 },
    },
  ]);
});

it("冷缓存照常构建，只保存本轮工具镜像及上下文/iid元数据", async () => {
  const input = fixture();
  const calls: string[][] = [];
  const result = await buildLiveMediatool({
    ...input,
    async run(args) {
      calls.push(args);
      if (args[0] === "build") writeFileSync(input.imageFile, image);
      if (args[0] === "save") writeFileSync(args[2]!, "new tool image archive");
      return "";
    },
  });
  expect(result).toBe(image);
  expect(calls.map((args) => args[0])).toEqual(["build", "save"]);
  expect(calls[0]).toEqual(["build", "--iidfile", input.imageFile, "infra/docker/mediatool"]);
  expect(calls[1]?.at(-1)).toBe(image);
  expect(readdirSync(input.cacheDirectory).sort()).toEqual(["image.json", "image.tar"]);
  expect(JSON.parse(readFileSync(join(input.cacheDirectory, "image.json"), "utf8"))).toEqual({
    version: 1,
    contextDigest,
    imageId: image,
  });
});

it("热缓存核本轮完整上下文并load/inspect精确iid，不build、save或取registry缓存", async () => {
  const input = fixture();
  cached(input);
  const calls: string[][] = [];
  const result = await buildLiveMediatool({
    ...input,
    async run(args) {
      calls.push(args);
      if (args[0] === "image") return image;
      if (args[0] !== "load") throw new Error("热缓存只能load及inspect工具镜像");
      return "";
    },
  });
  expect(result).toBe(image);
  expect(calls).toEqual([
    ["load", "--input", join(input.cacheDirectory, "image.tar")],
    ["image", "inspect", "--format", "{{.Id}}", image],
  ]);
  expect(existsSync(input.imageFile)).toBe(false);
  expect(readFileSync(join(input.cacheDirectory, "image.tar"), "utf8")).toBe("tool image archive");
  expect(JSON.parse(readFileSync(join(input.cacheDirectory, "image.json"), "utf8")).imageId).toBe(
    image,
  );
});

it.each([
  { version: 1, contextDigest: "d".repeat(64), imageId: image },
  { version: 1, contextDigest, imageId: "liyoxi/mediatool:latest" },
  { version: 2, contextDigest, imageId: image },
  null,
])("上下文或元数据不一致时在Docker前拒绝：%j", async (manifest) => {
  const input = fixture();
  cached(input, manifest);
  await expect(
    buildLiveMediatool({
      ...input,
      run: async () => {
        throw new Error("不应调用Docker");
      },
    }),
  ).rejects.toThrow("缓存摘要或镜像 ID 不匹配");
  expect(existsSync(input.imageFile)).toBe(false);
});

it("残缺缓存与缺失本轮上下文拒绝，不把损坏当未命中", async () => {
  const input = fixture();
  mkdirSync(input.cacheDirectory);
  writeFileSync(join(input.cacheDirectory, "image.tar"), "partial");
  const run: Run = async () => {
    throw new Error("不应调用Docker");
  };
  await expect(buildLiveMediatool({ ...input, run })).rejects.toThrow("缓存不完整");
  await expect(buildLiveMediatool({ ...input, contextDigest: undefined, run })).rejects.toThrow(
    "绝对目录与本轮完整上下文摘要",
  );
  await expect(buildLiveMediatool({ ...input, cacheDirectory: undefined, run })).rejects.toThrow(
    "摘要缺少对应缓存目录",
  );
});

it.each(["load", "image"])("热缓存Docker %s 失败不回退旧成功，保留原缓存", async (phase) => {
  const input = fixture();
  cached(input);
  const calls: string[] = [];
  await expect(
    buildLiveMediatool({
      ...input,
      async run(args) {
        calls.push(args[0]!);
        if (args[0] === phase) throw new Error(`实际${phase}失败`);
        if (args[0] === "image") return image;
        return "";
      },
    }),
  ).rejects.toThrow(`实际${phase}失败`);
  expect(calls.at(-1)).toBe(phase);
  expect(readdirSync(input.cacheDirectory).sort()).toEqual(["image.json", "image.tar"]);
  expect(readFileSync(join(input.cacheDirectory, "image.tar"), "utf8")).toBe("tool image archive");
  expect(JSON.parse(readFileSync(join(input.cacheDirectory, "image.json"), "utf8")).imageId).toBe(
    image,
  );
});

it.each(["build", "save"])("冷缓存Docker %s 失败不发布缓存产物", async (phase) => {
  const input = fixture();
  const calls: string[] = [];
  await expect(
    buildLiveMediatool({
      ...input,
      async run(args) {
        calls.push(args[0]!);
        if (args[0] === phase) throw new Error(`实际${phase}失败`);
        if (args[0] === "build") writeFileSync(input.imageFile, image);
        return "";
      },
    }),
  ).rejects.toThrow(`实际${phase}失败`);
  expect(calls).toEqual(phase === "build" ? ["build"] : ["build", "save"]);
  expect(readdirSync(input.cacheDirectory)).toEqual([]);
});

it("热恢复镜像ID不符时失败，不以manifest声明代替真实镜像", async () => {
  const input = fixture();
  cached(input);
  const calls: string[] = [];
  await expect(
    buildLiveMediatool({
      ...input,
      async run(args) {
        calls.push(args[0]!);
        return rebuiltImage;
      },
    }),
  ).rejects.toThrow("恢复后 ID 不一致");
  expect(calls).toEqual(["load", "image"]);
});

it("冷缓存build无合法iid时失败，不保存工具产物", async () => {
  const input = fixture();
  const calls: string[] = [];
  await expect(
    buildLiveMediatool({
      ...input,
      async run(args) {
        calls.push(args[0]!);
        if (args[0] === "build") writeFileSync(input.imageFile, "liyoxi/mediatool:latest");
        return "";
      },
    }),
  ).rejects.toThrow("Docker 未返回精确镜像 ID");
  expect(calls).toEqual(["build"]);
  expect(readdirSync(input.cacheDirectory)).toEqual([]);
});

it("web-live只按原条件缓存工具镜像，键精确覆盖OS/架构/全部上下文，完整live入口保持", () => {
  const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const job = ci.split("\n  web-live:\n")[1]!.split(/\n {2}[a-z][\w-]*:\n/)[0]!;
  const step = (name: string) =>
    job.split(`      - name: ${name}\n`)[1]!.split("      - name: ")[0]!;
  const cache = step("后台真实接口验收的工具镜像缓存");
  expect(cache).toContain("if: steps.admin-e2e.outputs.run == 'true'");
  expect(cache).toContain("uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0");
  expect(cache).toContain("path: ${{ runner.temp }}/liyoxi-web-live-mediatool");
  expect(cache).toContain(
    "key: web-live-mediatool-v1-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('infra/docker/mediatool/**') }}",
  );
  expect(cache).not.toMatch(/restore-keys|continue-on-error|lookup-only/);
  const live = step("后台登录真实接口验收");
  expect(live).toContain("if: steps.admin-e2e.outputs.run == 'true'");
  expect(live).toContain(
    "LYX_ADMIN_MEDIATOOL_CACHE_DIR: ${{ runner.temp }}/liyoxi-web-live-mediatool",
  );
  expect(live).toContain(
    "LYX_ADMIN_MEDIATOOL_CONTEXT_HASH: ${{ hashFiles('infra/docker/mediatool/**') }}",
  );
  expect(live).toContain("run: pnpm admin:e2e:live\n");
  expect(live).not.toMatch(/--test-file|--video|--resume-video|--probe-facts|--mediatool-image/);
});
