import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAsrWebhookSource } from "./index.js";
import type { WebhookRequest, WebhookVerification } from "./index.js";

// Public synthetic fixtures; HMAC is computed independently of the source implementation.
const key = "public-fake-asr-callback-key-at-least-32-bytes";
const id = "019a5430-9000-7000-8000-000000000001";
const now = new Date("2026-10-11T04:00:00Z");
const signature = (jobId = id, signingKey = key) =>
  createHmac("sha256", signingKey).update(jobId).digest("base64url");
function request(body = "requestId=4000048858", patch: Partial<WebhookRequest> = {}) {
  return {
    method: "POST",
    operationId: "hooks.asr.mediaJob.wake",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    params: { mediaJobId: id },
    query: { sig: signature() },
    rawBody: Buffer.from(body),
    ...patch,
    now,
  };
}
function source(options: { key?: string; configured?: () => boolean } = {}) {
  return createAsrWebhookSource({
    key: Object.hasOwn(options, "key") ? options.key : key,
    configured: options.configured ?? (() => true),
    wake: vi.fn(async () => "processed" as const),
  });
}
const invalid = { kind: "error", error: "WEBHOOK_PAYLOAD_INVALID" };
function event(value: WebhookVerification, taskId: string) {
  expect(value).toEqual({
    kind: "event",
    event: {
      eventId: `${id}:${taskId}`,
      eventType: "asr_callback",
      data: { mediaJobId: id, externalJobId: taskId },
    },
  });
}

