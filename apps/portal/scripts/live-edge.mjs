// Native test edge. It forwards real bytes and never reads an authentication body or cookie value.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { assertPort, assertRunId, boundaryFailure } from "./live-protocol.mjs";

const execute = promisify(execFile);
const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
};
const hasControlOrSpace = (value) => [...value].some((character) => character.charCodeAt(0) <= 32);

export async function createOwnedDirectory(runId) {
  assertRunId(runId);
  const base = await realpath("/tmp");
  if (!["/tmp", "/private/tmp"].includes(base)) throw boundaryFailure();
  const directory = join(base, `lyx-portal-${runId}`);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch {
    throw boundaryFailure();
  }
  const identity = await lstat(directory);
  let closing;
  return {
    directory,
    close() {
      closing ??= (async () => {
        let current;
        try {
          current = await lstat(directory);
        } catch (error) {
          if (error.code === "ENOENT") return;
          throw boundaryFailure();
        }
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.dev !== identity.dev ||
          current.ino !== identity.ino
        )
          throw boundaryFailure();
        await rm(directory, { recursive: true, force: false });
      })();
      return closing;
    },
  };
}

export async function createTestTls(directory) {
  // The caller supplies only its newly created owner directory, never a user certificate path.
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(directory)) !== directory ||
    !/^\/(?:private\/)?tmp\/lyx-portal-[a-f0-9]{12}$/.test(directory)
  )
    throw boundaryFailure();
  const config = join(directory, "tls.cnf"),
    key = join(directory, "private-key.pem"),
    cert = join(directory, "certificate.pem");
  for (const path of [key, cert]) {
    const file = await open(path, "wx", 0o600);
    await file.close();
  }
  await writeFile(
    config,
    [
      "[req]",
      "distinguished_name=dn",
      "x509_extensions=v3",
      "prompt=no",
      "[dn]",
      "CN=portal.localhost",
      "[v3]",
      "subjectAltName=DNS:portal.localhost",
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign",
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  try {
    await execute(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-config",
        config,
        "-keyout",
        key,
        "-out",
        cert,
      ],
      {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    );
    await chmod(key, 0o600);
    return { key: await readFile(key), cert: await readFile(cert) };
  } catch {
    throw new Error("PORTAL_LIVE_TLS_PREPARE_FAILED");
  }
}

/** Reject traversal before URL normalization can erase it. Queries are not filesystem names. */
export function requestPath(raw) {
  if (
    typeof raw !== "string" ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    hasControlOrSpace(raw) ||
    raw.includes("\\") ||
    raw.includes("#")
  )
    throw boundaryFailure();
  let path;
  try {
    path = decodeURIComponent(raw.split("?")[0]);
  } catch {
    throw boundaryFailure();
  }
  if (
    hasControlOrSpace(path) ||
    path.includes("\\") ||
    path.includes("%") ||
    path.split("/").some((part) => part === "." || part === "..") ||
    path.startsWith("//")
  )
    throw boundaryFailure();
  return path;
}

export function staticRelative(path) {
  if (path === "/__portal-live/session") return "test/e2e/browser-session.html";
  if (
    path === "/v" ||
    /^\/preview\/(ad|sample)\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    )
  )
    return "test/e2e/browser-session.html";
  if (
    /^\/assets\/[A-Za-z0-9_./-]+$/.test(path) &&
    !path.split("/").some((part) => part === "." || part === "..")
  ) {
    const relative = path.slice(1);
    if (Object.hasOwn(MIME, extname(relative))) return relative;
  }
  return null;
}

/** Only the current owner's opaque media grant may use the private API transport. */
export function isPreviewMediaPath(raw, runId) {
  assertRunId(runId);
  const prefix = `/__portal-live/${runId}/media/`;
  return (
    typeof raw === "string" &&
    raw.startsWith(prefix) &&
    /^[a-f0-9]{32}$/.test(raw.slice(prefix.length))
  );
}

