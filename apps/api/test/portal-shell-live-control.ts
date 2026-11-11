import { randomUUID } from "node:crypto";
import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { IdSchema } from "@liyoxi/contract";
import type { PortalLiveFixture } from "@liyoxi/services/testing";
import { z } from "zod";
import type { PortalLiveMerchant } from "./portal-shell-live-merchant.js";

const actor = z.enum(["owner", "clerk", "otherOwner"]);
const empty = z.strictObject({});
const base = { v: z.literal(1), id: z.uuid(), caseId: z.string().regex(/^[a-z0-9-]{1,48}$/) };
export const PortalControlCommandSchema = z.discriminatedUnion("op", [
  z.strictObject({ ...base, op: z.literal("case.begin"), input: empty }),
  z.strictObject({
    ...base,
    op: z.literal("ticket.lookup"),
    input: z.strictObject({
      actor,
      code: z.string().regex(/^(?:[0-9A-HJKMNP-TV-Z]{8}|[A-Za-z0-9_-]{22})$/),
    }),
  }),
  z.strictObject({
    ...base,
    op: z.literal("ticket.decide"),
    input: z.discriminatedUnion("decision", [
      z.strictObject({
        actor,
        portalTicketId: IdSchema,
        decision: z.literal("approve"),
        pairDigits: z.string().regex(/^\d{2}$/),
      }),
      z.strictObject({ actor, portalTicketId: IdSchema, decision: z.literal("reject") }),
    ]),
  }),
  z.strictObject({
    ...base,
    op: z.literal("session.revoke"),
    input: z.strictObject({ actor, portalSessionId: IdSchema }),
  }),
  z.strictObject({ ...base, op: z.literal("facts.tickets"), input: empty }),
  z.strictObject({ ...base, op: z.literal("preview.prepare"), input: empty }),
  z.strictObject({ ...base, op: z.literal("preview.facts"), input: empty }),
  z.strictObject({
    ...base,
    op: z.literal("preview.action"),
    input: z.strictObject({
      action: z.enum([
        "push-ad-version",
        "queue-license-correction",
        "complete-license-correction",
        "void-license",
        "expire-media-grants",
        "ad-channel-unavailable",
        "ad-channel-available",
      ]),
    }),
  }),
  z.strictObject({ ...base, op: z.literal("facts.beginRead"), input: empty }),
  z.strictObject({
    ...base,
    op: z.literal("facts.endRead"),
    input: z.strictObject({ windowId: z.uuid() }),
  }),
  z.strictObject({ ...base, op: z.literal("case.end"), input: empty }),
]);
type Command = z.infer<typeof PortalControlCommandSchema>;
type Failure = "BAD_COMMAND" | "WRONG_CASE" | "NOT_OWNED" | "CONTROL_FAILED";
export type PortalControlReply =
  | { v: 1; id: string | null; ok: false; failure: { code: Failure } }
  | { v: 1; id: string; ok: true; result: unknown };
const failure = (id: string | null, code: Failure): PortalControlReply => ({
  v: 1,
  id,
  ok: false,
  failure: { code },
});

// Project the producer's public facts explicitly; IDs, URLs and credentials outside this
// allowlist can never enter the control reply, even if the fixture gains new fields.
const previewFacts = z.object({
  playbackAuditCount: z.number().int().nonnegative(),
  ad: z.object({ adId: IdSchema, versionNo: z.number().int().positive() }),
  license: z.object({
    verifyCode: z.string().min(1).max(64),
    revNo: z.number().int().positive(),
    pendingRevNo: z.number().int().positive().nullable(),
    displayStatus: z.enum(["pending_effective", "effective", "voided", "expired"]),
    expiredVerifyCode: z.string().min(1).max(64),
    unissuedVerifyCode: z.string().min(1).max(64),
  }),
});

