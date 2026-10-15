import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { init, split, finalize, cleanup } from "../../deploy/source-maps.mjs";
import {
  downloadVerified,
  uploadArguments,
  uploadConfiguration,
  uploadMaps,
} from "../../deploy/source-map-upload.mjs";

const source = "b".repeat(40),
  tag = `sha-${source.slice(0, 12)}`;
const componentFiles = {
  api: ["apps/api/dist", "server.js", "server"],
  worker: ["apps/worker/dist", "index.js", "server"],
  admin: ["apps/admin/dist/app", "assets/app-12345678.js", "gateway"],
  portal: ["apps/portal/dist/app", "assets/app-12345678.js", "gateway"],
  weapp: ["apps/weapp/dist", "app.js", "weapp-build"],
} as const;
const config = {
  organization: "fixture-org",
  projects: { api: "server", worker: "server", admin: "web", portal: "web", weapp: "mini" },
};
const configuration = JSON.stringify(config);
const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const path of homes.splice(0)) await fs.rm(path, { recursive: true, force: true });
});
async function temp() {
  const path = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lyx-map-upload-test-")));
  homes.push(path);
  return path;
}
async function fixture() {
  const base = await temp(),
    root = await init(base),
    repo = join(base, "repo");
  for (const [component, [directory, entry, group]] of Object.entries(componentFiles)) {
    const output = join(repo, directory),
      file = join(output, entry);
    await fs.mkdir(join(file, ".."), { recursive: true });
    await fs.writeFile(
      file,
      `throw new Error("fixture");\n//# sourceMappingURL=${entry.split("/").at(-1)}.map\n`,
    );
    await fs.writeFile(
      `${file}.map`,
      JSON.stringify({
        version: 3,
        file: entry,
        sources: ["src/fixture.ts"],
        sourcesContent: ['throw new Error("fixture");'],
        names: [],
        mappings: "AAAA",
      }),
    );
    if (component === "admin" || component === "portal")
      await fs.writeFile(join(output, "index.html"), "<script></script>");
    await split(component, repo, join(root, group), tag);
  }
  await fs.writeFile(
    join(root, "images.json"),
    JSON.stringify(
      ["server", "gateway"].map((name, index) => ({
        Id: `sha256:${String(index + 1).repeat(64)}`,
        RepoTags: [`liyoxi/${name}:${tag}`],
        Config: { Labels: { "org.opencontainers.image.revision": source } },
      })),
    ),
  );
  await finalize(root, source, tag);
  return { root, source, tag, configuration, token: "fixture-upload-token" };
}

it("默认无令牌零文件/下载/命令；配置只认固定五组件，命令保持release/dist与完整路径", async () => {
  const install = vi.fn(),
    run = vi.fn();
  expect(await uploadMaps({ root: "/nonexistent", source, tag }, { install, run })).toEqual({
    status: "unconfigured",
    uploadedComponents: 0,
  });
  expect(install).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(uploadConfiguration(configuration)).toEqual(config);
  for (const bad of [
    "{",
    JSON.stringify({ ...config, url: "https://wrong.invalid" }),
    JSON.stringify({ ...config, organization: "../org" }),
    JSON.stringify({ ...config, projects: { api: "server" } }),
  ])
    expect(() => uploadConfiguration(bad)).toThrow();
  for (const component of Object.keys(componentFiles)) {
    const args = uploadArguments(component, tag);
    expect(args).toContain(`app:///${component}`);
    expect(args).toContain("--no-rewrite");
    expect(args).toContain("--strict");
    expect(args.at(-1)).toBe(component);
  }
  expect(() => uploadArguments("../api", tag)).toThrow();
});

it("下载先验hash与大小/状态，拒绝坏字节且绝不产生可执行文件", async () => {
  const root = await temp(),
    bytes = Buffer.from("fixed binary fixture");
  const lock = {
    url: "https://downloads.sentry-cdn.com/fixture",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes));
  const file = join(root, "cli");
  await downloadVerified(lock, file, fetcher);
  expect(await fs.readFile(file)).toEqual(bytes);
  expect((await fs.stat(file)).mode & 0o777).toBe(0o500);
  expect(fetcher.mock.calls[0]![1]?.redirect).toBe("error");
  for (const [name, response] of [
    ["wrong", new Response("changed")],
    ["redirect", new Response(null, { status: 302 })],
    ["large", new Response("x", { headers: { "content-length": String(64 * 1024 * 1024 + 1) } })],
  ] as const) {
    const path = join(root, name);
    await expect(downloadVerified(lock, path, async () => response)).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
  }
});

