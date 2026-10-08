#!/usr/bin/env node
// 宿主机手工跑 API/worker 时的 MinIO 局域网入口。保留 Host，供 S3 预签名验签。
// node infra/stack/minio-lan.mjs --host <本机局域网IPv4> [--port 9110]
// 只转发到共享依赖的 127.0.0.1:9100，不读取 .env 或密钥，不记录请求路径/表单。
import { createServer, request } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { host: { type: "string" }, port: { type: "string", default: "9110" } },
});
const host = values.host;
const port = Number(values.port);
const localAddresses = Object.values(networkInterfaces()).flatMap((entries) => entries ?? []);
if (!host || isIP(host) !== 4 || !localAddresses.some((entry) => entry.address === host)) {
  throw new Error("--host 须为本机现有网卡的 IPv4 地址");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("--port 须为 1–65535 的整数");
}

const server = createServer({ requestTimeout: 300_000 }, (incoming, outgoing) => {
  const upstream = request(
    {
      hostname: "127.0.0.1",
      port: 9100,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
      timeout: 300_000,
    },
    (response) => {
      response.on("error", () => outgoing.destroy());
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on("timeout", () => upstream.destroy());
  upstream.on("error", () => {
    if (outgoing.headersSent) outgoing.destroy();
    else outgoing.writeHead(502).end("MinIO unavailable");
  });
  incoming.on("aborted", () => upstream.destroy());
  outgoing.on("close", () => {
    if (!outgoing.writableFinished) upstream.destroy();
  });
  incoming.pipe(upstream);
});
server.on("error", (error) => {
  console.error(`MinIO 局域网入口启动失败（${error.code ?? "unknown"}）`);
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`MinIO 局域网入口已就绪：http://${host}:${port}`));
const stop = () => {
  server.close();
  server.closeAllConnections();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