describe("ASR recording callback: form identifiers and independent HMAC", () => {
  it.each(["0", "4000048858", "9007199254740993", "18446744073709551615"])(
    "projects canonical uint64 %s without Number coercion",
    async (taskId) => event(await source().verify(request(`requestId=${taskId}`)), taskId),
  );

  it("accepts an encoded field name/value and UTF-8 form charset", async () => {
    event(
      await source().verify(
        request("%72equestId=%34%30%30%30%30%34%38%38%35%38", {
          headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
        }),
      ),
      "4000048858",
    );
  });

  it("projects only requestId; callback failure/text/URL never become result facts", async () => {
    const service = source();
    const checked = await service.verify(
      request(
        "requestId=4000048858&code=999&text=fictional-private-transcript" +
          "&audioUrl=https%3A%2F%2Fprivate.invalid%2Fa&message=private-error&resultDetail=%7B%7D",
      ),
    );
    event(checked, "4000048858");
    if (checked.kind !== "event") throw new Error("expected verified identifier");
    expect(service.payload(checked.event)).toBeNull();
    expect(JSON.stringify(checked)).not.toContain("private");
    expect(service.provider).toBe("asr");
    expect(service.mode).toBe("inline");
  });

  it.each(["", "00", "01", "-1", "+1", "1.0", "1e3", "18446744073709551616"])(
    "rejects noncanonical or out-of-range requestId %j",
    async (value) => {
      expect(await source().verify(request(`requestId=${encodeURIComponent(value)}`))).toEqual(
        invalid,
      );
    },
  );

  it("rejects missing, wrong-case, nested, whitespace and oversized decimal IDs", async () => {
    for (const body of [
      "TaskId=4000048858",
      "RequestId=4000048858",
      "data%5BrequestId%5D=4000048858",
      "requestId=+4000048858",
      "requestId=4000048858%0A",
      `requestId=${"9".repeat(100)}`,
    ])
      expect(await source().verify(request(body))).toEqual(invalid);
  });

  it("rejects repeated decoded keys, including unknown fields and plus/space aliases", async () => {
    for (const body of [
      "requestId=1&requestId=1",
      "requestId=1&%72equestId=2",
      "requestId=1&text=a&%74ext=b",
      "requestId=1&x+y=a&x%20y=b",
    ])
      expect(await source().verify(request(body))).toEqual(invalid);
  });

  it("rejects malformed fields and percent UTF-8 even in ignored result fields", async () => {
    for (const body of [
      "",
      "requestId",
      "=1",
      "requestId=1&",
      "requestId=1&&text=a",
      "requestId=1&text=%",
      "requestId=1&text=%GG",
      "requestId=1&%C3%28=a",
      "requestId=1&text=%ED%A0%80",
    ])
      expect(await source().verify(request(body))).toEqual(invalid);
  });

  it("rejects malformed raw UTF-8 instead of replacement-character decoding", async () => {
    expect(
      await source().verify(
        request("", {
          rawBody: Buffer.concat([Buffer.from("requestId=1&text="), Buffer.from([0xc3, 0x28])]),
        }),
      ),
    ).toEqual(invalid);
  });

  it("keeps the existing 1 MiB body ceiling without copying CI's 64 KiB limit", async () => {
    const prefix = "requestId=1&text=";
    event(await source().verify(request(prefix + "a".repeat(70_000))), "1");
    event(await source().verify(request(prefix + "a".repeat(1_048_576 - prefix.length))), "1");
    expect(await source().verify(request(prefix + "a".repeat(1_048_577 - prefix.length)))).toEqual(
      invalid,
    );
  });

  it("rejects JSON, XML, missing type, and unsupported form charset", async () => {
    for (const type of [
      "application/json",
      "application/xml",
      "",
      "application/x-www-form-urlencoded; charset=latin1",
    ])
      expect(
        await source().verify(
          request("requestId=1", {
            headers: { "content-type": type },
          }),
        ),
      ).toEqual(invalid);
    expect(await source().verify(request('{"requestId":"1"}'))).toEqual(invalid);
  });

  it("requires POST and the registered operationId", async () => {
    for (const patch of [
      { method: "GET" },
      { method: "PUT" },
      { operationId: "hooks.ci.mediaJob.wake" },
    ])
      expect(await source().verify(request("requestId=1", patch))).toEqual(invalid);
  });

  it("uses UTF-8 key bytes and enables only the closed 32..256 range", async () => {
    for (const value of [undefined, "", "a".repeat(31), "a".repeat(257), "界".repeat(86)]) {
      const service = source({ key: value });
      expect(service.enabled?.()).toBe(false);
      expect(await service.verify(request())).toEqual({
        kind: "error",
        error: "WEBHOOK_SOURCE_DISABLED",
      });
    }
    for (const value of ["a".repeat(32), "a".repeat(256), "界".repeat(11)]) {
      const service = source({ key: value });
      expect(service.enabled?.()).toBe(true);
      event(
        await service.verify(request("requestId=1", { query: { sig: signature(id, value) } })),
        "1",
      );
    }
  });

  it("rechecks actual ASR configuration, including after source construction", async () => {
    let configured = false;
    const service = source({ configured: () => configured });
    expect(service.enabled?.()).toBe(false);
    expect(await service.verify(request())).toEqual({
      kind: "error",
      error: "WEBHOOK_SOURCE_DISABLED",
    });
    configured = true;
    expect(service.enabled?.()).toBe(true);
    event(await service.verify(request()), "4000048858");
    configured = false;
    expect(service.enabled?.()).toBe(false);
  });

  it("rejects absent/non-UUID paths and missing, padded, or malformed signatures", async () => {
    const paths: Array<WebhookRequest["params"]> = [undefined, {}, { mediaJobId: "not-a-uuid" }];
    for (const params of paths)
      expect(await source().verify(request("requestId=1", { params }))).toEqual({
        kind: "error",
        error: "WEBHOOK_SIGNATURE_INVALID",
      });
    for (const sig of ["", "A".repeat(42), "A".repeat(43), signature() + "=", "+".repeat(43)])
      expect(await source().verify(request("requestId=1", { query: { sig } }))).toEqual({
        kind: "error",
        error: "WEBHOOK_SIGNATURE_INVALID",
      });
    expect(await source().verify(request("requestId=1", { query: undefined }))).toEqual({
      kind: "error",
      error: "WEBHOOK_SIGNATURE_INVALID",
    });
  });

  it("rejects a noncanonical base64url alias with the same decoded digest", async () => {
    const canonical = signature();
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(canonical.at(-1)!);
    const alias = canonical.slice(0, -1) + alphabet[last + 1];
    expect(Buffer.from(alias, "base64url")).toEqual(Buffer.from(canonical, "base64url"));
    expect(await source().verify(request("requestId=1", { query: { sig: alias } }))).toEqual({
      kind: "error",
      error: "WEBHOOK_SIGNATURE_INVALID",
    });
  });

  it("binds the exact local job UUID and independent ASR key, before body parsing", async () => {
    for (const sig of [
      signature(id, "public-fake-ci-key-at-least-32-bytes"),
      signature("019a5430-9000-7000-8000-000000000002"),
    ])
      expect(await source().verify(request("malformed-private-body", { query: { sig } }))).toEqual({
        kind: "error",
        error: "WEBHOOK_SIGNATURE_INVALID",
      });
  });

  it("returns fixed official success ACK and fixed failure ACK for every mapped error", () => {
    const service = source();
    expect(service.reply(true)).toEqual({
      kind: "reply",
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: '{"code":0,"message":"success"}',
    });
    const errors = [
      ["WEBHOOK_PAYLOAD_INVALID", 400],
      ["WEBHOOK_SIGNATURE_INVALID", 401],
      ["WEBHOOK_SOURCE_DISABLED", 404],
      ["RATE_LIMITED", 429],
      ["WEBHOOK_PERSIST_FAILED", 500],
    ] as const;
    for (const [error, status] of errors) {
      const reply = service.reply(false, error, { private: "fictional-private-error", key });
      expect(reply.status).toBe(status);
      expect(reply.body).toBe('{"code":1,"message":"failure"}');
      expect(reply.headers).toEqual({ "Content-Type": "application/json; charset=utf-8" });
    }
  });

  it("cannot restore callback result fields from an inline receipt", async () => {
    await expect(
      source().restore({
        id,
        eventId: `${id}:4000048858`,
        eventType: "asr_callback",
        keyVersion: null,
        payload: { text: "fictional-private-transcript", requestId: "4000048858" },
      }),
    ).rejects.toThrow();
  });
});