it("同源微型五组件按manifest顺序上传、隔离环境、不含额外文件，结束精确清私有副本", async () => {
  const input = await fixture();
  await fs.writeFile(join(input.root, "server", "api", "not-in-manifest.js"), "private extra");
  vi.stubEnv("SENTRY_ALLOW_FAILURE", "1");
  vi.stubEnv("HTTPS_PROXY", "https://untrusted.invalid");
  const seen: string[] = [],
    temporary: string[] = [];
  const result = await uploadMaps(input, {
    testPlatform: "linux-x64",
    install: async (_lock, file) => {
      await fs.writeFile(file, "owned");
    },
    run: async (_file, args, options) => {
      temporary.push(options.cwd);
      expect((await fs.stat(options.cwd)).mode & 0o777).toBe(0o700);
      expect(options.env.SENTRY_ALLOW_FAILURE).toBeUndefined();
      expect(options.env.HTTPS_PROXY).toBeUndefined();
      expect(options.env.SENTRY_HTTP_MAX_RETRIES).toBe("0");
      expect(options.env.SENTRY_LOAD_DOTENV).toBe("0");
      expect(args.join(" ")).not.toContain(input.token);
      if (args[0] === "--version") {
        expect(options.env.SENTRY_AUTH_TOKEN).toBeUndefined();
        return "sentry-cli 3.8.0\n";
      }
      const component = args.at(-1)!;
      seen.push(component);
      expect(options.env.SENTRY_AUTH_TOKEN).toBe(input.token);
      expect(options.env.SENTRY_PROJECT).toBe(
        config.projects[component as keyof typeof config.projects],
      );
      expect(existsSync(join(options.cwd, "api", "not-in-manifest.js"))).toBe(false);
      const entry = componentFiles[component as keyof typeof componentFiles][1];
      expect((await fs.stat(join(options.cwd, component, entry))).mode & 0o777).toBe(0o600);
      expect(args).toEqual(uploadArguments(component, input.tag));
      return "";
    },
  });
  expect(result).toMatchObject({
    status: "uploaded",
    uploadedComponents: 5,
    pairs: 5,
    source,
    tag,
    cli: "3.8.0",
  });
  expect(seen).toEqual(Object.keys(componentFiles));
  expect(temporary.every((path) => !existsSync(path))).toBe(true);
  expect(existsSync(input.root)).toBe(true);
  await cleanup(input.root);
});

it("坏原产物不下载；命令失败/版本不符/CLI修改字节均中断后续且回收本轮目录", async () => {
  const input = await fixture(),
    install = vi.fn(async (_lock: unknown, file: string) => {
      await fs.writeFile(file, "owned");
    });
  const original = await fs.readFile(join(input.root, "server", "api", "server.js"));
  await fs.writeFile(join(input.root, "server", "api", "server.js"), "bad");
  await expect(uploadMaps(input, { testPlatform: "linux-x64", install })).rejects.toThrow();
  expect(install).not.toHaveBeenCalled();
  await fs.writeFile(join(input.root, "server", "api", "server.js"), original);
  for (const failure of ["version", "command", "changed"] as const) {
    const paths: string[] = [],
      sent: string[] = [];
    await expect(
      uploadMaps(input, {
        testPlatform: "linux-x64",
        install,
        run: async (_file, args, options) => {
          paths.push(options.cwd);
          if (args[0] === "--version")
            return failure === "version" ? "sentry-cli 0.0.0" : "sentry-cli 3.8.0";
          sent.push(args.at(-1)!);
          if (failure === "command") throw new Error("simulated command failure");
          await fs.writeFile(join(options.cwd, "api", "server.js"), "modified");
          return "";
        },
      }),
    ).rejects.toThrow();
    expect(sent).toHaveLength(failure === "version" ? 0 : 1);
    expect(paths.every((path) => !existsSync(path))).toBe(true);
  }
  await cleanup(input.root);
});
