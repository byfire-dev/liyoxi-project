// 故障注入之三：Redis 不可用（W0-05b）。在客户端一侧造：不停共享的那份 Redis。
//
// 做法：本机起一个只做转发的端口，客户端连它、它连真的 Redis。打开开关（down）时掐断现有连接并关掉这个端口，
// 新来的连接被拒（ECONNREFUSED）；关掉开关（up）后在同一个端口上重新监听、照常转发。
// 对客户端来说与 Redis 宕机是一回事，ioredis、BullMQ 各自的重连与报错逻辑走的都是真的那条路。
// 别的会话、别的 worker 连的是真的 Redis，不受影响。
// 断着的时候不能“接上再断开”：TCP 一接通，ioredis 就把重试计数清零，排着队的命令永远等不到报错。
// 01 第 7.3 节写了 Redis 不可用时各能力该是什么表现；本文件只交造条件的工具。

import { createServer, connect } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";

export interface RedisOutage {
  /** 给客户端用的连接串：主机与端口换成了转发口，其余（账号、库号）照原样 */
  readonly url: string;
  /** 现在是不是“不可用” */
  readonly isDown: boolean;
  /** 打开开关：掐断现有连接，之后的连接一律被拒 */
  down(): Promise<void>;
  /** 关掉开关：恢复转发，客户端自己重连 */
  up(): Promise<void>;
  /** 收尾：关掉转发口 */
  close(): Promise<void>;
}

/** @param targetUrl 真的 Redis 的连接串；缺省取环境变量 REDIS_URL */
export async function createRedisOutage(targetUrl?: string): Promise<RedisOutage> {
  const given = targetUrl ?? process.env.REDIS_URL;
  if (!given) throw new Error("REDIS_URL 未设置：要有一份真的 Redis 可转发");
  const target = new URL(given);
  if (target.protocol !== "redis:") {
    throw new Error("Redis 故障注入只转发不加密的 redis:// 连接（本地与 CI 都是）");
  }
  const upstreamPort = Number(target.port || "6379");
  const upstreamHost = target.hostname;

  const sockets = new Set<Socket>();
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // 连接被掐断时两头都会报错，这里不处理：要的就是它断
    socket.on("error", () => {});
  };
  const forward = (downstream: Socket): void => {
    track(downstream);
    const upstream = connect(upstreamPort, upstreamHost);
    track(upstream);
    downstream.pipe(upstream);
    upstream.pipe(downstream);
    downstream.on("close", () => upstream.destroy());
    upstream.on("close", () => downstream.destroy());
  };
  /** port 给 0 由系统挑一个空闲端口 */
  const listen = (port: number): Promise<Server> =>
    new Promise((resolve, reject) => {
      const server = createServer(forward);
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve(server));
    });
  const stop = (server: Server): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    });

  let server: Server | undefined = await listen(0);
  const port = (server.address() as AddressInfo).port;
  const url = new URL(target.toString());
  url.hostname = "127.0.0.1";
  url.port = String(port);

  return {
    url: url.toString(),
    get isDown() {
      return server === undefined;
    },
    async down() {
      const current = server;
      server = undefined;
      if (current) await stop(current);
    },
    async up() {
      // 回到原来的端口：客户端手里的连接串不变
      server ??= await listen(port);
    },
    async close() {
      const current = server;
      server = undefined;
      if (current) await stop(current);
    },
  };
}
