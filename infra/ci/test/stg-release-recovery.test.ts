import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { orchestrate } from "../../deploy/orchestrate.mjs";
import { makeTempDir, repoRoot } from "./helpers.js";

const OLD = "sha-111111111111",
  NEW = "sha-222222222222";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("初始化中断与保留新数据库的代码回滚", () => {
  it("真实启动者在 READY 前退出：探针自行退出并自然保存零轮最终 JSON", async () => {
    const dir = makeTempDir("lyx-probe-parent-exit-");
    cleanups.push(dir.cleanup);
    const config = join(dir.dir, "config.json"),
      output = join(dir.dir, "probe.json"),
      preload = join(dir.dir, "slow-init.mjs");
    writeFileSync(config, '[{"name":"api","url":"http://127.0.0.1:1/readyz"}]');
    // 只控制真实子进程的 Node 初始化时机；不 stub 生产代码、信号或报告字段。
    writeFileSync(preload, "await new Promise(done => setTimeout(done, 250));\n");
    const launcher = `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['--import',process.argv[1],process.argv[2],
        '--config',process.argv[3],'--output',process.argv[4],'--parent-pid',String(process.pid)],
        {stdio:['ignore','pipe','pipe']});
      child.stdout.resume(); child.stderr.resume();
      child.once('spawn',()=>{console.log(child.pid);process.exit(0)});
    `;
    const before = Date.now();
    const owner = spawn(process.execPath, [
      "-e",
      launcher,
      preload,
      join(repoRoot, "infra/ci/probe-during-deploy.mjs"),
      config,
      output,
    ]);
    let stdout = "";
    owner.stdout.on("data", (data: Buffer) => (stdout += data));
    const status = await new Promise<number | null>((done, reject) => {
      owner.once("close", done);
      owner.once("error", reject);
    });
    expect(status).toBe(0);
    const pid = Number(stdout.trim());
    expect(pid).toBeGreaterThan(1);
    cleanups.push(() => {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    const deadline = Date.now() + 4000;
    while ((!existsSync(output) || alive(pid)) && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 50));
    expect(alive(pid)).toBe(false);
    const report = JSON.parse(readFileSync(output, "utf8"));
    expect(report).toMatchObject({ rounds: 0, requests: 0, failures: 0 });
    expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(report.finishedAt)).toBeLessThanOrEqual(Date.now());
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });
});

