// Only process/storage IO is doubled; createBackup and the real timer own all state/results.
import { PassThrough, Readable, Transform } from "node:stream";
import { assertNotInTransaction } from "../kernel/index.js";
import type { Clock } from "../kernel/index.js";
import type { BackupChild, BackupProcessRunner, WorkerServicesOptions } from "../ops/index.js";
import type { StorageProvider } from "../providers/index.js";
import { createFakeStorage } from "./providers/index.js";

export function createM1BackupIo(runId: string, clock: Clock) {
  if (!/^[a-z0-9]{1,12}$/.test(runId)) throw new TypeError("M1备份IO需要本轮合法标识");
  const config: NonNullable<NonNullable<WorkerServicesOptions["keys"]>["BACKUP"]> = {
    databaseUrl: `postgresql://backup_reader:lyx-local-dev@backup.invalid:5432/owned_${runId}`,
    recipient: "age1ntnnfzy39drf2yscy0yr9e93frec8yzh8jelk5yrjmnra600adyse8ycjw",
    maxBytes: 1024,
    target: { bucket: `m1-backup-${runId}`, prefix: "worker/" },
  };
  const fake = createFakeStorage({ clock, backup: config.target });
  const lifetime = new AbortController();
  const children = new Map<BackupChild, Promise<void>>();
  const processes = { version: 0, dump: 0, age: 0 };
  const cleanEnv = {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    PGPASSFILE: "/dev/null",
    PGSERVICEFILE: "/dev/null",
  };
  const processRunner: BackupProcessRunner = (command, args, input) => {
    assertNotInTransaction("m1.backup.process");
    input.signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    if (command !== "pg_dump" && command !== "age") throw new TypeError("M1备份命令不合法");
    const version = command === "pg_dump" && args.length === 1 && args[0] === "--version";
    const expected =
      command === "age"
        ? ["-r", config.recipient]
        : version
          ? ["--version"]
          : [
              "-Fc",
              "--no-owner",
              "--no-password",
              "--role=lyx_readonly",
              "--host=backup.invalid",
              "--port=5432",
              "--username=backup_reader",
              `--dbname=owned_${runId}`,
            ];
    const expectedEnv =
      command === "pg_dump" && !version
        ? {
            ...cleanEnv,
            PGPASSWORD: "lyx-local-dev",
            PGOPTIONS: "-c default_transaction_read_only=on",
            PGCONNECT_TIMEOUT: "30",
          }
        : cleanEnv;
    if (
      JSON.stringify(args) !== JSON.stringify(expected) ||
      Object.keys(input.env).sort().join() !== Object.keys(expectedEnv).sort().join() ||
      Object.entries(expectedEnv).some(([key, value]) => input.env[key] !== value)
    )
      throw new TypeError("M1备份IO只接受固定只读命令与环境");
    processes[command === "age" ? "age" : version ? "version" : "dump"]++;
    const cipher =
      command === "age"
        ? new Transform({
            transform(_chunk, _encoding, done) {
              done();
            },
            flush(done) {
              this.push(Buffer.alloc(64, 0xa7));
              done();
            },
          })
        : undefined;
    const stdout =
      cipher ??
      Readable.from([version ? "pg_dump (PostgreSQL) 17.6\n" : "PGDMP typed worker backup IO"]);
    const stdin = cipher ?? new PassThrough(),
      stderr = Readable.from([]);
    let finish!: (result: Awaited<BackupChild["exited"]>) => void;
    const exited: BackupChild["exited"] = new Promise((resolve) => {
      finish = resolve;
    });
    const streams = [...new Set([stdin, stdout, stderr])];
    const closed = Promise.all(
      streams.map(
        (stream) =>
          new Promise<void>((resolve) => {
            stream.on("error", () => undefined);
            stream.once("close", resolve);
          }),
      ),
    ).then(() => undefined);
    const child: BackupChild = {
      stdin,
      stdout,
      stderr,
      exited,
      kill(signal) {
        for (const stream of streams) stream.destroy();
        void closed.then(() => finish({ code: null, signal }));
      },
    };
    const abort = () => child.kill("SIGTERM");
    input.signal.addEventListener("abort", abort, { once: true });
    lifetime.signal.addEventListener("abort", abort, { once: true });
    stdout.once("end", () => finish({ code: 0, signal: null }));
    children.set(child, closed);
    void closed.then(() => {
      input.signal.removeEventListener("abort", abort);
      lifetime.signal.removeEventListener("abort", abort);
      children.delete(child);
    });
    return child;
  };
  const storageSignal = (signal: AbortSignal) => {
    assertNotInTransaction("m1.backup.storage");
    return AbortSignal.any([signal, lifetime.signal]);
  };
  const storage: Pick<StorageProvider, "putBackupStream" | "headBackup" | "copyBackup"> = {
    putBackupStream: (input) =>
      fake.putBackupStream({ ...input, signal: storageSignal(input.signal) }),
    headBackup: (input) => fake.headBackup({ ...input, signal: storageSignal(input.signal) }),
    copyBackup: (input) => fake.copyBackup({ ...input, signal: storageSignal(input.signal) }),
  };
  return {
    config,
    processRunner,
    storage,
    snapshot: () => ({
      processes: { ...processes },
      activeChildren: children.size,
      put: fake.callsOf("putBackupStream").length,
      head: fake.callsOf("headBackup").length,
      copy: fake.callsOf("copyBackup").length,
      objects: fake.backupObjects.size,
      bytes: [...fake.backupObjects.values()].map((object) => object.body.length),
    }),
    async close() {
      lifetime.abort();
      await Promise.all(children.values());
      fake.backupObjects.clear();
    },
  };
}