export function proxyHeaders(headers, peer) {
  if (!["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(peer)) throw boundaryFailure();
  const copied = { ...headers };
  const nominated = String(copied.connection ?? "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim());
  // Removing Host would make Node synthesize the internal host and bypass the public surface guard.
  if (
    nominated.some((name) =>
      ["host", "origin", "cookie", "x-lyx-portal", "x-poll-secret"].includes(name),
    )
  )
    throw boundaryFailure();
  for (const name of [
    ...HOP_HEADERS,
    ...nominated,
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
  ])
    delete copied[name];
  copied["x-forwarded-for"] = peer === "::ffff:127.0.0.1" ? "127.0.0.1" : peer;
  copied["x-forwarded-proto"] = "https";
  return copied;
}

export function proxyResponseHeaders(headers) {
  const copied = { ...headers };
  const nominated = String(copied.connection ?? "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim());
  for (const name of [...HOP_HEADERS, ...nominated]) delete copied[name];
  return copied;
}

function reply(response, status) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
  });
  response.end("Portal live edge");
}

export async function createLiveEdge({ directory, tls }) {
  const owned = await realpath(directory);
  if (owned !== directory || !/^\/(?:private\/)?tmp\/lyx-portal-[a-f0-9]{12}$/.test(owned))
    throw boundaryFailure();
  const runId = owned.slice(-12);
  let origin,
    upstreamPort,
    staticRoot,
    closing = false,
    closePromise;
  const upstreams = new Set();
  const server = createServer(
    { ...tls, requestTimeout: 60_000, headersTimeout: 10_000 },
    (request, response) => {
      void (async () => {
        if (closing || !origin || !upstreamPort || !staticRoot) {
          reply(response, 503);
          return;
        }
        if (request.headers.host !== new URL(origin).host) {
          reply(response, 421);
          return;
        }
        const path = requestPath(request.url);
        const previewMedia = isPreviewMediaPath(request.url, runId);
        if (previewMedia && request.method !== "GET" && request.method !== "HEAD") {
          reply(response, 405);
          return;
        }
        if (path.startsWith("/api/v1/") || previewMedia) {
          const upstream = httpRequest(
            {
              hostname: "127.0.0.1",
              port: upstreamPort,
              method: request.method,
              path: request.url,
              headers: proxyHeaders(request.headers, request.socket.remoteAddress),
            },
            (incoming) => {
              if (response.destroyed || response.writableEnded) {
                incoming.destroy();
                return;
              }
              response.writeHead(
                incoming.statusCode ?? 502,
                proxyResponseHeaders(incoming.headers),
              );
              incoming.on("error", () => response.destroy());
              incoming.on("aborted", () => response.destroy());
              incoming.pipe(response);
            },
          );
          upstreams.add(upstream);
          upstream.once("close", () => upstreams.delete(upstream));
          upstream.once("error", () => reply(response, 502));
          request.once("aborted", () => upstream.destroy());
          request.once("error", () => upstream.destroy());
          response.once("close", () => {
            if (!response.writableEnded) upstream.destroy();
          });
          request.pipe(upstream);
          return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          reply(response, 405);
          return;
        }
        const relative = staticRelative(path);
        if (!relative) {
          reply(response, 404);
          return;
        }
        const candidate = resolve(staticRoot, relative);
        if (
          !candidate.startsWith(`${staticRoot}${sep}`) ||
          (await realpath(candidate)) !== candidate
        ) {
          reply(response, 404);
          return;
        }
        const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat();
          if (!stat.isFile()) {
            reply(response, 404);
            return;
          }
          response.writeHead(200, {
            "content-type": MIME[extname(candidate)],
            "content-length": stat.size,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          });
          if (request.method === "HEAD") {
            response.end();
            return;
          }
          await new Promise((accept) => {
            const stream = file.createReadStream({ autoClose: false });
            const done = () => {
              stream.destroy();
              accept();
            };
            stream.once("error", () => {
              response.destroy();
              done();
            });
            response.once("close", done);
            response.once("finish", done);
            stream.pipe(response);
          });
        } finally {
          await file.close();
        }
      })().catch(() => reply(response, 400));
    },
  );
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("tlsClientError", (_error, socket) => socket.destroy());
  server.on("error", () => {
    closing = true;
  });
  await new Promise((accept, reject) => {
    const fail = () => reject(new Error("PORTAL_LIVE_TLS_LISTEN_FAILED"));
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      accept();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw boundaryFailure();
  origin = `https://portal.localhost:${address.port}`;
  return {
    origin,
    async activate({ apiPort, root }) {
      assertPort(apiPort);
      if (closing || upstreamPort || staticRoot || typeof root !== "string")
        throw boundaryFailure();
      const actual = await realpath(root);
      if (
        actual !== resolve(root) ||
        !actual.startsWith(`${owned}${sep}`) ||
        !(await lstat(actual)).isDirectory()
      )
        throw boundaryFailure();
      staticRoot = actual;
      upstreamPort = apiPort;
    },
    close() {
      closePromise ??= (async () => {
        closing = true;
        for (const upstream of upstreams) upstream.destroy();
        await new Promise((accept, reject) => {
          server.close((error) =>
            error ? reject(new Error("PORTAL_LIVE_TLS_CLOSE_FAILED")) : accept(),
          );
          server.closeAllConnections();
        });
      })();
      return closePromise;
    },
  };
}
