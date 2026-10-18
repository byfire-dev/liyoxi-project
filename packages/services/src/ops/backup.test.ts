import { PassThrough, Readable, Transform } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClock, createFakeStorage } from "../testing/index.js";
import { failed } from "../providers/types.js";
import { createBackup } from "./backup.js";
import type { BackupChild, BackupConfig, BackupProcessRunner } from "./backup.js";

const password = "fictional-password-do-not-log";
const config: BackupConfig = {
  databaseUrl: `postgresql://backup_reader:${password}@db.example.invalid:5432/fictional?sslmode=require`,
  recipient: "age1ntnnfzy39drf2yscy0yr9e93frec8yzh8jelk5yrjmnra600adyse8ycjw",
  maxBytes: 1024,
  target: { bucket: "fictional-backups", prefix: "isolated/" },
};
const plaintext = Buffer.from("PGDMP fictional private database content");
const scheduledFor = new Date("2026-09-30T19:10:00.000Z");
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** 仅内存的进程协议替身；退出等源finally，kill才释放阻塞源。 */
function processes(mode: "success" | "age-failure" | "blocked" | "stubborn", bytes = 50) {
  let release!: () => void, entered!: () => void, drained!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const streamsEnded = new Promise<void>((resolve) => {
    drained = resolve;
  });
  const state = { sourceFinally: false, ageClosed: false };
  const children: Array<{ command: string; child: BackupChild; killed: BackupChild["kill"] }> = [];
  const runner = vi.fn<BackupProcessRunner>((command, args) => {
    const stdin = new PassThrough();
    if (command === "pg_dump" && args.includes("--version")) {
      return {
        stdin,
        stdout: Readable.from(["pg_dump (PostgreSQL) 17.6\n"]),
        stderr: Readable.from([]),
        exited: Promise.resolve({ code: 0, signal: null }),
        kill: vi.fn(),
      };
    }
    let finish!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
    let killed = false;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        finish = resolve;
      },
    );
    const output =
      command === "pg_dump"
        ? Readable.from(
            (async function* () {
              try {
                entered();
                yield plaintext;
                if (mode === "blocked" || mode === "age-failure") await gate;
              } finally {
                state.sourceFinally = true;
                if (mode !== "stubborn")
                  finish({ code: killed ? null : 0, signal: killed ? "SIGTERM" : null });
              }
            })(),
          )
        : new Transform({
            transform(_chunk, _encoding, done) {
              done();
            },
            flush(done) {
              this.push(Buffer.alloc(bytes, 0xa7));
              done();
            },
          });
    if (command === "age") {
      output.once("finish", () => {
        if (mode !== "stubborn") finish({ code: 0, signal: null });
      });
      output.once("end", drained);
      output.once("close", () => {
        state.ageClosed = true;
        if (mode !== "stubborn") finish({ code: null, signal: "SIGTERM" });
      });
      if (mode === "age-failure") void started.then(() => finish({ code: 1, signal: null }));
    }
    const kill = vi.fn<BackupChild["kill"]>((signal) => {
      killed = true;
      release();
      output.destroy();
      if (mode === "stubborn" && signal === "SIGKILL") finish({ code: null, signal });
    });
    const child: BackupChild = {
      stdin: command === "age" ? (output as Transform) : stdin,
      stdout: output,
      stderr: Readable.from([`${config.databaseUrl} ${password}`]),
      exited,
      kill,
    };
    children.push({ command, child, killed: kill });
    return child;
  });
  return { runner, children, started, streamsEnded, state, release };
}

