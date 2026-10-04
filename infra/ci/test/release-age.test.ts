import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { git, makeTempRepo, repoRoot, runAsync, writeFiles } from "./helpers.js";

const script = join(repoRoot, "infra/ci/check-release-age.mjs");
const DAY_MS = 86_400_000;
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

// 假 registry：包名 → { 版本: 发布时间 }。只在本机回环地址上听，不出网
const published = new Map<string, Record<string, string>>();
let server: Server;
let registry = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? "/").slice(1));
    const time = published.get(name);
    if (!time) {
      response.writeHead(404, { "content-type": "application/json" }).end("{}");
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ name, time }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  published.clear();
  while (cleanups.length > 0) cleanups.pop()?.();
});

const WORKSPACE = 'packages:\n  - "packages/*"\n\nminimumReleaseAge: 10080\n';
const MANIFEST = '{\n  "name": "fixture",\n  "packageManager": "pnpm@10.0.1"\n}\n';

/** 照 pnpm 锁文件 9.0 版的样子拼一份，keys 是 “包名@版本” */
function lockfile(keys: readonly string[]): string {
  const quote = (key: string): string => (/^[@'"]|:/.test(key) ? `'${key}'` : key);
  return [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .: {}",
    "",
    "packages:",
    "",
    ...keys.flatMap((key) => [`  ${quote(key)}:`, "    resolution: {integrity: sha512-AAAA}", ""]),
    "snapshots:",
    "",
    ...keys.flatMap((key) => [`  ${quote(key)}: {}`, ""]),
  ].join("\n");
}

interface Fixture {
  keys: readonly string[];
  workspace?: string;
  manifest?: string;
}

function project({ keys, workspace = WORKSPACE, manifest = MANIFEST }: Fixture): string {
  const temp = makeTempRepo("lyx-release-age-", {
    "pnpm-workspace.yaml": workspace,
    "package.json": manifest,
    "pnpm-lock.yaml": lockfile(keys),
  });
  cleanups.push(temp.cleanup);
  return temp.dir;
}

function check(dir: string, ...args: string[]) {
  return runAsync("node", [script, "--registry", registry, ...args], dir);
}

describe("锁文件里每个版本都须发布满 7 天", () => {
  it("全部满 7 天：通过", async () => {
    published.set("pnpm", { "10.0.1": daysAgo(30) });
    published.set("left", { "1.0.0": daysAgo(8), "1.0.1": daysAgo(1) });
    published.set("@scope/right", { "2.3.4": daysAgo(400) });
    const result = await check(project({ keys: ["left@1.0.0", "@scope/right@2.3.4"] }));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("3 个版本都已发布满 7 天");
  });

  it("有一个版本只发布了 6 天：失败，并指出是哪个", async () => {
    published.set("pnpm", { "10.0.1": daysAgo(30) });
    published.set("left", { "1.0.0": daysAgo(8) });
    published.set("@scope/right", { "2.3.4": daysAgo(6) });
    const result = await check(project({ keys: ["left@1.0.0", "@scope/right@2.3.4"] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@scope/right@2.3.4");
    expect(result.stderr).toContain("未满 7 天");
    expect(result.stderr).not.toContain("left@1.0.0");
  });

  it("packageManager 写的 pnpm 版本未满 7 天：失败", async () => {
    published.set("pnpm", { "10.0.1": daysAgo(2) });
    published.set("left", { "1.0.0": daysAgo(8) });
    const result = await check(project({ keys: ["left@1.0.0"] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pnpm@10.0.1");
  });

  it("registry 上查不到这个版本：失败", async () => {
    published.set("pnpm", { "10.0.1": daysAgo(30) });
    published.set("left", { "0.9.0": daysAgo(90) });
    const result = await check(project({ keys: ["left@1.0.0"] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("left@1.0.0：registry 上查不到这个版本的发布时间");
  });

  it("不是 registry 上的版本（压缩包地址）：失败", async () => {
    published.set("pnpm", { "10.0.1": daysAgo(30) });
    const result = await check(project({ keys: ["left@https://example.invalid/left-1.0.0.tgz"] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("核对不了发布时间");
  });
});

describe("pnpm-workspace.yaml 的设置", () => {
  const cases: Array<[string, string, string]> = [
    ["没有 minimumReleaseAge", 'packages:\n  - "packages/*"\n', "没有 minimumReleaseAge: 10080"],
    ["minimumReleaseAge 被调小", "minimumReleaseAge: 1440\n", "没有 minimumReleaseAge: 10080"],
    [
      "有 minimumReleaseAgeExclude",
      "minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  - left\n",
      "有 minimumReleaseAgeExclude",
    ],
  ];

  it.each(cases)("%s：失败", async (_label, workspace, message) => {
    published.set("pnpm", { "10.0.1": daysAgo(30) });
    published.set("left", { "1.0.0": daysAgo(8) });
    const result = await check(project({ keys: ["left@1.0.0"], workspace }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("本仓库：有 minimumReleaseAge: 10080，没有 minimumReleaseAgeExclude", () => {
    const workspace = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).toMatch(/^minimumReleaseAge: 10080$/m);
    expect(workspace).not.toMatch(/^minimumReleaseAgeExclude\s*:/m);
  });
});

describe("--since 只查新增的版本", () => {
  it("引用上已有的版本不查，新增的才查", async () => {
    published.set("pnpm", { "10.0.1": daysAgo(30) });
    // old 在假 registry 里只发布了 1 天：全查会失败，但它在引用上已经有了
    published.set("old", { "1.0.0": daysAgo(1) });
    published.set("fresh", { "1.0.0": daysAgo(3) });
    published.set("aged", { "1.0.0": daysAgo(9) });

    const dir = project({ keys: ["old@1.0.0"] });
    git(dir, "commit", "-q", "-m", "base");

    writeFiles(dir, { "pnpm-lock.yaml": lockfile(["old@1.0.0", "aged@1.0.0"]) });
    const added = await check(dir, "--since", "HEAD");
    expect(added.status).toBe(0);
    expect(added.stdout).toContain("相对 HEAD 新增的 1 个版本");

    const all = await check(dir);
    expect(all.status).toBe(1);
    expect(all.stderr).toContain("old@1.0.0");

    writeFiles(dir, { "pnpm-lock.yaml": lockfile(["old@1.0.0", "aged@1.0.0", "fresh@1.0.0"]) });
    const withFresh = await check(dir, "--since", "HEAD");
    expect(withFresh.status).toBe(1);
    expect(withFresh.stderr).toContain("fresh@1.0.0");
    expect(withFresh.stderr).not.toContain("old@1.0.0");
  });

  it("引用上没有锁文件：等于全查", async () => {
    published.set("pnpm", { "10.0.1": daysAgo(30) });
    published.set("left", { "1.0.0": daysAgo(2) });
    const dir = project({ keys: ["left@1.0.0"] });
    git(dir, "rm", "-q", "--cached", "pnpm-lock.yaml", "package.json");
    git(dir, "commit", "-q", "-m", "base");
    const result = await check(dir, "--since", "HEAD");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("left@1.0.0");
  });
});

describe("用法错误", () => {
  it("不认识的参数：退出码 2", async () => {
    const result = await check(project({ keys: [] }), "--days", "1");
    expect(result.status).toBe(2);
  });

  it("不认识的锁文件版本：退出码 2", async () => {
    const dir = project({ keys: [] });
    writeFiles(dir, { "pnpm-lock.yaml": "lockfileVersion: '6.0'\n" });
    const result = await check(dir);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("lockfileVersion 不是 9.0");
  });
});
