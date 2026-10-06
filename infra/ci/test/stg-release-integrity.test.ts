import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { capture, load, targets } from "../../deploy/asset-inventory.mjs";
import { checkTargets } from "../probe-during-deploy.mjs";
import { makeTempDir, repoRoot } from "./helpers.js";

const OLD = "sha-111111111111",
  NEW = "sha-222222222222";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture() {
  const dir = makeTempDir("lyx-release-integrity-");
  cleanups.push(dir.cleanup);
  const images = join(dir.dir, "images"),
    home = join(dir.dir, "home"),
    bin = join(dir.dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(home, "static", ".releases"), { recursive: true });
  for (const tag of [OLD, NEW])
    for (const app of ["admin", "portal"]) {
      const folder = join(images, tag, app);
      mkdirSync(join(folder, "assets"), { recursive: true });
      mkdirSync(join(home, "static", app, "assets"), { recursive: true });
      writeFileSync(
        join(folder, "index.html"),
        `<meta name="lyx-build" content="${tag}"><script src="/assets/entry-${tag}.js"></script>`,
      );
      writeFileSync(
        join(folder, "build.json"),
        JSON.stringify({ app, build: tag, mode: "production" }),
      );
      for (const name of ["entry", "lazy"]) {
        const file = `${name}-${tag}.js`;
        writeFileSync(join(folder, "assets", file), `${app}-${file}`);
        writeFileSync(join(home, "static", app, "assets", file), `${app}-${file}`);
      }
    }
  const calls = join(dir.dir, "calls.jsonl");
  const source = `#!/usr/bin/env node
import { appendFileSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const args=process.argv.slice(2); appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args)+'\\n');
if(args[0]===process.env.FAKE_FAIL) process.exit(17);
const state=process.env.FAKE_STATE;
if(args[0]==='create') writeFileSync(state,args.at(-1).split(':').at(-1));
else if(args[0]==='cp') {
 const tag=readFileSync(state,'utf8'), app=args[1].includes('/admin/')?'admin':'portal';
 cpSync(process.env.FAKE_IMAGES+'/'+tag+'/'+app+'/.',args[2],{recursive:true});
} else if(args[0]==='run') {
 const mount=(target)=>args.filter((a)=>a.startsWith('type=bind,')).find((a)=>a.includes('target='+target)).match(/source=([^,]+)/)[1];
 const marker=args.indexOf('/helper/deploy/asset-inventory.mjs');
 const helper=await import(process.env.FAKE_HELPER);
 try { await helper.main(args.slice(marker+1), {image:mount('/facts/image'),shared:mount('/facts/static'),records:mount('/facts/records'),base:process.env.FAKE_BASE}); }
 catch(e) { console.error(e.message); process.exit(1); }
} else if(args[0]==='rm') rmSync(state,{force:true});
`;
  writeFileSync(join(bin, "docker"), source);
  chmodSync(join(bin, "docker"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    LYX_NODE_HOME: home,
    LYX_NODE_PREFIX: "lyx-integrity",
    LYX_NODE_PROJECT: "lyx-integrity",
    LYX_NODE_SUPERVISOR: "compose",
    LYX_IMAGE_PREFIX: "",
    LYX_ADMIN_HOST: "admin.localhost",
    LYX_PORTAL_HOST: "portal.localhost",
    FAKE_CALLS: calls,
    FAKE_STATE: join(dir.dir, "container"),
    FAKE_IMAGES: images,
    FAKE_HELPER: join(repoRoot, "infra/deploy/asset-inventory.mjs"),
  };
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    const child = spawn("bash", [join(repoRoot, "infra/deploy/node-step.sh"), ...args], {
      env: { ...env, ...extra },
    });
    let stderr = "",
      stdout = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data;
    });
    child.stdout.on("data", (data: Buffer) => {
      stdout += data;
    });
    const status = await new Promise<number | null>((done, reject) => {
      child.once("exit", done);
      child.once("error", reject);
    });
    return {
      status,
      stderr,
      stdout,
      calls: readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line: string) => JSON.parse(line) as string[]),
    };
  };
  return { images, home, run, records: join(home, "static", ".releases") };
}

