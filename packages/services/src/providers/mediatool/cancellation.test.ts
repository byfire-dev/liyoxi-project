import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeStorage } from "../../testing/providers/storage.js";
import { createMediaToolClient } from "./client.js";
import { createProductionMediaTools } from "./production.js";
import type { ProductionMediaTools, ProbeReport } from "../types.js";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(disposers.splice(0).map((close) => close()));
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const report: ProbeReport = {
  demuxer: "mov",
  format: {
    formatName: "mov",
    majorBrand: "isom",
    durationMs: 1000,
    sizeBytes: 100,
    bitRate: null,
    tags: {},
  },
  streams: [],
  boxes: ["ftyp", "moov", "mdat"],
  moovBeforeMdat: true,
  aigc: null,
};
type Call = {
  id: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  register(): void;
  finish(): void;
};
async function fixture() {
  const workDir = await realpath(await mkdtemp("/tmp/lyx-w304-cancel-"));
  const instance = randomUUID(),
    socketPath = join(workDir, "tool.sock");
  const entered = deferred(),
    cancelEntered = deferred();
  const calls: Call[] = [],
    tools: ProductionMediaTools[] = [];
  let registered = true,
    cancelCount = 0;
  let onCancel = (call: Call | undefined, res: http.ServerResponse) => {
    call?.finish();
    res.end(JSON.stringify({ ok: true, requestId: call?.id, instanceId: instance, done: true }));
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url === "/cancel") {
        cancelCount += 1;
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          requestId: string;
          instanceId: string;
        };
        expect(body.instanceId).toBe(instance);
        cancelEntered.resolve();
        onCancel(
          calls.find((call) => call.id === body.requestId),
          res,
        );
        return;
      }
      const id = String(req.headers["x-lyx-call-id"]);
      const call: Call = {
        id,
        req,
        res,
        register() {
          res.writeInformation(102, { "x-lyx-call-id": id, "x-lyx-instance": instance });
        },
        finish() {
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, {
            "content-type": "application/json",
            "x-lyx-call-id": id,
            "x-lyx-instance": instance,
            "x-lyx-complete": "1",
          });
          res.end(JSON.stringify({ ok: true, report }));
        },
      };
      calls.push(call);
      if (registered) call.register();
      entered.resolve();
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const owned = () => {
    const one = createProductionMediaTools({
      workDir,
      socketPath,
      storage: createFakeStorage(),
      beforeCall: () => undefined,
    });
    tools.push(one);
    return one;
  };
  const probe = (one: ProductionMediaTools, controller: AbortController, suffix = "1") => {
    const result = one.workspace.run(
      { id: `01900000-0000-7000-8000-00000000000${suffix}`, attemptNo: 1 },
      controller.signal,
      (work) =>
        one.client.probe({
          path: work.path("source.mp4"),
          demuxers: ["mov"],
          signal: controller.signal,
        }),
    );
    // Observe setup failures immediately without changing the returned rejection.
    void result.catch(() => undefined);
    return result;
  };
  disposers.push(async () => {
    for (const call of calls) call.finish();
    await Promise.allSettled(tools.map((one) => one.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workDir, { recursive: true, force: true });
  });
  return {
    workDir,
    socketPath,
    instance,
    entered,
    cancelEntered,
    calls,
    owned,
    probe,
    cancelCount: () => cancelCount,
    registerLater() {
      registered = false;
    },
    cancel(handler: typeof onCancel) {
      onCancel = handler;
    },
  };
}

