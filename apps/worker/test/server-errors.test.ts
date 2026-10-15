import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildWorkerServices } from "@liyoxi/services";
import type { QueueChannel, QueueConsumer } from "@liyoxi/services";
import { assembleForTest, createFakeProviders, useSeededDatabase } from "@liyoxi/services/testing";
import { expect, it, vi } from "vitest";
import { createWorkerRuntime } from "../src/runtime.js";
import { silentLogger } from "../src/log.js";

const db = useSeededDatabase("worker", { max: 1, label: "servererrors" });
it("W227服务端：真实worker循环/队列捕获与实例关闭；实际fatal子进程重复异常只非零退出一次且有界", async () => {
  const prisma = await db.prisma(),
    send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
  vi.stubGlobal("fetch", send);
  const handlers = new Map<string, (data: unknown) => Promise<void>>();
  const channel: QueueChannel = {
    enqueue: async () => undefined,
    downForMs: () => 0,
    ping: async () => true,
    close: async () => undefined,
    consume<T>(
      queue: string,
      _concurrency: number,
      handle: (data: T) => Promise<void>,
    ): QueueConsumer {
      handlers.set(queue, (data) => handle(data as T));
      return { start() {}, pause: async () => undefined, close: async () => undefined };
    },
  };
  const logger = { ...silentLogger, error: vi.fn() };
  const services = buildWorkerServices({
    appEnv: "test",
    prisma,
    assembly: assembleForTest({ entry: "worker" }),
    channel,
    logger,
    providers: createFakeProviders(),
    keys: {
      SERVER_ERRORS: { worker: { dsn: "https://fictionalworker@errors.example.invalid/43" } },
    },
    serverErrorSource: {
      release: "sha-0123456789ab",
      artifactRoot: new URL("file:///app/apps/worker/dist/"),
    },
  });
  const runtime = createWorkerRuntime({ services, channel, logger }),
    close = vi.spyOn(services, "closeServerErrors");
  try {
    vi.spyOn(services, "relay").mockRejectedValueOnce(new Error("fixture loop"));
    await runtime.loops.outbox_relay.tick();
    await expect(handlers.get("promote")!({})).rejects.toThrow("历史媒体队列参数不合法");
    await services.serverErrors!.drain();
    expect(send).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls
        .map((call) => JSON.parse(String(call[1]!.body).split("\n")[2]!).tags.kind)
        .sort(),
    ).toEqual(["worker.loop", "worker.queue"]);
    const first = runtime.stop();
    expect(runtime.stop()).toBe(first);
    await first;
    // reporter归进程入口：先原业务stop，入口捕获终止错误并drain后才close。
    expect(close).not.toHaveBeenCalled();
    await services.closeServerErrors?.();
    expect(close).toHaveBeenCalledOnce();
    expect(services.serverErrors!.snapshot()).toMatchObject({ closed: true, active: 0, queued: 0 });
  } finally {
    await runtime.stop();
    await services.closeServerErrors?.();
    vi.unstubAllGlobals();
  }

  const modulePath = fileURLToPath(
    new URL("../../../packages/services/src/ops/server-errors.ts", import.meta.url),
  );
  const cli = fileURLToPath(
    new URL("../../../packages/services/node_modules/tsx/dist/cli.mjs", import.meta.url),
  );
  for (const configured of [false, true]) {
    const source = `import {createServerErrorReporter,installServerErrorHandlers} from ${JSON.stringify(modulePath)};
      const reporter=createServerErrorReporter({component:'worker',release:'sha-0123456789ab',clock:{now:()=>new Date()},logger:{info(){}},${configured ? "dsn:'https://fictionalworker@errors.example.invalid/43',fetch:()=>new Promise(()=>{})," : ""}});
      const at=performance.now(); installServerErrorHandlers({reporter,log(){console.log('fatal-logged')},exit(code){console.log(JSON.stringify({code,ms:performance.now()-at}));process.exit(code)}});
      setImmediate(()=>{throw new Error('fixture uncaught')}); Promise.reject(new Error('fixture rejection'));`;
    const child = spawnSync(process.execPath, [cli, "--eval", source], {
      encoding: "utf8",
      timeout: 8_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stdout.match(/fatal-logged/g)).toHaveLength(1);
    const final = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
    expect(final.code).toBe(1);
    expect(final.ms).toBeLessThan(2_500);
    if (configured) expect(final.ms).toBeGreaterThanOrEqual(1_999);
  }
}, 60_000);
