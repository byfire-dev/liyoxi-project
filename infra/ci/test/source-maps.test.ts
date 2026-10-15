import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  ftruncateSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { makeTempDir, repoRoot } from "./helpers.js";

const tool = join(repoRoot, "infra/deploy/source-maps.mjs");
const source = "a".repeat(40),
  tag = `sha-${source.slice(0, 12)}`;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
function temp() {
  const item = makeTempDir("lyx-private-map-test-");
  cleanups.push(item.cleanup);
  return realpathSync(item.dir);
}
function run(...args: string[]) {
  const result = spawnSync(process.execPath, [tool, ...args], { encoding: "utf8", timeout: 5000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const components = {
  api: ["apps/api/dist", "server.js", "server"],
  worker: ["apps/worker/dist", "index.js", "server"],
  admin: ["apps/admin/dist/app", "assets/main-12345678.js", "gateway"],
  portal: ["apps/portal/dist/app", "assets/main-12345678.js", "gateway"],
  weapp: ["apps/weapp/dist", "app.js", "weapp-build"],
} as const;
function fixture(repo: string, component: keyof typeof components) {
  const [directory, entry] = components[component],
    root = join(repo, directory),
    file = join(root, entry);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `const count = 1;\n//# sourceMappingURL=${entry.split("/").at(-1)}.map\n`);
  writeFileSync(
    `${file}.map`,
    JSON.stringify({
      version: 3,
      file: entry,
      sources: ["src/index.ts"],
      sourcesContent: ["const count: number = 1;"],
      names: [],
      mappings: "AAAA",
    }),
  );
  if (component === "admin" || component === "portal")
    writeFileSync(join(root, "index.html"), `<script src="/${entry}"></script>`);
  writeFileSync(join(root, "preserved.json"), '{"unchanged":true}\n');
  return { root, file, map: `${file}.map` };
}
function images(root: string) {
  const facts = ["server", "gateway"].map((name, index) => ({
    Id: `sha256:${String(index + 1).repeat(64)}`,
    RepoTags: [`liyoxi/${name}:${tag}`],
    Config: { Labels: { "org.opencontainers.image.revision": source } },
  }));
  writeFileSync(join(root, "images.json"), JSON.stringify(facts));
  return facts;
}

it("五组件真实v3配对从发布目录分离，同source/tag与镜像校验后私有清单可复核且只清本轮", () => {
  const repo = temp(),
    base = temp(),
    initialized = run("init", base);
  expect(initialized.status).toBe(0);
  const root = initialized.stdout.trim();
  expect(statSync(root).mode & 0o777).toBe(0o700);
  for (const component of Object.keys(components) as (keyof typeof components)[]) {
    const data = fixture(repo, component),
      output = join(root, components[component][2]);
    expect(run("split", component, repo, output, tag).status).toBe(0);
    expect(existsSync(data.map)).toBe(false);
    expect(readFileSync(data.file, "utf8")).not.toContain("sourceMappingURL");
    expect(readFileSync(join(data.root, "preserved.json"), "utf8")).toBe('{"unchanged":true}\n');
  }
  const facts = images(root);
  expect(run("finalize", root, source, tag)).toMatchObject({ status: 0, stderr: "" });
  expect(run("verify", root, source, tag)).toMatchObject({ status: 0, stderr: "" });
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  expect(manifest).toMatchObject({ source, tag, upload: "unimplemented" });
  expect(Object.keys(manifest.components).sort()).toEqual(Object.keys(components).sort());
  expect(statSync(join(root, "manifest.json")).mode & 0o777).toBe(0o600);
  const privateFile = join(root, "server/api/server.js"),
    bytes = readFileSync(privateFile);
  expect(manifest.components.api.files[0].sha256).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  writeFileSync(privateFile, "do-not-print-source-body");
  expect(run("verify", root, source, tag)).toMatchObject({
    status: 1,
    stdout: "",
    stderr: "source-maps: rejected\n",
  });
  writeFileSync(privateFile, bytes);
  facts[0]!.Config.Labels["org.opencontainers.image.revision"] = "b".repeat(40);
  writeFileSync(join(root, "images.json"), JSON.stringify(facts));
  expect(run("verify", root, source, tag).status).toBe(1);
  expect(run("verify", root, "b".repeat(40), tag).status).toBe(1);
  const foreign = join(base, "foreign");
  mkdirSync(foreign);
  expect(run("cleanup", foreign).status).toBe(1);
  expect(existsSync(foreign)).toBe(true);
  expect(run("cleanup", root)).toMatchObject({ status: 0, stderr: "" });
  expect(existsSync(root)).toBe(false);
  expect(existsSync(foreign)).toBe(true);
});

it("空组件/缺配对/非法map/内联引用/符号链接及超64MiB声明在公开目录变更前拒绝", () => {
  for (const kind of ["missing", "invalid", "inline", "symlink", "large", "output-symlink"]) {
    const repo = temp(),
      out = temp(),
      data = fixture(repo, "api");
    if (kind === "missing") unlinkSync(data.map);
    if (kind === "invalid")
      writeFileSync(data.map, '{"version":2,"raw":"do-not-print-source-body"}');
    if (kind === "inline")
      writeFileSync(
        data.file,
        "const count = 1;\n//# sourceMappingURL=data:application/json;base64,AAAA\n",
      );
    if (kind === "symlink") {
      unlinkSync(data.map);
      symlinkSync(data.file, data.map);
    }
    if (kind === "large") {
      const fd = openSync(data.map, "w");
      ftruncateSync(fd, 64 * 1024 * 1024 + 1);
      closeSync(fd);
    }
    let destination = join(out, "maps");
    if (kind === "output-symlink") {
      symlinkSync(repo, destination);
      destination = join(destination, "maps");
    }
    const before = readFileSync(data.file);
    expect(run("split", "api", repo, destination, tag)).toMatchObject({
      status: 1,
      stdout: "",
      stderr: "source-maps: rejected\n",
    });
    expect(readFileSync(data.file)).toEqual(before);
  }
  const repo = temp();
  mkdirSync(join(repo, "apps/api/dist"), { recursive: true });
  expect(run("split", "api", repo, temp(), tag).status).toBe(1);
  expect(run("split", "constructor", repo, temp(), tag).status).toBe(1);
});

it("固定bake双target同build输入，分离在finalCOPY/体积前且finally精确清理", () => {
  const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
  const bake = read("infra/docker/source-maps.hcl");
  for (const group of ["server", "gateway"]) {
    expect(bake).toContain(`group "${group}-bundle" { targets = ["${group}", "${group}-maps"] }`);
    const image = bake.split(`target "${group}" {`)[1]!.split("\n}")[0]!;
    const maps = bake.split(`target "${group}-maps" {`)[1]!.split("\n}")[0]!;
    expect(image).toContain(`inherits = ["${group}-build"]`);
    expect(maps).toContain(`inherits = ["${group}-build"]`);
    expect(image).toContain('output = ["type=docker"]');
    expect(maps).toContain(`output = ["type=local,dest=\${MAPS_DIR}/${group}"]`);
    expect(maps).not.toMatch(/tags\s*=|push/);
    const docker = read(`infra/docker/${group}/Dockerfile`);
    expect(docker.indexOf("source-maps.mjs split")).toBeLessThan(
      docker.indexOf("FROM scratch AS source-maps"),
    );
    const runtime = docker.slice(
      docker.indexOf(group === "server" ? "FROM sys AS server" : "FROM nginx:"),
    );
    expect(runtime).toContain("COPY --from=build");
    expect(runtime).not.toMatch(/private-source-maps|rm.*\.map/);
    expect(read(`infra/docker/${group}/Dockerfile.dockerignore`)).toContain(
      "!infra/deploy/source-maps.mjs",
    );
  }
  expect(bake).toContain("args = { LYX_BUILD = TAG }");
  expect(bake).toContain('"org.opencontainers.image.revision" = SOURCE');
  const weapp = read("apps/weapp/scripts/build.mjs");
  expect(weapp.indexOf("await split(")).toBeLessThan(
    weapp.search(/const result = spawnSync\(\s*process\.execPath/),
  );
  expect(weapp).toContain("finally {\n    if (owned) await cleanup(privateRoot);");
  expect(read("apps/api/scripts/build.mjs")).toContain('sourcemap: "external"');
  expect(read("apps/worker/scripts/build.mjs")).toContain('sourcemap: "external"');
  for (const app of ["admin", "portal"])
    expect(read(`apps/${app}/vite.config.ts`)).toContain(
      'mode === "production" ? "hidden" : false',
    );
});
