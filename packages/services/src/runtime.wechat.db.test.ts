import { createServer } from "node:http";
import type { Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { loadEnv } from "./kernel/index.js";
import { createRuntime } from "./runtime.js";
import { createLogger } from "./logger.js";
import { createFakeProviders, useTestDatabase, useTestRedis } from "./testing/index.js";

const db = useTestDatabase("services");
const redis = useTestRedis();
const config = {
  appid: "wx_runtime_fake",
  secret: "public-fake-secret",
  messageToken: "public-fake-token",
  messageEncodingAESKey: "A".repeat(43),
};
const logger = () =>
  createLogger({
    svc: "api",
    env: "test",
    level: "debug",
    version: "fake",
    destination: { write() {} },
  });

it("运行时使用完整配置；初始化零外呼，close取消真实慢流并归还socket", async () => {
  const sockets = new Set<Socket>();
  const socketClosed: Promise<void>[] = [];
  let arrived!: () => void;
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"openid":"fake",');
    arrived();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socketClosed.push(
      new Promise<void>((resolve) =>
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        }),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("owned HTTP未就绪");
  const nativeFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    expect(new URL(String(url)).origin).toBe("https://api.weixin.qq.com");
    return nativeFetch(`http://127.0.0.1:${address.port}/owned`, init);
  });
  const runtime = createRuntime({
    entry: "api",
    env: { ...loadEnv(), DATABASE_URL: await db.url(), WECHAT: config },
    version: "fake",
    redisKeyPrefix: redis.prefix,
    logger: logger(),
  });
  try {
    expect(runtime.providers.wechat.status).toBe("wechat");
    expect(spy).not.toHaveBeenCalled();
    const pending = runtime.providers.wechat.code2Session({ code: "fake" });
    await arrival;
    await runtime.close();
    expect(await pending).toMatchObject({ reason: "unavailable" });
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await Promise.all(socketClosed);
    expect(sockets.size).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.close();
    spy.mockRestore();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("显式替身优先，不从真实配置创建另一份驱动", async () => {
  const fake = createFakeProviders();
  const spy = vi.spyOn(globalThis, "fetch");
  const runtime = createRuntime({
    entry: "api",
    env: { ...loadEnv(), DATABASE_URL: await db.url(), WECHAT: config },
    version: "fake",
    redisKeyPrefix: redis.prefix,
    logger: logger(),
    providers: fake,
  });
  try {
    expect(runtime.providers).toBe(fake);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    await runtime.close();
    spy.mockRestore();
  }
});
