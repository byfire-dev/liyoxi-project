import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { createMinioStorage } from "./minio.js";

const bytes = new TextEncoder().encode("bounded independent HTTP bytes"),
  sha256 = createHash("sha256").update(bytes).digest("hex"),
  identity = "2".repeat(64),
  etag = '"fixed-test-etag"';
async function scenario(mode: "precondition" | "reset" | "metadata-mismatch") {
  let heads = 0,
    gets = 0,
    puts = 0,
    scans = 0,
    closedSources = 0,
    closedSourcesAtReplay = 0,
    getIfMatch: string | undefined,
    conditionalHeader: string | string[] | undefined;
  const sockets = new Set<Socket>(),
    closed: Promise<void>[] = [];
  const server = createServer((request, reply) => {
    if (request.method === "HEAD") {
      heads++;
      if (heads === 1 && mode !== "metadata-mismatch") {
        reply.writeHead(404);
        reply.end();
        return;
      }
      // The caller must close an unfinished source before starting replay verification.
      closedSourcesAtReplay = closedSources;
      reply.writeHead(200, {
        "content-length": bytes.length,
        etag,
        "x-amz-meta-sha256": sha256,
        "x-amz-meta-content-identity": identity,
      });
      reply.end();
      return;
    }
    if (request.method === "GET") {
      gets++;
      getIfMatch = request.headers["if-match"];
      const actual = mode === "metadata-mismatch" ? new Uint8Array(bytes.length) : bytes;
      reply.writeHead(200, { "content-length": actual.length, etag });
      reply.end(actual);
      return;
    }
    if (request.method === "PUT") {
      puts++;
      conditionalHeader = request.headers["if-none-match"];
      request.once("data", () => {
        if (mode === "reset") {
          request.socket.destroy();
          return;
        }
        const body =
          "<Error><Code>PreconditionFailed</Code><Message>fixed fixture</Message></Error>";
        reply.writeHead(412, {
          "content-type": "application/xml",
          "content-length": Buffer.byteLength(body),
          connection: "close",
        });
        reply.end(body);
      });
      request.on("error", () => {});
      request.resume();
      return;
    }
    reply.writeHead(500);
    reply.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    closed.push(
      new Promise<void>((resolve) =>
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        }),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port,
    driver = createMinioStorage({
      endpoint: `http://127.0.0.1:${port}`,
      region: "us-east-1",
      accessKey: "public-fake-key",
      secretKey: "public-fake-secret",
      buckets: { secure: "test-secure", asset: "test-asset", media: "test-media", pub: "test-pub" },
    });
  try {
    const result = await driver.putStream({
      bucket: "media",
      key: "fixed/output.mp4",
      size: bytes.length,
      sha256,
      contentIdentity: identity,
      contentType: "video/mp4",
      ifAbsent: true,
      signal: AbortSignal.timeout(2000),
      body: async function* (signal) {
        scans++;
        try {
          if (scans === 1) {
            yield bytes;
            return;
          }
          yield bytes.slice(0, 5);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          yield bytes.slice(5);
        } finally {
          closedSources++;
        }
      },
    });
    if (mode === "metadata-mismatch") {
      expect(result).toMatchObject({ ok: false, reason: "rejected" });
      expect(scans).toBe(1);
      expect(closedSources).toBe(1);
      expect(puts).toBe(0);
      expect(heads).toBe(2);
      expect(gets).toBe(1);
      expect(getIfMatch).toBe(etag);
      return;
    }
    expect(scans).toBe(2);
    expect(closedSources).toBe(2);
    expect(puts).toBe(1);
    expect(conditionalHeader).toBe("*");
    if (mode === "precondition") {
      expect(result).toEqual({ ok: true, value: { etag, size: bytes.length } });
      expect(heads).toBe(3);
      expect(gets).toBe(1);
      expect(getIfMatch).toBe(etag);
      expect(closedSourcesAtReplay).toBe(2);
    } else {
      expect(result).toMatchObject({ ok: false, reason: "unavailable" });
      expect(heads).toBe(1);
    }
  } finally {
    await driver.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await Promise.all(closed);
    expect(sockets.size).toBe(0);
  }
}
describe("MinIO native streamed conditional protocol", () => {
  it("MinIO metadata声明正确但真实GET字节不符时拒绝已有对象且零PUT", () =>
    scenario("metadata-mismatch"));
  it("明确early412先取消并等待相同源finally，再真实HEAD验证重放", () => scenario("precondition"));
  it("真实socket reset仍未知失败，不假412或HEAD重放，源与socket全部回收", () => scenario("reset"));
});