/** Serial commands retain only public ticket IDs and stable intent keys. */
export function createPortalLiveControl(
  fixture: Pick<
    PortalLiveFixture,
    | "ticketFacts"
    | "beginReadWindow"
    | "endReadWindow"
    | "discardReadWindow"
    | "preparePreview"
    | "previewAction"
    | "previewFacts"
  >,
  merchant: Pick<
    PortalLiveMerchant,
    "lookup" | "decide" | "revoke" | "actorForUser" | "previewScopes"
  >,
) {
  let caseId: string | undefined,
    readWindow: string | undefined,
    closed = false;
  const tickets = new Set<string>();
  const intents = new Map<string, { input: string; key: string }>();
  let tail: Promise<unknown> = Promise.resolve();
  function intent(id: string, input: string) {
    const existing = intents.get(id);
    if (existing) {
      if (existing.input !== input) return;
      return existing.key;
    }
    if (intents.size >= 128) return;
    const key = randomUUID();
    intents.set(id, { input, key });
    return key;
  }
  async function execute(command: Command): Promise<PortalControlReply> {
    const { id, op } = command;
    if (closed) return failure(id, "CONTROL_FAILED");
    if (op === "case.begin") {
      if (caseId !== undefined) return failure(id, "WRONG_CASE");
      caseId = command.caseId;
      return { v: 1, id, ok: true, result: { ready: true } };
    }
    if (caseId !== command.caseId) return failure(id, "WRONG_CASE");
    if (
      readWindow &&
      (op === "ticket.decide" ||
        op === "session.revoke" ||
        op === "preview.prepare" ||
        op === "preview.action")
    )
      return failure(id, "BAD_COMMAND");
    try {
      let result: unknown;
      if (op === "ticket.lookup") {
        if (tickets.size >= 8) return failure(id, "BAD_COMMAND");
        const reply = await merchant.lookup(command.input.actor, command.input.code);
        if (reply.error !== null) result = reply;
        else {
          tickets.add(reply.data.portalTicketId);
          result = {
            httpStatus: reply.httpStatus,
            error: null,
            data: {
              portalTicketId: reply.data.portalTicketId,
              pairChoices: reply.data.pairChoices,
              storeId: reply.data.storeId,
            },
          };
        }
      } else if (op === "ticket.decide") {
        if (!tickets.has(command.input.portalTicketId)) return failure(id, "NOT_OWNED");
        const key = intent(id, JSON.stringify(command));
        if (!key) return failure(id, "BAD_COMMAND");
        const reply = await merchant.decide(
          command.input.actor,
          command.input.portalTicketId,
          key,
          command.input,
        );
        result =
          reply.error !== null
            ? reply
            : {
                httpStatus: reply.httpStatus,
                error: null,
                data: {
                  portalTicketId: reply.data.portalTicketId,
                  status: reply.data.status,
                  rejectReason: reply.data.rejectReason,
                },
              };
      } else if (op === "session.revoke") {
        const facts = await fixture.ticketFacts([...tickets]);
        if (
          !facts.some((ticket) =>
            ticket.sessions.some(
              (session) => session.portalSessionId === command.input.portalSessionId,
            ),
          )
        )
          return failure(id, "NOT_OWNED");
        const key = intent(id, JSON.stringify(command));
        if (!key) return failure(id, "BAD_COMMAND");
        const reply = await merchant.revoke(
          command.input.actor,
          command.input.portalSessionId,
          key,
        );
        result =
          reply.error !== null
            ? reply
            : {
                httpStatus: reply.httpStatus,
                error: null,
                data: {
                  portalSessionId: reply.data.portalSessionId,
                  revokedAt: reply.data.revokedAt,
                },
              };
      } else if (op === "preview.prepare") {
        result = previewFacts.parse(await fixture.preparePreview(merchant.previewScopes()));
      } else if (op === "preview.action") {
        result = previewFacts.parse(await fixture.previewAction(command.input.action));
      } else if (op === "preview.facts") {
        result = previewFacts.parse(await fixture.previewFacts());
      } else if (op === "facts.tickets") {
        result = {
          items: (await fixture.ticketFacts([...tickets])).map((ticket) => ({
            portalTicketId: ticket.portalTicketId,
            storedStatus: ticket.storedStatus,
            sessionIds: ticket.sessions.map((session) => session.portalSessionId),
            activeSessionCount: ticket.sessions.filter((session) => !session.revoked).length,
          })),
        };
      } else if (op === "facts.beginRead") {
        if (readWindow) return failure(id, "BAD_COMMAND");
        readWindow = await fixture.beginReadWindow();
        result = { windowId: readWindow };
      } else if (op === "facts.endRead") {
        if (readWindow !== command.input.windowId) return failure(id, "BAD_COMMAND");
        try {
          result = await fixture.endReadWindow(readWindow);
        } finally {
          readWindow = undefined;
        }
      } else {
        const abandonedReadWindow = fixture.discardReadWindow();
        readWindow = undefined;
        const facts = await fixture.ticketFacts([...tickets]);
        for (const ticket of facts)
          for (const session of ticket.sessions) {
            if (session.revoked) continue;
            const authorizer = merchant.actorForUser(session.approvedByUserId);
            const key = intent(`cleanup:${session.portalSessionId}`, session.portalSessionId);
            if (!authorizer || !key) throw new Error("CLEANUP_IDENTITY_MISSING");
            const reply = await merchant.revoke(authorizer, session.portalSessionId, key);
            if (reply.error !== null || reply.data.revokedAt === null)
              throw new Error("CLEANUP_REVOKE_FAILED");
          }
        tickets.clear();
        intents.clear();
        caseId = undefined;
        result = { closed: true, abandonedReadWindow };
      }
      return { v: 1, id, ok: true, result };
    } catch {
      return failure(id, "CONTROL_FAILED");
    }
  }
  return {
    dispatch(raw: unknown): Promise<PortalControlReply> {
      const parsed = PortalControlCommandSchema.safeParse(raw);
      if (!parsed.success) return Promise.resolve(failure(null, "BAD_COMMAND"));
      const work = tail.then(() => execute(parsed.data));
      tail = work.catch(() => undefined);
      return work;
    },
    async close() {
      closed = true;
      await tail;
      fixture.discardReadWindow();
      tickets.clear();
      intents.clear();
      caseId = undefined;
      readWindow = undefined;
    },
  };
}

