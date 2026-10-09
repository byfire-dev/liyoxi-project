import { createHmac, timingSafeEqual } from "node:crypto";
import { isUuid } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { WebhookSource, WebhookVerification, WebhookReply } from "./webhooks/types.js";
// A private scalar reader avoids interpreting remote callback results as trusted business facts.
const fail = (): WebhookVerification => ({ kind: "error", error: "WEBHOOK_PAYLOAD_INVALID" });
const reply = (ok: boolean, error?: string): WebhookReply => ({
  kind: "reply",
  status: ok
    ? 200
    : error === "WEBHOOK_SIGNATURE_INVALID"
      ? 401
      : error === "WEBHOOK_PAYLOAD_INVALID"
        ? 400
        : error === "RATE_LIMITED"
          ? 429
          : 500,
  body: "",
});
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function xmlJobId(raw: string): string | null {
  const text = raw.replace(
    /^\s*<\?xml\s+version="1\.0"(?:\s+encoding="(?:UTF-8|utf-8)")?\s*\?>/,
    "",
  );
  if (/<!|<\?|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text)) return null;
  const stack: string[] = [];
  let cursor = 0,
    count = 0,
    id: string | null = null,
    roots = 0;
  for (const match of text.matchAll(/<\/?[A-Za-z][A-Za-z0-9_]*(?:\s*\/)?\s*>/g)) {
    const content = text.slice(cursor, match.index),
      token = match[0],
      name = token.match(/[A-Za-z][A-Za-z0-9_]*/)![0];
    if (content.includes("<") || content.includes(">") || (!stack.length && content.trim()))
      return null;
    if (token.startsWith("</")) {
      if (stack.at(-1) !== name) return null;
      if (stack.join("/") === "Response/JobsDetail/JobId") {
        if (id !== null || !/^[A-Za-z0-9_-]{1,128}$/.test(content)) return null;
        id = content;
      }
      stack.pop();
    } else {
      if (!stack.length && (++roots !== 1 || name !== "Response")) return null;
      if (++count > 10_000 || stack.length >= 32) return null;
      if (!token.endsWith("/>")) stack.push(name);
    }
    cursor = match.index! + token.length;
  }
  return stack.length || text.slice(cursor).trim() ? null : id;
}
function jobId(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) return null;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.trimStart().startsWith("<")) return xmlJobId(text);
  const value: unknown = JSON.parse(text);
  if (!record(value) || !Object.hasOwn(value, "JobsDetail")) return null;
  const details = Array.isArray(value.JobsDetail)
    ? value.JobsDetail.length === 1
      ? value.JobsDetail[0]
      : null
    : value.JobsDetail;
  if (!record(details) || !Object.hasOwn(details, "JobId")) return null;
  const id = details.JobId;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}
export function createCiWebhookSource(options: {
  readonly key?: string;
  readonly wake: (
    tx: Tx,
    input: { mediaJobId: string; externalJobId: string },
  ) => Promise<"processed" | "ignored">;
}): WebhookSource {
  return {
    provider: "ci",
    mode: "inline",
    async verify(input) {
      if (
        !options.key ||
        Buffer.byteLength(options.key) < 32 ||
        Buffer.byteLength(options.key) > 256
      )
        return { kind: "error", error: "WEBHOOK_DECRYPT_FAILED" };
      const id = input.params?.mediaJobId,
        signature = input.query?.sig;
      if (!id || !isUuid(id) || !signature || !/^[A-Za-z0-9_-]{43}$/.test(signature))
        return { kind: "error", error: "WEBHOOK_SIGNATURE_INVALID" };
      const decoded = Buffer.from(signature, "base64url");
      const expected = createHmac("sha256", options.key).update(id).digest();
      if (
        decoded.toString("base64url") !== signature ||
        decoded.length !== expected.length ||
        !timingSafeEqual(decoded, expected)
      )
        return { kind: "error", error: "WEBHOOK_SIGNATURE_INVALID" };
      try {
        const externalJobId = jobId(input.rawBody);
        if (!externalJobId) return fail();
        return {
          kind: "event",
          event: {
            eventId: `${id}:${externalJobId}`,
            eventType: "ci.mediaJob.wake",
            data: { mediaJobId: id, externalJobId },
          },
        };
      } catch {
        return fail();
      }
    },
    payload: () => null,
    async restore() {
      throw new TypeError("CI inline回调不存业务载荷");
    },
    async handle(tx, event) {
      const data = event.data;
      if (
        !record(data) ||
        typeof data.mediaJobId !== "string" ||
        typeof data.externalJobId !== "string"
      )
        throw new TypeError("CI已验事实非法");
      return options.wake(tx, { mediaJobId: data.mediaJobId, externalJobId: data.externalJobId });
    },
    reply,
  };
}
