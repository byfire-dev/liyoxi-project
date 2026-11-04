import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import test from "node:test";
import {
  createLiveEdge,
  createOwnedDirectory,
  createTestTls,
  proxyHeaders,
  proxyResponseHeaders,
  requestPath,
  staticRelative,
} from "./live-edge.mjs";

test("static routing admits the owned auth entries and built assets, never source or private artifacts", () => {
  assert.equal(
    staticRelative(requestPath("/__portal-live/session?case=auth")),
    "test/e2e/browser-session.html",
  );
  assert.equal(
    staticRelative(requestPath("/assets/session-12345678.js")),
    "assets/session-12345678.js",
  );
  for (const path of ["/", "/a"])
    assert.equal(staticRelative(path), "test/e2e/browser-session.html");
  for (const path of [
    "/items",
    "/src/main.tsx",
    "/control.sock",
    "/private-key.pem",
    "/certificate.pem",
    "/assets/secret.json",
    "/assets/session.js.map",
    "/assets/../private-key.pem",
  ])
    assert.equal(staticRelative(path), null);
});

test("request target traversal is rejected before URL normalization and cannot escape the static root", () => {
  for (const path of [
    "https://other.invalid/file",
    "//other.invalid/file",
    "/assets/../a.js",
    "/assets/%2e%2e/a.js",
    "/assets/%252e%252e/a.js",
    "/assets/./a.js",
    "/assets/%5ca.js",
    "/assets/a%00.js",
    "/assets/%",
    "/assets/a.js#fragment",
    "/assets/\na.js",
  ])
    assert.throws(() => requestPath(path), /^Error: PORTAL_LIVE_BOUNDARY_REJECTED$/);
});

test("proxy preserves real auth bytes and original Origin while replacing only untrusted forwarding facts", () => {
  const source = {
    host: "portal.localhost:4443",
    origin: "https://wrong.invalid",
    cookie: "public-cookie-fixture",
    "x-poll-secret": "public-poll-fixture",
    "x-lyx-portal": "1",
    "content-type": "application/json",
    "content-length": "2",
    connection: "keep-alive, x-hop",
    "x-hop": "remove",
    "x-forwarded-for": "198.51.100.1",
    "x-forwarded-proto": "http",
    "x-forwarded-host": "api.localhost",
    forwarded: "for=198.51.100.1",
  };
  assert.deepEqual(proxyHeaders(source, "::ffff:127.0.0.1"), {
    host: source.host,
    origin: source.origin,
    cookie: source.cookie,
    "x-poll-secret": source["x-poll-secret"],
    "x-lyx-portal": "1",
    "content-type": "application/json",
    "content-length": "2",
    "x-forwarded-for": "127.0.0.1",
    "x-forwarded-proto": "https",
  });
  assert.equal(source["x-forwarded-for"], "198.51.100.1");
  const missingOrigin = proxyHeaders({ host: source.host }, "127.0.0.1");
  assert.equal(Object.hasOwn(missingOrigin, "origin"), false);
  assert.equal(Object.hasOwn(missingOrigin, "x-lyx-portal"), false);
});

test("hop-by-hop nominations cannot remove Host into localhost bypass or remove authentication guards", () => {
  for (const name of ["Host", "Origin", "Cookie", "X-LYX-Portal", "X-Poll-Secret"])
    assert.throws(
      () => proxyHeaders({ host: "portal.localhost:4443", connection: name }, "127.0.0.1"),
      /^Error: PORTAL_LIVE_BOUNDARY_REJECTED$/,
    );
  assert.throws(() => proxyHeaders({}, "198.51.100.1"), /^Error: PORTAL_LIVE_BOUNDARY_REJECTED$/);
});

test("upstream Set-Cookie headers retain separate values and their original Secure attributes", () => {
  const cookies = [
    "session=public-fixture; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=120",
    "other=public-fixture; Path=/; Secure",
  ];
  assert.deepEqual(
    proxyResponseHeaders({
      "set-cookie": cookies,
      "cache-control": "no-store",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
    }),
    { "set-cookie": cookies, "cache-control": "no-store" },
  );
});