export async function assertPortalControlPath(runId: string, path: string) {
  if (!/^[a-f0-9]{12}$/.test(runId)) throw new Error("INVALID_CONTROL_PATH");
  const root = await realpath("/tmp"),
    directory = join(root, `lyx-portal-${runId}`);
  if (path !== join(directory, "control.sock")) throw new Error("INVALID_CONTROL_PATH");
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    (await realpath(dirname(path))) !== directory
  )
    throw new Error("INVALID_CONTROL_PATH");
  let missing = false;
  let unreadable = false;
  try {
    await lstat(path);
  } catch (error) {
    missing =
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    unreadable = !missing;
  }
  if (missing) return;
  if (unreadable) throw new Error("INVALID_CONTROL_PATH");
  throw new Error("CONTROL_PATH_EXISTS");
}

/** One line per socket; neither malformed input nor exceptions are echoed. */
export async function startPortalControlSocket(
  runId: string,
  path: string,
  control: ReturnType<typeof createPortalLiveControl>,
) {
  await assertPortalControlPath(runId, path);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(10_000, () => socket.destroy());
    let bytes = Buffer.alloc(0),
      submitted = false;
    const reply = (value: PortalControlReply) => {
      const line = `${JSON.stringify(value)}\n`;
      socket.end(
        Buffer.byteLength(line) <= 8192
          ? line
          : `${JSON.stringify(failure(null, "CONTROL_FAILED"))}\n`,
      );
    };
    socket.on("data", (chunk: Buffer) => {
      if (submitted) return;
      if (bytes.byteLength + chunk.byteLength > 8192) {
        submitted = true;
        reply(failure(null, "BAD_COMMAND"));
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      const newline = bytes.indexOf(10);
      if (newline === -1) return;
      submitted = true;
      if (newline !== bytes.length - 1) {
        reply(failure(null, "BAD_COMMAND"));
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(bytes.subarray(0, newline).toString("utf8")) as unknown;
      } catch {
        reply(failure(null, "BAD_COMMAND"));
        return;
      }
      bytes = Buffer.alloc(0);
      void control.dispatch(raw).then(reply, () => reply(failure(null, "CONTROL_FAILED")));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let identity: Awaited<ReturnType<typeof lstat>>;
  try {
    identity = await lstat(path);
    await chmod(path, 0o600);
  } catch {
    for (const connection of sockets) connection.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("CONTROL_SOCKET_FAILED");
  }
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        let failed = false;
        try {
          await control.close();
        } catch {
          failed = true;
        }
        for (const socket of sockets) socket.destroy();
        try {
          await stopped;
        } catch {
          failed = true;
        }
        try {
          const current = await lstat(path);
          if (current.ino !== identity.ino || current.dev !== identity.dev || !current.isSocket())
            throw new Error("CONTROL_OWNERSHIP_CHANGED");
          await unlink(path);
        } catch (error) {
          if (!(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          ))
            failed = true;
        }
        if (failed) throw new Error("CONTROL_CLOSE_FAILED");
      })()),
  };
}
