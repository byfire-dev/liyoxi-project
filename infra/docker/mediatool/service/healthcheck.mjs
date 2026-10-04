// @ts-check
// 容器的健康检查：套接字上的 /healthz 答 200 即健康。由 Dockerfile 的 HEALTHCHECK 调用。
import http from "node:http";

import { SOCKET_PATH } from "./paths.mjs";

const request = http.get({ socketPath: SOCKET_PATH, path: "/healthz", timeout: 2000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
request.on("timeout", () => process.exit(1));
request.on("error", () => process.exit(1));
