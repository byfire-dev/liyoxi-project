// M5 only: keep original C50 intents in memory and replay them through the real Hono adapter.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { allRoutes } from "@liyoxi/contract";
import type { M5Support } from "@liyoxi/services/testing";
import type { M1Api, M1RequestInit } from "./in-process.js";
import { createM1Caller } from "./runner-api.js";
import type { M1Headers, M1Result } from "./runner-api.js";

export type M5Call = ReturnType<typeof createM1Caller>;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createM5Http(base: M1Api) {
  const routes = allRoutes
    .filter((route) => route["x-idempotent"] === "required")
    .map((route) => ({
      method: route.method.toUpperCase(),
      pattern: new RegExp(
        `^${route.path
          .split(/\{[^}]+\}/)
          .map(escape)
          .join("[^/]+")}$`,
      ),
    }));
  const intents = new Map<string, { path: string; init: M1RequestInit }>();
  let replaying = false;
  let replayedWrites = 0;
  const api: M1Api = {
    ...base,
    async request(path, init = {}) {
      const response = await base.request(path, init);
      const method = init.method?.toUpperCase() ?? "GET";
      const key = new Headers(init.headers).get("Idempotency-Key");
      const route = routes.find((entry) => entry.method === method && entry.pattern.test(path));
      if (!replaying && response.status === 200 && key && route) {
        // Cookies, secret bodies and signed URLs are never returned in reports or written to disk.
        const id = `${method}:${path}:${key}`;
        if (!intents.has(id))
          intents.set(id, { path, init: { ...init, json: structuredClone(init.json) } });
        if (response.headers.get("Idempotent-Replayed") === "true") replayedWrites += 1;
      }
      return response;
    },
  };
  return {
    api,
    call: createM1Caller(api),
    counts: () => ({ recordedWrites: intents.size, replayedWrites }),
    async replaySameIntent() {
      assert.equal(replaying, false);
      replaying = true;
      try {
        for (const { path, init } of intents.values()) {
          const result = await base.request(path, {
            ...init,
            json: structuredClone(init.json),
          });
          assert.equal(result.status, 200, "M5 original C50 intent must remain replayable");
          assert.equal(result.headers.get("Idempotent-Replayed"), "true");
          replayedWrites += 1;
        }
      } finally {
        replaying = false;
      }
    },
  };
}

export async function uploadM5Object(
  support: M5Support,
  registration: Pick<M1Result<"admin.file.create">, "mode" | "post" | "key" | "expiresAt">,
  bytes: Uint8Array,
) {
  assert.equal(registration.mode, "post");
  assert.ok(registration.post);
  assert.equal(
    await support.providers.storage.upload(
      { ...registration.post, key: registration.key, expiresAt: new Date(registration.expiresAt) },
      bytes,
    ),
    204,
  );
}

export async function readM5Signed(
  support: M5Support,
  url: string,
  expected: { readonly sha256: string; readonly sizeBytes?: number },
) {
  const response = support.providers.storage.fetch(url);
  assert.equal(response.status, 200, "M5 current signed file must read actual stored bytes");
  if (response.status !== 200) throw new Error("M5 current file unavailable");
  if (expected.sizeBytes !== undefined) assert.equal(response.body.length, expected.sizeBytes);
  assert.equal(sha(response.body), expected.sha256);
  return response.body;
}

export async function expectM5Failure(
  api: M1Api,
  path: string,
  headers: M1Headers,
  body: unknown,
  status: number,
  symbol: string,
  key: string,
) {
  const response = await api.request(path, {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": key },
    json: body,
  });
  assert.equal(response.status, status, "M5 guard returned its documented HTTP status");
  const failure: unknown = await response.json();
  assert.ok(failure && typeof failure === "object" && "error" in failure);
  assert.equal(failure.error, symbol);
}