async function listen(server) {
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      accept();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((accept, reject) => {
    server.close((error) => (error ? reject(error) : accept()));
    server.closeAllConnections();
  });
}

function edgeRequest(
  edge,
  tls,
  signal,
  { path = "/__portal-live/session", method = "GET", headers = {}, body } = {},
) {
  const origin = new URL(edge.origin);
  return new Promise((accept, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: Number(origin.port),
        servername: "portal.localhost",
        ca: tls.cert,
        agent: false,
        signal,
        path,
        method,
        headers: { host: origin.host, ...headers },
      },
      (response) => {
        const chunks = [];
        const authorized = response.socket.authorized;
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () =>
          accept({
            status: response.statusCode,
            headers: response.headers,
            bytes: Buffer.concat(chunks),
            authorized,
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

test(
  "real local TLS edge forwards public technical bytes and closes without bypassing ownership",
  { timeout: 10_000 },
  async (t) => {
    const owned = await createOwnedDirectory(randomBytes(6).toString("hex"));
    let outside, edge;
    const observed = [];
    // A transport-only echo peer, not an API handler or a fabricated authenticated business result.
    const cookies = [
      "edge-probe=public-technical-bytes; Path=/; HttpOnly; Secure; SameSite=Strict",
      "edge-other=public-technical-bytes; Path=/; Secure",
    ];
    const responseBytes = Buffer.from([0, 1, 2, 255, 10]);
    const upstream = createHttpServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        observed.push({
          method: request.method,
          path: request.url,
          headers: request.headers,
          bytes: Buffer.concat(chunks),
        });
        response.writeHead(207, {
          "content-type": "application/octet-stream",
          "set-cookie": cookies,
        });
        response.end(responseBytes);
      });
    });
    t.after(async () => {
      const processes = await Promise.allSettled([edge?.close(), closeServer(upstream)]);
      const directories = await Promise.allSettled([owned.close(), outside?.close()]);
      assert.equal(
        [...processes, ...directories].every((result) => result.status === "fulfilled"),
        true,
      );
    });
    outside = await createOwnedDirectory(randomBytes(6).toString("hex"));
    assert.equal((await lstat(owned.directory)).mode & 0o777, 0o700);
    const tls = await createTestTls(owned.directory);
    assert.equal((await lstat(join(owned.directory, "private-key.pem"))).mode & 0o777, 0o600);
    const staticRoot = join(owned.directory, "browser");
    await mkdir(join(staticRoot, "test/e2e"), { recursive: true });
    await mkdir(join(staticRoot, "assets"));
    const html = "<!doctype html><title>Public edge transport probe</title>";
    await writeFile(join(staticRoot, "test/e2e/browser-session.html"), html);
    await writeFile(join(staticRoot, "assets/probe-12345678.js"), "export const probe = true;\n");
    await writeFile(join(outside.directory, "outside.js"), "PUBLIC-OUTSIDE-ROOT");
    await symlink(join(outside.directory, "outside.js"), join(staticRoot, "assets/escape.js"));
    const apiPort = await listen(upstream);
    edge = await createLiveEdge({ directory: owned.directory, tls });
    const pending = await edgeRequest(edge, tls, t.signal);
    assert.equal(pending.status, 503);
    assert.equal(pending.authorized, true);
    assert.equal(observed.length, 0);
    await assert.rejects(
      edge.activate({ apiPort, root: outside.directory }),
      /^Error: PORTAL_LIVE_BOUNDARY_REJECTED$/,
    );
    await edge.activate({ apiPort, root: staticRoot });
    await assert.rejects(
      edge.activate({ apiPort, root: staticRoot }),
      /^Error: PORTAL_LIVE_BOUNDARY_REJECTED$/,
    );
    const page = await edgeRequest(edge, tls, t.signal);
    assert.equal(page.status, 200);
    assert.equal(page.bytes.toString("utf8"), html);
    assert.equal(page.headers["cache-control"], "no-store");
    const head = await edgeRequest(edge, tls, t.signal, {
      path: "/assets/probe-12345678.js",
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.equal(head.bytes.length, 0);
    assert.ok(Number(head.headers["content-length"]) > 0);
    assert.equal(
      (await edgeRequest(edge, tls, t.signal, { path: "/assets/escape.js" })).status,
      404,
    );
    assert.equal(
      (await edgeRequest(edge, tls, t.signal, { path: "/private-key.pem" })).status,
      404,
    );
    assert.equal(
      (await edgeRequest(edge, tls, t.signal, { headers: { host: "api.localhost" } })).status,
      421,
    );
    const sent = Buffer.from([8, 7, 0, 255]);
    const path = "/api/v1/portal/__edge_transport_probe?public=bytes";
    const response = await edgeRequest(edge, tls, t.signal, {
      path,
      method: "PUT",
      body: sent,
      headers: {
        origin: "https://wrong.example.invalid",
        "content-type": "application/octet-stream",
        "content-length": String(sent.length),
        "x-forwarded-for": "198.51.100.1",
      },
    });
    assert.equal(response.status, 207);
    assert.deepEqual(response.bytes, responseBytes);
    assert.deepEqual(response.headers["set-cookie"], cookies);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].method, "PUT");
    assert.equal(observed[0].path, path);
    assert.equal(observed[0].headers.host, new URL(edge.origin).host);
    assert.equal(observed[0].headers.origin, "https://wrong.example.invalid");
    assert.equal(observed[0].headers["x-forwarded-for"], "127.0.0.1");
    assert.equal(observed[0].headers["x-forwarded-proto"], "https");
    assert.deepEqual(observed[0].bytes, sent);
    const closing = edge.close();
    assert.equal(edge.close(), closing);
    await closing;
    await assert.rejects(
      edgeRequest(edge, tls, t.signal),
      (error) => error.code === "ECONNREFUSED",
    );
    await closeServer(upstream);
    const cleanup = owned.close();
    assert.equal(owned.close(), cleanup);
    await cleanup;
    await assert.rejects(lstat(owned.directory), { code: "ENOENT" });
  },
);

test(
  "an existing or replaced owner directory is never reused or recursively deleted",
  { timeout: 10_000 },
  async (t) => {
    const runId = randomBytes(6).toString("hex");
    const owned = await createOwnedDirectory(runId);
    let other,
      moved = false,
      linked = false;
    t.after(async () => {
      if (linked) await rm(owned.directory); // Only our own link; never follow it into the other owner.
      const results = await Promise.allSettled([moved ? undefined : owned.close(), other?.close()]);
      assert.equal(
        results.every((result) => result.status === "fulfilled"),
        true,
      );
    });
    other = await createOwnedDirectory(randomBytes(6).toString("hex"));
    await writeFile(join(owned.directory, "proof"), "PUBLIC-OWNED-PROOF");
    await writeFile(join(other.directory, "proof"), "PUBLIC-OTHER-PROOF");
    await assert.rejects(createOwnedDirectory(runId), /^Error: PORTAL_LIVE_BOUNDARY_REJECTED$/);
    assert.equal(await readFile(join(owned.directory, "proof"), "utf8"), "PUBLIC-OWNED-PROOF");
    await rename(owned.directory, join(other.directory, "parked-owner"));
    moved = true;
    await symlink(other.directory, owned.directory);
    linked = true;
    await assert.rejects(createTestTls(owned.directory), /^Error: PORTAL_LIVE_BOUNDARY_REJECTED$/);
    await assert.rejects(owned.close(), /^Error: PORTAL_LIVE_BOUNDARY_REJECTED$/);
    assert.equal(await readFile(join(other.directory, "proof"), "utf8"), "PUBLIC-OTHER-PROOF");
    assert.equal(
      await readFile(join(other.directory, "parked-owner/proof"), "utf8"),
      "PUBLIC-OWNED-PROOF",
    );
  },
);