function databaseFixture() {
  const dir = makeTempDir("lyx-rollback-db-source-");
  cleanups.push(dir.cleanup);
  const bin = join(dir.dir, "bin"),
    home = join(dir.dir, "home"),
    images = join(dir.dir, "images");
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(images);
  // 镜像与库替身使用真实严格结构比较器；旧 a 镜像没有 b1 新增的核对工具。
  const sections = (indexes: string[]) => ({
    tables: [],
    columns: [],
    constraints: [],
    indexes: indexes.map((key) => ({ key, def: { definition: `CREATE INDEX ${key}` } })),
    triggers: [],
    functions: [],
  });
  writeFileSync(
    join(images, `${OLD}.json`),
    JSON.stringify({ tools: false, sections: sections([]) }),
  );
  writeFileSync(
    join(images, `${NEW}.json`),
    JSON.stringify({ tools: true, sections: sections(["compatible_plain_index"]) }),
  );
  const database = join(dir.dir, "database.json"),
    calls = join(dir.dir, "calls.jsonl");
  writeFileSync(database, JSON.stringify(sections([])));
  writeFileSync(calls, "");
  const docker = `#!/usr/bin/env node
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2),tag=process.env.LYX_TAG??'';
appendFileSync(process.env.FAKE_CALLS,JSON.stringify({args,tag})+'\\n');
if(args[0]==='inspect') { console.log('running healthy'); process.exit(0); }
if(args[0]==='run') {
 const mode=args.at(-2); console.log(mode==='keep'?'${OLD}\\nsha-333333333333\\nsha-444444444444':'${OLD}\\n${NEW}');
}
if(args[0]==='image' && args[1]==='ls') {
 const repo=args.find(arg=>arg.startsWith('reference=')).slice('reference='.length).split(':')[0];
 console.log(repo+'|${NEW}|sha256:old');
}
if(args[0]==='compose' && args.includes('run')) {
 const image=JSON.parse(readFileSync(process.env.FAKE_IMAGES+'/'+tag+'.json','utf8'));
 if(args.at(-1)==='migrate') {
   const persisted=readFileSync(process.env.LYX_NODE_HOME+'/db-release.env','utf8');
   if(persisted!=='LYX_DB_TAG='+tag+'\\n') process.exit(23);
   writeFileSync(process.env.FAKE_DATABASE,JSON.stringify(image.sections));
   process.exit(process.env.FAKE_MIGRATE_FAIL==='true'?17:0);
 }
 if(args.at(-1)==='verify-db') {
   if(!image.tools) {console.error('旧镜像缺新增核库工具');process.exit(2)}
   const {diffStructure}=await import(process.env.FAKE_STRUCTURE_LIB);
   const actual=JSON.parse(readFileSync(process.env.FAKE_DATABASE,'utf8'));
   const differences=diffStructure(image.sections,actual,['快照','库里']);
   if(differences.length) {console.error(differences.join('\\n'));process.exit(1)}
   console.log('真实严格比较器：六节零差异');
 }
}
`;
  writeFileSync(join(bin, "docker"), docker);
  chmodSync(join(bin, "docker"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    LYX_NODE_HOME: home,
    LYX_NODE_SUPERVISOR: "compose",
    LYX_NODE_PREFIX: "lyx-rollback-db-fixture",
    LYX_NODE_PROJECT: "lyx-rollback-db-fixture",
    FAKE_CALLS: calls,
    FAKE_IMAGES: images,
    FAKE_DATABASE: database,
    FAKE_STRUCTURE_LIB: join(repoRoot, "infra/ci/db-structure-lib.mjs"),
  };
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync("bash", [join(repoRoot, "infra/deploy/node-step.sh"), ...args], {
      encoding: "utf8",
      env: { ...env, ...extra },
    });
  return { home, images, database, calls, run, sections };
}

describe("真实 bash 核库工具来源", () => {
  it("首次 b1 发布后回滚旧 a：旧镜像缺工具仍用持久化新版本严格核保留的新索引", () => {
    const f = databaseFixture();
    expect(f.run(["verify-db", OLD]).status).toBe(1); // 未修复路径确实会因旧镜像缺工具而失败。
    expect(f.run(["migrate", NEW]).status).toBe(0);
    writeFileSync(join(f.home, "release.env"), `LYX_TAG=${OLD}\n`); // 应用已回滚，数据库不动。
    const result = f.run(["verify-db", OLD]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`LYX_DB_VERIFY_APPLICATION=${OLD}`);
    expect(result.stdout).toContain(`LYX_DB_VERIFY_RUNNER=${NEW}`);
    expect(result.stdout).toContain("六节零差异");
    const calls = readFileSync(f.calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.filter((row) => row.args.at(-1) === "verify-db").map((row) => row.tag)).toEqual([
      OLD,
      NEW,
    ]);
    expect(JSON.parse(readFileSync(f.database, "utf8")).indexes).toHaveLength(1);
    // 即使旧镜像后来有工具，旧快照仍确实拒绝新增索引；不能靠放宽比较器实现绿色。
    writeFileSync(
      join(f.images, `${OLD}.json`),
      JSON.stringify({ tools: true, sections: f.sections([]) }),
    );
    writeFileSync(join(f.home, "db-release.env"), `LYX_DB_TAG=${OLD}\n`);
    const oldSnapshot = f.run(["verify-db", OLD]);
    expect(oldSnapshot.status).toBe(1);
    expect(oldSnapshot.stderr).toContain("compatible_plain_index");
  });
  it("迁移部分成功后失败也保留目标；缺索引仍红，非法来源记录在 Docker 前拒绝", () => {
    const f = databaseFixture();
    expect(f.run(["migrate", NEW], { FAKE_MIGRATE_FAIL: "true" }).status).toBe(1);
    expect(readFileSync(join(f.home, "db-release.env"), "utf8")).toBe(`LYX_DB_TAG=${NEW}\n`);
    expect(f.run(["verify-db", OLD]).status).toBe(0);
    writeFileSync(f.database, JSON.stringify(f.sections([])));
    const missing = f.run(["verify-db", OLD]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("compatible_plain_index");
    const before = readFileSync(f.calls, "utf8");
    for (const value of [
      "LYX_DB_TAG=invalid;id\n",
      `LYX_DB_TAG=${NEW}\nLYX_DB_TAG=${OLD}\n`,
      `LYX_DB_TAG=${"x".repeat(142)}\n`,
    ]) {
      writeFileSync(join(f.home, "db-release.env"), value);
      expect(f.run(["verify-db", OLD]).status).toBe(1);
      expect(readFileSync(f.calls, "utf8")).toBe(before);
    }
    rmSync(join(f.home, "db-release.env"));
    symlinkSync(join(f.home, "missing-record"), join(f.home, "db-release.env"));
    expect(f.run(["verify-db", OLD]).status).toBe(1);
    expect(readFileSync(f.calls, "utf8")).toBe(before);
    rmSync(join(f.home, "db-release.env"));
    mkdirSync(join(f.home, "db-release.env.tmp"));
    const persistFailure = f.run(["migrate", NEW]);
    expect(persistFailure.status).toBe(1);
    const calls = readFileSync(f.calls, "utf8").slice(before.length).trim().split("\n");
    expect(calls.every((line) => JSON.parse(line).args.at(-1) !== "migrate")).toBe(true);
  });
  it("编排摘要另记应用/核库 runner 来源，节点发布记录仍按应用版本严格保存", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const result = orchestrate({ rollback: true, tag: OLD }, (step, args = []) => {
      let stdout = "";
      if (step === "facts") stdout = `LYX_CURRENT=${NEW}\n`;
      if (step === "preflight") stdout = 'LYX_PREFLIGHT={"p1":"unavailable","ids":[]}\n';
      if (step === "image-facts")
        stdout = ["server", "gateway", "mediatool"]
          .map((name) => `LYX_IMAGE=${name}|${digest}\n`)
          .join("");
      if (step === "verify-db") {
        expect(args).toEqual([OLD]);
        stdout = `LYX_DB_VERIFY_APPLICATION=${OLD}\nLYX_DB_VERIFY_RUNNER=${NEW}\n`;
      }
      if (step === "record") {
        const record = JSON.parse(Buffer.from(args[1]!, "base64url").toString());
        expect(record.version).toBe(OLD);
        expect(record.dbVerification).toBeUndefined();
      }
      return { status: 0, stdout, stderr: "" };
    });
    expect(result.exitCode).toBe(0);
    expect(result.dbVerification).toEqual({ applicationVersion: OLD, runnerVersion: NEW });
  });
  it("三版清理之外保护实际保留数据库的 server 工具镜像，非法来源时不清任何镜像", () => {
    const f = databaseFixture();
    writeFileSync(join(f.home, "release.env"), `LYX_TAG=${OLD}\n`);
    writeFileSync(join(f.home, "db-release.env"), `LYX_DB_TAG=${NEW}\n`);
    writeFileSync(join(f.home, "releases.log"), "{}\n");
    const result = f.run(["prune"]);
    expect(result.status, result.stderr).toBe(0);
    const removed = readFileSync(f.calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.args[0] === "image" && row.args[1] === "rm");
    expect(removed.map((row) => row.args[2])).toEqual([
      `liyoxi/gateway:${NEW}`,
      `liyoxi/mediatool:${NEW}`,
    ]);
    const before = readFileSync(f.calls, "utf8");
    writeFileSync(join(f.home, "db-release.env"), "LYX_DB_TAG=bad;id\n");
    expect(f.run(["prune"]).status).toBe(1);
    expect(readFileSync(f.calls, "utf8")).toBe(before);
  });
});
