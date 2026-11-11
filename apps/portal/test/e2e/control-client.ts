import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { z } from "@liyoxi/contract";
import { isErrorSymbol } from "@liyoxi/contract/errors";

const scope = z.strictObject({ entityId: z.uuid(), storeId: z.uuid() });
const ContextSchema = z.strictObject({
  runId: z.string().regex(/^[a-f0-9]{12}$/),
  version: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  origin: z.url(),
  controlSocketPath: z.string(),
  stageDirectory: z.string(),
  actors: z.strictObject({ owner: scope, clerk: scope, otherOwner: scope }),
});
export function liveContext() {
  const runId = process.env.LYX_PORTAL_LIVE_RUN_ID;
  if (!runId || !/^[a-f0-9]{12}$/.test(runId)) throw new Error("LIVE_CONTEXT_INVALID");
  const directory = join(realpathSync("/tmp"), `lyx-portal-${runId}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(directory, "context.json"), "utf8"));
  } catch {
    throw new Error("LIVE_CONTEXT_INVALID");
  }
  const parsed = ContextSchema.safeParse(raw);
  if (!parsed.success) throw new Error("LIVE_CONTEXT_INVALID");
  const value = parsed.data;
  const origin = new URL(value.origin);
  if (
    value.runId !== runId ||
    origin.protocol !== "https:" ||
    origin.hostname !== "portal.localhost" ||
    !origin.port ||
    value.origin !== origin.origin ||
    value.controlSocketPath !== join(directory, "control.sock") ||
    value.stageDirectory !== join(directory, "stage")
  )
    throw new Error("LIVE_CONTEXT_INVALID");
  return value;
}

export const Cases = [
  "portal-authorize-revoke",
  "portal-logout",
  "portal-rejected-csrf",
  "preview-ad-playback",
  "preview-ad-stale-channel",
  "preview-cross-store-q9",
  "preview-revoke-media",
  "verify-revisions",
  "verify-lifecycle-reporting",
  "preview-expired-media",
] as const;
export type CaseId = (typeof Cases)[number];
type Actor = "owner" | "clerk" | "otherOwner";
type Input =
  | {
      op:
        | "case.begin"
        | "case.end"
        | "facts.beginRead"
        | "facts.tickets"
        | "preview.prepare"
        | "preview.facts";
      input: Record<string, never>;
    }
  | { op: "ticket.lookup"; input: { actor: Actor; code: string } }
  | {
      op: "ticket.decide";
      input: { actor: Actor; portalTicketId: string; decision: "approve"; pairDigits: string };
    }
  | { op: "session.revoke"; input: { actor: Actor; portalSessionId: string } }
  | { op: "facts.endRead"; input: { windowId: string } }
  | {
      op: "preview.action";
      input: {
        action:
          | "push-ad-version"
          | "queue-license-correction"
          | "complete-license-correction"
          | "void-license"
          | "expire-media-grants"
          | "ad-channel-unavailable"
          | "ad-channel-available";
      };
    };
export const PreviewFacts = z.strictObject({
  playbackAuditCount: z.number().int().nonnegative(),
  ad: z.strictObject({ adId: z.uuid(), versionNo: z.number().int().positive() }),
  license: z.strictObject({
    verifyCode: z.string().min(1).max(64),
    revNo: z.number().int().positive(),
    pendingRevNo: z.number().int().positive().nullable(),
    displayStatus: z.enum(["pending_effective", "effective", "voided", "expired"]),
    expiredVerifyCode: z.string().min(1).max(64),
    unissuedVerifyCode: z.string().min(1).max(64),
  }),
});
const ReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ v: z.literal(1), id: z.uuid(), ok: z.literal(true), result: z.unknown() }),
  z.strictObject({
    v: z.literal(1),
    id: z.uuid().nullable(),
    ok: z.literal(false),
    failure: z.strictObject({
      code: z.enum(["BAD_COMMAND", "WRONG_CASE", "NOT_OWNED", "CONTROL_FAILED"]),
    }),
  }),
]);
const errorSymbol = z.string().refine(isErrorSymbol).nullable();
export const HttpResult = z.strictObject({
  httpStatus: z.number().int().min(100).max(599),
  error: errorSymbol,
  data: z.union([
    z.strictObject({
      portalTicketId: z.uuid(),
      pairChoices: z.array(z.string().regex(/^\d{2}$/)).length(3),
      storeId: z.uuid(),
    }),
    z.strictObject({
      portalTicketId: z.uuid(),
      status: z.enum(["approved", "rejected"]),
      rejectReason: z.enum(["by_owner", "pair_mismatch"]).nullable(),
    }),
    z.strictObject({ portalSessionId: z.uuid(), revokedAt: z.iso.datetime().nullable() }),
    z.null(),
  ]),
});
export const Facts = z.strictObject({
  items: z
    .array(
      z.strictObject({
        portalTicketId: z.uuid(),
        storedStatus: z.enum(["pending", "approved", "rejected", "consumed"]),
        sessionIds: z.array(z.uuid()),
        activeSessionCount: z.number().int().min(0),
      }),
    )
    .max(8),
});
export const ReadWindow = z.strictObject({ windowId: z.uuid() });
export const ReadResult = z.strictObject({
  unchanged: z.boolean(),
  changedTables: z.array(
    z.enum([
      "portal_ticket",
      "portal_session",
      "auth_event",
      "audit_log",
      "outbox_event",
      "status_transition",
      "idempotency_record",
      "ad",
      "ad_version",
      "playable_asset",
      "file_object",
      "file_ref",
      "license_letter",
      "license_letter_revision",
      "timer",
      "delivery_download_log",
    ]),
  ),
});
export const CaseReady = z.strictObject({ ready: z.literal(true) });
export const CaseClosed = z.strictObject({
  closed: z.literal(true),
  abandonedReadWindow: z.boolean(),
});

export function control<T>(caseId: CaseId, command: Input, schema: z.ZodType<T>): Promise<T> {
  const context = liveContext(),
    id = randomUUID();
  const bytes = Buffer.from(`${JSON.stringify({ v: 1, id, caseId, ...command })}\n`);
  if (bytes.length > 8192) throw new Error("CONTROL_REQUEST_INVALID");
  return new Promise((accept, reject) => {
    const socket = connect(context.controlSocketPath);
    let response = Buffer.alloc(0),
      settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("CONTROL_REQUEST_FAILED"));
    };
    socket.setTimeout(10_000, fail);
    socket.once("error", fail);
    socket.once("connect", () => socket.write(bytes));
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      response = Buffer.concat([response, chunk]);
      if (response.length > 8192) {
        fail();
        return;
      }
      const end = response.indexOf(10);
      if (end === -1) return;
      try {
        if (end !== response.length - 1) throw new Error("CONTROL_REPLY_INVALID");
        const raw: unknown = JSON.parse(response.subarray(0, end).toString("utf8"));
        const reply = ReplySchema.safeParse(raw);
        if (!reply.success || !reply.data.ok || reply.data.id !== id) {
          fail();
          return;
        }
        const result = schema.safeParse(reply.data.result);
        if (!result.success) {
          fail();
          return;
        }
        settled = true;
        socket.destroy();
        accept(result.data);
      } catch {
        fail();
      }
    });
    socket.once("end", () => {
      if (!settled) fail();
    });
  });
}
