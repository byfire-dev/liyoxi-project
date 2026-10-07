// W119B 早期 CORS 探针：只接公开本机 POST policy 和固定测试 MP4，不读数据库或服务配置。
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const post = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const url = new URL(post.url);
if (url.origin !== "http://127.0.0.1:9100" || url.pathname !== "/lyx-local-media")
  throw new Error("只接受公开本机 MinIO 桶");
const bytes = [
  ...(await readFile(
    new URL("../../../../packages/services/src/testing/admin-live/w119-known.mp4", import.meta.url),
  )),
];
const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end("<!doctype html><title>W119B 本机直传</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: process.env.LYX_E2E_CHANNEL || undefined });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const status = await page.evaluate(
    async ({ post, bytes }) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(post.fields)) form.append(key, value);
      form.append("file", new File([new Uint8Array(bytes)], "known.mp4", { type: "video/mp4" }));
      return (await fetch(post.url, { method: "POST", body: form, credentials: "omit" })).status;
    },
    { post, bytes },
  );
  if (status < 200 || status >= 300) throw new Error("真实 browser POST 未成功");
  process.stdout.write(`${JSON.stringify({ status, browserPost: true })}\n`);
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