describe("完整版本资源与受限真实 bash", () => {
  it("清单包含没有被 index 引用的懒加载文件；重复执行不覆盖不同内容", () => {
    const f = fixture();
    const inventory = capture(NEW, join(f.images, NEW), join(f.home, "static"), f.records);
    expect(inventory.apps.admin.assets.map((row) => row.path)).toEqual([
      `entry-${NEW}.js`,
      `lazy-${NEW}.js`,
    ]);
    expect(load(NEW, f.records)).toEqual(inventory);
    expect(capture(NEW, join(f.images, NEW), join(f.home, "static"), f.records)).toEqual(inventory);
    writeFileSync(join(f.images, NEW, "admin", "assets", `lazy-${NEW}.js`), "changed");
    writeFileSync(join(f.home, "static", "admin", "assets", `lazy-${NEW}.js`), "changed");
    expect(() => capture(NEW, join(f.images, NEW), join(f.home, "static"), f.records)).toThrow(
      "拒绝覆盖",
    );
  });
  it("缺文件、错误构建号、符号链接和路径逃逸都拒绝", () => {
    const missing = fixture();
    rmSync(join(missing.home, "static", "portal", "assets", `lazy-${NEW}.js`));
    expect(() =>
      capture(NEW, join(missing.images, NEW), join(missing.home, "static"), missing.records),
    ).toThrow();
    const wrong = fixture();
    writeFileSync(
      join(wrong.images, NEW, "admin", "build.json"),
      '{"app":"admin","build":"wrong","mode":"production"}',
    );
    expect(() =>
      capture(NEW, join(wrong.images, NEW), join(wrong.home, "static"), wrong.records),
    ).toThrow("构建号");
    const link = fixture();
    symlinkSync("/etc/passwd", join(link.images, NEW, "admin", "assets", "escaped.js"));
    expect(() =>
      capture(NEW, join(link.images, NEW), join(link.home, "static"), link.records),
    ).toThrow("符号链接");
    const path = fixture();
    writeFileSync(
      join(path.images, NEW, "admin", "index.html"),
      `<meta name="lyx-build" content="${NEW}"><script src="/assets/../escaped.js"></script>`,
    );
    expect(() =>
      capture(NEW, join(path.images, NEW), join(path.home, "static"), path.records),
    ).toThrow("路径");
  });
  it("节点预核新旧版本；helper 不挂密钥且只可写清单目录，失败仍清自己的提取容器", async () => {
    const f = fixture();
    writeFileSync(join(f.home, "release.env"), `LYX_TAG=${OLD}\n`);
    const result = await f.run(["verify-assets", NEW]);
    expect(result.status, result.stderr).toBe(0);
    expect(load(OLD, f.records).version).toBe(OLD);
    expect(load(NEW, f.records).version).toBe(NEW);
    const helpers = result.calls.filter((args) => args[0] === "run");
    expect(helpers).toHaveLength(2);
    for (const args of helpers) {
      expect(args).toContain("none");
      expect(args).toContain("--read-only");
      expect(args).toContain("ALL");
      expect(args.join(" ")).not.toContain("secrets");
      expect(
        args.filter((arg) => arg.startsWith("type=bind,") && !arg.endsWith(",readonly")),
      ).toEqual([`type=bind,source=${f.records},target=/facts/records`]);
    }
    const failed = await f.run(["verify-assets", NEW], { FAKE_FAIL: "run" });
    expect(failed.status).toBe(1);
    expect(failed.calls.at(-1)?.[0]).toBe("rm");
  });
  it("实际网关逐个校验新旧全部资源：任一旧懒加载 404 使 live 步骤失败", async () => {
    const f = fixture();
    await f.run(["verify-assets", OLD]);
    await f.run(["verify-assets", NEW]);
    let missing = false;
    const server = http.createServer((req, res) => {
      const app = req.headers.host?.startsWith("admin") ? "admin" : "portal";
      const path = req.url === "/" ? "index.html" : (req.url?.slice(1) ?? "");
      if (missing && path === `assets/lazy-${OLD}.js`) {
        res.statusCode = 404;
        res.end();
        return;
      }
      try {
        const file = path.startsWith("assets/")
          ? join(f.home, "static", app, path)
          : join(f.images, NEW, app, path);
        res.end(readFileSync(file));
      } catch {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanups.push(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("没有端口");
    const base = `http://127.0.0.1:${address.port}`;
    const result = await f.run(["verify-assets-live", NEW, OLD], { FAKE_BASE: base });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("12 项");
    const helper = result.calls.filter((args) => args[0] === "run").at(-1)!;
    expect(helper).toContain("container:lyx-integrity-gateway");
    expect(
      helper
        .filter((arg) => arg.startsWith("type=bind,"))
        .every((arg) => arg.endsWith(",readonly")),
    ).toBe(true);
    missing = true;
    const failed = await f.run(["verify-assets-live", NEW, OLD], { FAKE_BASE: base });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(`lazy-${OLD}.js`);
    expect(
      await checkTargets(
        targets(
          load(OLD, f.records),
          { admin: "admin.localhost", portal: "portal.localhost" },
          base,
        ),
      ),
    ).toHaveLength(2);
  });
  it("新步骤的参数和 SSH 命令注入拒绝，未到 Docker", async () => {
    const f = fixture();
    writeFileSync(join(f.home, "dummy"), "");
    // 先形成调用日志；以下每次拒绝不能新增 Docker 调用。
    await f.run(["verify-assets", OLD]);
    for (const args of [
      ["verify-assets"],
      ["verify-assets", "x;id"],
      ["verify-assets-live"],
      ["verify-assets-live", NEW, OLD, "extra"],
    ]) {
      const result = await f.run(args);
      expect(result.status).toBe(2);
    }
    expect((await f.run([], { SSH_ORIGINAL_COMMAND: `verify-assets ${NEW}; id` })).status).toBe(2);
  });
});
