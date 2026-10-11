import { createHmac, timingSafeEqual } from "node:crypto";
import { isUuid } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { WebhookSource, WebhookReply, WebhookVerification } from "./webhooks/types.js";

const invalid = (): WebhookVerification => ({ kind: "error", error: "WEBHOOK_PAYLOAD_INVALID" });
const uint64 = (value: string) =>
  /^(0|[1-9][0-9]{0,19})$/.test(value) && (value.length < 20 || value <= "18446744073709551615");

/** Tencent recording callbacks are forms, not the cloud API's JSON response. */
function taskId(bytes: Uint8Array, contentType: string): string | null {
  if (
    !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(contentType.trim()) ||
    !bytes.byteLength ||
    bytes.byteLength > 1_048_576
  )
    return null;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const keys = new Set<string>();
  let id: string | null = null;
  const decode = (value: string) => decodeURIComponent(value.replace(/\+/g, " "));
  for (const field of text.split("&")) {
    const separator = field.indexOf("=");
    if (separator < 1) return null;
    const key = decode(field.slice(0, separator));
    const value = decode(field.slice(separator + 1));
    if (!key || keys.has(key)) return null;
    keys.add(key);
    if (key === "requestId") {
      if (!uint64(value)) return null;
      id = value;
    }
  }
  return id;
}

export function createAsrWebhookSource(options: {
  readonly key?: string;
  readonly configured: () => boolean;
  readonly wake: (
    tx: Tx,
    input: {
      mediaJobId: string;
      externalJobId: string;
    },
  ) => Promise<"processed" | "ignored">;
}): WebhookSource {
  const enabled = () =>
    !!options.key &&
    Buffer.byteLength(options.key) >= 32 &&
    Buffer.byteLength(options.key) <= 256 &&
    options.configured();
  const reply = (ok: boolean, error?: string): WebhookReply => ({
    kind: "reply",
    status: ok
      ? 200
      : error === "WEBHOOK_SOURCE_DISABLED"
        ? 404
        : error === "WEBHOOK_SIGNATURE_INVALID"
          ? 401
          : error === "WEBHOOK_PAYLOAD_INVALID"
            ? 400
            : error === "RATE_LIMITED"
              ? 429
              : 500,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ code: ok ? 0 : 1, message: ok ? "success" : "failure" }),
  });
  return {
    provider: "asr",
    mode: "inline",
    enabled,
    async verify(input) {
      if (!enabled()) return { kind: "error", error: "WEBHOOK_SOURCE_DISABLED" };
      const id = input.params?.mediaJobId,
        signature = input.query?.sig;
      if (!id || !isUuid(id) || !signature || !/^[A-Za-z0-9_-]{43}$/.test(signature))
        return { kind: "error", error: "WEBHOOK_SIGNATURE_INVALID" };
      const decoded = Buffer.from(signature, "base64url");
      const expected = createHmac("sha256", options.key!).update(id).digest();
      if (
        decoded.toString("base64url") !== signature ||
        decoded.length !== expected.length ||
        !timingSafeEqual(decoded, expected)
      )
        return { kind: "error", error: "WEBHOOK_SIGNATURE_INVALID" };
      if (input.method !== "POST" || input.operationId !== "hooks.asr.mediaJob.wake")
        return invalid();
      try {
        const externalJobId = taskId(input.rawBody, input.headers["content-type"] ?? "");
        return externalJobId === null
          ? invalid()
          : {
              kind: "event",
              event: {
                eventId: `${id}:${externalJobId}`,
                eventType: "asr_callback",
                data: { mediaJobId: id, externalJobId },
              },
            };
      } catch {
        return invalid();
      }
    },
    payload: () => null,
    async restore() {
      throw new TypeError("ASR inline callback has no stored result payload");
    },
    async handle(tx, event) {
      const data = event.data;
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        !("mediaJobId" in data) ||
        !("externalJobId" in data) ||
        typeof data.mediaJobId !== "string" ||
        typeof data.externalJobId !== "string"
      )
        throw new TypeError("Invalid verified ASR identifier");
      return options.wake(tx, { mediaJobId: data.mediaJobId, externalJobId: data.externalJobId });
    },
    reply,
  };
}
