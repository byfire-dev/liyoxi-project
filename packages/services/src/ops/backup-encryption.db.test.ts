import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createTxRunner } from "../kernel/index.js";
import {
  assembleForTest,
  createClock,
  createFakeStorage,
  useTestDatabase,
} from "../testing/index.js";
import { createBackupAssembly } from "./backup-runtime.js";
import type { BackupProcessRunner } from "./backup.js";

const db = useTestDatabase("services", { label: "backupenc", max: 1, role: null });
// 常规单测不要求构建server镜像；ROOT显式指定已存在的本地镜像运行此真实协议组。
const image = process.env.LYX_TEST_BACKUP_IMAGE ?? "";
const encryptionTest = image ? it : it.skip;
const ownPrefix = `lyx-backup-test-${randomUUID().slice(0, 8)}`;
// 仅测试边界将固定生产命令映射到已有本地镜像；生产不接受可配置工具路径。
async function capture(entry: string, args: string[], input?: string) {
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--read-only",
      "--tmpfs=/tmp:rw,noexec,nosuid,size=1m",
      "--network=none",
      "--pull=never",
      "-i",
      "--entrypoint",
      entry,
      image,
      ...args,
    ],
    { stdio: "pipe" },
  );
  const chunks: Buffer[] = [];
  let total = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    total += chunk.length;
    if (total > 8 * 1024 ** 2) child.kill();
    else chunks.push(chunk);
  });
  child.stderr.resume();
  const timeout = setTimeout(() => child.kill("SIGTERM"), 10_000);
  const finished = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error("本地加密工具启动失败")));
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error("本地加密工具失败"))));
  });
  child.stdin.end(input);
  try {
    await finished;
  } finally {
    clearTimeout(timeout);
  }
  return Buffer.concat(chunks);
}

encryptionTest(
  "真实隔离库PG17只读导出经age加密流上传；测试私钥仅在内存管道中解密核验",
  { timeout: 30_000 },
  async () => {
    // 每轮现造虚构密钥，不读取、输出或写入真实/测试私钥文件。
    const keyText = (await capture("/usr/bin/age-keygen", [])).toString("utf8");
    const identity = keyText.split("\n").find((line) => line.startsWith("AGE-SECRET-KEY-"));
    const recipient = /public key: (age1[0-9a-z]+)/u.exec(keyText)?.[1];
    if (!identity || !recipient) throw new Error("测试age密钥输出无法解析");
    const clock = createClock(new Date("2026-10-14T00:00:00Z"));
    const target = { bucket: "test-backup-1250000000", prefix: "isolated/" };
    const storage = createFakeStorage({ clock, backup: target });
    const names: string[] = [];
    let count = 0,
      ended = 0;
    const runner: BackupProcessRunner = (command, args, options) => {
      const name = `${ownPrefix}-${++count}`;
      names.push(name);
      const commandArgs =
        command === "pg_dump"
          ? args.map((arg) => (arg.startsWith("--host=") ? "--host=host.docker.internal" : arg))
          : [...args];
      const environment = Object.keys(options.env).flatMap((key) => ["--env", key]);
      const child = spawn(
        "docker",
        [
          "run",
          "--rm",
          "--init",
          "--read-only",
          "--pull=never",
          "--name",
          name,
          "-i",
          `--network=${command === "pg_dump" ? "bridge" : "none"}`,
          ...environment,
          "--entrypoint",
          `/usr/bin/${command}`,
          image,
          ...commandArgs,
        ],
        { env: { ...process.env, ...options.env, PATH: process.env.PATH }, stdio: "pipe" },
      );
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("error", () => reject(new Error("测试备份工具启动失败")));
          child.once("close", (code, signal) => {
            ended++;
            resolve({ code, signal });
          });
        },
      );
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        exited,
        kill: (signal) => {
          child.kill(signal);
        },
      };
    };
    const url = new URL(await db.url());
    url.search = "";
    const scope = createBackupAssembly(assembleForTest({ entry: "worker" }), {
      tx: createTxRunner({ prisma: await db.prisma(), appEnv: "test" }),
      clock,
      config: { databaseUrl: url.toString(), recipient, maxBytes: 8 * 1024 ** 2, target },
      storage: () => storage,
      processRunner: runner,
    });
    try {
      const result = await scope.assembly
        .recurringJob("backup.pgdump")!
        .run({ scheduledFor: clock.now() });
      expect(result).toMatchObject({
        key: "daily/2026-10-14.dump.age",
        pgDumpVersion: expect.stringContaining("17."),
      });
      const stored = storage.backupObjects.get(
        `${target.bucket}/${target.prefix}daily/2026-10-14.dump.age`,
      );
      expect(stored).toBeDefined();
      if (!stored) throw new Error("实际加密备份未保存");
      expect(Buffer.from(stored.body).subarray(0, 22).toString()).toBe("age-encryption.org/v1\n");
      // Node的stdio pipe是socket，不能重新open /proc/fd；tmpfs FIFO仍只传内存字节。
      const program = `
        const fs=require('node:fs'),cp=require('node:child_process');
        const v=JSON.parse(fs.readFileSync(0,'utf8'));
        const path='/tmp/lyx-test-identity';
        if(cp.spawnSync('/usr/bin/mkfifo',[path]).status!==0)process.exit(1);
        const c=cp.spawn('/usr/bin/age',['-d','-i',path],{stdio:['pipe','pipe','ignore']});
        const identity=fs.createWriteStream(path);
        identity.on('error',()=>c.kill());
        identity.end(v.identity+String.fromCharCode(10));
        c.stdin.on('error',()=>{});
        c.stdin.end(Buffer.from(v.body,'base64'));
        c.stdout.pipe(process.stdout);
        c.on('exit',n=>{process.exitCode=n===0?0:1});
      `;
      const plain = await capture(
        "/usr/local/bin/node",
        ["-e", program],
        JSON.stringify({ identity, body: Buffer.from(stored.body).toString("base64") }),
      );
      expect(plain.subarray(0, 5).toString()).toBe("PGDMP");
      expect(stored.body.length).toBeGreaterThan(plain.length);
      expect(ended).toBe(count);
    } finally {
      await scope.close();
      for (const name of names) {
        await new Promise<void>((resolve) => {
          const clean = spawn("docker", ["rm", "-f", name], { stdio: "ignore" });
          clean.once("error", () => resolve());
          clean.once("close", () => resolve());
        });
      }
    }
  },
);