describe("私有UNIX取消确认与工作区屏障", () => {
  it("cancel ACK与原response均held时不提前完成或删除目录", async () => {
    const f = await fixture(),
      one = f.owned(),
      controller = new AbortController(),
      release = deferred();
    f.cancel((call, res) => {
      void release.promise.then(() => {
        call?.finish();
        res.end(
          JSON.stringify({ ok: true, requestId: call?.id, instanceId: f.instance, done: true }),
        );
      });
    });
    let settled = false;
    const run = f.probe(one, controller).finally(() => {
      settled = true;
    });
    await f.entered.promise;
    controller.abort();
    await f.cancelEntered.promise;
    expect(settled).toBe(false);
    expect((await readdir(f.workDir)).filter((p) => p !== "tool.sock")).toHaveLength(1);
    release.resolve();
    expect(await run).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await readdir(f.workDir)).toEqual(["tool.sock"]);
  });
  it("102注册之前取消不发未知cancel；注册后仅一次且原预算不重置", async () => {
    const f = await fixture();
    f.registerLater();
    const controller = new AbortController(),
      one = f.owned();
    const run = f.probe(one, controller);
    await f.entered.promise;
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.calls).toHaveLength(1);
    expect(f.cancelCount()).toBe(0);
    f.calls[0]!.register();
    await f.cancelEntered.promise;
    expect(f.cancelCount()).toBe(1);
    expect(await run).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await readdir(f.workDir)).toEqual(["tool.sock"]);
  });
  it("cancel连接失败仍可由原response完成确认，不假失败清理", async () => {
    const f = await fixture(),
      controller = new AbortController(),
      one = f.owned();
    f.cancel((call, res) => {
      res.destroy();
      call?.finish();
    });
    const run = f.probe(one, controller);
    await f.entered.promise;
    controller.abort();
    expect(await run).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await readdir(f.workDir)).toEqual(["tool.sock"]);
  });
  it("两通道未知耗尽原绝对预算时保留owned目录并拒绝清理成功", async () => {
    const f = await fixture(),
      controller = new AbortController(),
      one = f.owned();
    f.cancel((call, res) => {
      call?.res.destroy();
      res.destroy();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = f.probe(one, controller).then(
      () => null,
      (error: unknown) => error,
    );
    await f.entered.promise;
    controller.abort();
    await f.cancelEntered.promise;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await run).toBeInstanceOf(Error);
    expect((await readdir(f.workDir)).filter((p) => p !== "tool.sock")).toHaveLength(1);
    await expect(one.close()).rejects.toThrow("清理未确认");
    vi.useRealTimers();
  });
  it("A关闭只取消A；同socket兄弟scope B继续完成且不被等待", async () => {
    const f = await fixture(),
      a = f.owned(),
      b = f.owned(),
      ca = new AbortController(),
      cb = new AbortController();
    const ra = f.probe(a, ca),
      rb = f.probe(b, cb, "2");
    while (f.calls.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    await a.close();
    expect(await ra).toMatchObject({ ok: false, reason: "unavailable" });
    expect(f.calls.filter((call) => !call.res.writableEnded)).toHaveLength(1);
    f.calls.find((call) => !call.res.writableEnded)!.finish();
    expect(await rb).toMatchObject({ ok: true });
    expect(await readdir(f.workDir)).toEqual(["tool.sock"]);
  });
  it("错误instance/requestId的cancel ACK不被采纳，仅真实原response才能确认", async () => {
    const f = await fixture(),
      controller = new AbortController(),
      receipt: boolean[] = [];
    f.cancel((_call, res) => {
      res.end(JSON.stringify({ done: true, requestId: randomUUID(), instanceId: randomUUID() }));
    });
    const client = createMediaToolClient({
      socketPath: f.socketPath,
      responseTimeoutMs: 1000,
      observeCleanup(_directory, completion) {
        void completion.then((ok) => receipt.push(ok));
      },
    });
    const run = client.probe({
      path: "job/source.mp4",
      demuxers: ["mov"],
      signal: controller.signal,
    });
    await f.entered.promise;
    controller.abort();
    await f.cancelEntered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(receipt).toEqual([]);
    f.calls[0]!.finish();
    expect(await run).toMatchObject({ ok: false, reason: "unavailable" });
    expect(receipt).toEqual([true]);
  });
  it("preabort仍经factory最外guard，零socket与零目录", async () => {
    const f = await fixture(),
      controller = new AbortController();
    controller.abort();
    const guard = vi.fn(() => {
      throw new Error("TX外呼禁止");
    });
    const one = createProductionMediaTools({
      workDir: f.workDir,
      socketPath: f.socketPath,
      storage: createFakeStorage(),
      beforeCall: guard,
    });
    expect(() =>
      one.client.probe({ path: "job/source.mp4", demuxers: ["mov"], signal: controller.signal }),
    ).toThrow("TX外呼禁止");
    expect(f.calls).toEqual([]);
    expect(await readdir(f.workDir)).toEqual(["tool.sock"]);
    await one.close();
  });
});