describe("备份进程与已验证对象事实", () => {
  it("age失败与取消均kill活动管道并等待源finally；命令只读且错误/argv不泄凭证", async () => {
    for (const mode of ["age-failure", "blocked", "stubborn"] as const) {
      if (mode === "stubborn") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const clock = createClock(new Date("2026-11-12T04:00:00Z"));
      const storage = createFakeStorage({ clock, backup: config.target });
      let uploaded!: () => void;
      const uploadFinished = new Promise<void>((resolve) => {
        uploaded = resolve;
      });
      if (mode === "stubborn") {
        const put = storage.putBackupStream.bind(storage);
        vi.spyOn(storage, "putBackupStream").mockImplementation(async (input) => {
          const result = await put(input);
          uploaded();
          return result;
        });
      }
      const process = processes(mode),
        abort = new AbortController();
      const pending = createBackup({
        clock,
        config,
        storage: () => storage,
        processRunner: process.runner,
      }).run({ scheduledFor, signal: abort.signal });
      const outcome = pending.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await process.started;
        if (mode === "stubborn") {
          await process.streamsEnded;
          await uploadFinished;
          // 上传/管道已结束，主任务此刻在等待尚未退出的子进程。
          await Promise.resolve();
          await Promise.resolve();
        }
        if (mode !== "age-failure") abort.abort(new Error(`private ${config.databaseUrl}`));
        if (mode === "stubborn") await vi.advanceTimersByTimeAsync(1001);
        const error = await outcome;
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toBe("Error: 备份任务失败或已取消");
        expect(process.state.sourceFinally).toBe(true);
        expect(
          process.children.find((item) => item.command === "pg_dump")!.killed,
        ).toHaveBeenCalled();
        if (mode !== "age-failure") {
          expect(
            process.children.find((item) => item.command === "age")!.killed,
          ).toHaveBeenCalled();
          expect(process.state.ageClosed).toBe(true);
        }
        if (mode === "stubborn")
          for (const child of process.children)
            expect(child.killed).toHaveBeenCalledWith("SIGKILL");
        await Promise.all(process.children.map(({ child }) => child.exited));
        expect(storage.backupObjects.size).toBe(mode === "stubborn" ? 1 : 0);
        const dump = process.runner.mock.calls.find(
          ([command, args]) => command === "pg_dump" && !args.includes("--version"),
        )!;
        expect(dump[1]).toEqual(
          expect.arrayContaining(["-Fc", "--no-owner", "--role=lyx_readonly"]),
        );
        expect(dump[2].env.PGPASSWORD).toBe(password);
        expect(dump[2].env.PGOPTIONS).toContain("default_transaction_read_only=on");
        expect(dump[2].env).not.toHaveProperty("DATABASE_URL");
        expect(
          JSON.stringify(process.runner.mock.calls.map(([command, args]) => ({ command, args }))),
        ).not.toContain(password);
        expect(JSON.stringify(process.runner.mock.calls.map(([, args]) => args))).not.toContain(
          "postgresql://",
        );
      } finally {
        abort.abort();
        process.release();
        if (mode === "stubborn") await vi.advanceTimersByTimeAsync(2200);
        await outcome;
        if (mode === "stubborn") vi.useRealTimers();
      }
    }
  });

  it("北京时间计划日/月首COPY均用加密HEAD事实；50%边界可成功，缩水/错HEAD/COPY失败不产摘要", async () => {
    const clock = createClock(new Date("2026-11-12T04:00:00Z"));
    const storage = createFakeStorage({ clock, backup: config.target });
    const process = processes("success");
    const head = vi.spyOn(storage, "headBackup"),
      copy = vi.spyOn(storage, "copyBackup");
    const result = await createBackup({
      clock,
      config,
      storage: () => storage,
      processRunner: process.runner,
    }).run({ scheduledFor, signal: new AbortController().signal, previousBytes: 100 });
    expect(result).toEqual({
      key: "daily/2026-10-01.dump.age",
      bytes: 50,
      seconds: expect.any(Number),
      pgDumpVersion: "17.6",
    });
    expect(Number.isFinite(result.seconds) && result.seconds >= 0).toBe(true);
    expect(head).toHaveBeenCalledWith(expect.objectContaining({ key: result.key }));
    expect(copy).toHaveBeenCalledWith(
      expect.objectContaining({
        srcKey: result.key,
        dstKey: "monthly/2026-10-01.dump.age",
        ifMatchEtag: expect.any(String),
      }),
    );
    expect([...storage.backupObjects.keys()].sort()).toEqual([
      "fictional-backups/isolated/daily/2026-10-01.dump.age",
      "fictional-backups/isolated/monthly/2026-10-01.dump.age",
    ]);
    for (const object of storage.backupObjects.values()) {
      expect(object.body).toEqual(new Uint8Array(50).fill(0xa7));
      expect(Buffer.from(object.body).includes(plaintext)).toBe(false);
    }
    expect(storage.objects.size).toBe(0);
    for (const failure of ["shrink", "head", "copy"] as const) {
      const isolated = createFakeStorage({ clock, backup: config.target });
      const child = processes("success", failure === "shrink" ? 49 : 50);
      const monthly = vi.spyOn(isolated, "copyBackup");
      if (failure === "head")
        vi.spyOn(isolated, "headBackup").mockResolvedValueOnce({
          ok: true,
          value: { exists: true, size: 49, etag: "wrong" },
        });
      if (failure === "copy") monthly.mockResolvedValueOnce(failed("unavailable", password));
      await expect(
        createBackup({ clock, config, storage: () => isolated, processRunner: child.runner }).run({
          scheduledFor,
          signal: new AbortController().signal,
          previousBytes: 100,
        }),
      ).rejects.toThrow("备份任务失败或已取消");
      if (failure !== "copy") expect(monthly).not.toHaveBeenCalled();
      expect(child.state.sourceFinally).toBe(true);
    }
  });
});
