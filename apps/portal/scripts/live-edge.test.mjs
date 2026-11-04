import assert from "node:assert/strict";
import test from "node:test";
import { proxyHeaders, proxyResponseHeaders, requestPath, staticRelative } from "./live-edge.mjs";

test("static routing admits only the technical entry and built assets, never source or private artifacts", () => {
  assert.equal(
    staticRelative(requestPath("/__portal-live/session?case=auth")),
    "test/e2e/browser-session.html",
  );
  assert.equal(
    staticRelative(requestPath("/assets/session-12345678.js")),
    "assets/session-12345678.js",
  );
  for (const path of [
    "/",
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
