import { randomBytes, randomInt } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import qrcode from "qrcode";
import type { Config } from "./config.ts";
import { ProbeError } from "./errors.ts";
import { digest, opaque, type Provider } from "./provider.ts";
import { attemptSchema, type Attempt, Redactor } from "./records.ts";
import { desktopHtml } from "./desktop.ts";

type Session = { identity: string; expiresAt: number };
type Ticket = {
  id: string;
  token: string;
  shortCode: string;
  digit: string;
  candidates: string[];
  pollHash: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "confirmed" | "rejected";
  guesses: number;
};
type Upload = { id: string; owner: string; key: string; size: number };
const codeSchema = z.object({ code: z.string().min(1).max(512) }).strict();
export function createProbe(
  config: Config,
  provider: Provider,
  record: (attempt: Attempt) => void,
  redactor = new Redactor(),
  now = Date.now,
) {
  const sessions = new Map<string, Session>();
  const identities = new Map<string, string>();
  const accounts = new Map<string, { id: string; identities: Set<string> }>();
  const tickets = new Map<string, Ticket>();
  const uploads = new Map<string, Upload>();
  const registrations = new Map<string, Upload>();
  const attemptIds = new Set<string>();
  if (config.secrets) redactor.add(...Object.values(config.secrets));
  const app = new Hono<{ Variables: { session: Session } }>();
  app.use(
    "*",
    bodyLimit({ maxSize: 8192, onError: (c) => c.json({ error: "BODY_TOO_LARGE" }, 400) }),
  );
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.onError((error, c) =>
    c.json(
      { error: error instanceof ProbeError ? error.message : "INVALID_REQUEST" },
      error instanceof ProbeError ? error.status : 400,
    ),
  );
  app.get("/api/probe/health", (c) => c.json({ mode: config.mode }));
  app.get("/desktop", (c) => c.html(desktopHtml));
  app.get("/a", (c) => c.text("请用 X-01 探针小程序的扫码按钮扫描电脑二维码，或手输 8 位短码。"));
  app.post("/api/probe/login", async (c) => {
    const { code } = codeSchema.parse(await c.req.json());
    const result = await provider.login(code);
    redactor.add(code, result.openid, result.sessionKey);
    const identity = digest(result.openid);
    const token = opaque(32);
    sessions.set(digest(token), { identity, expiresAt: now() + 86_400_000 });
    return c.json({
      sessionToken: token,
      identityTag: identity.slice(0, 12),
      accountId: identities.get(identity) ?? null,
    });
  });
  app.post("/api/probe/scan/tickets", async (c) => {
    if (c.req.header("X-Probe-Desktop") !== "1") throw new ProbeError("DESKTOP_REQUIRED", 403);
    for (const [id, ticket] of tickets) if (ticket.expiresAt <= now()) tickets.delete(id);
    if (tickets.size >= 100) throw new ProbeError("TICKET_LIMIT", 429);
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let shortCode: string;
    do {
      shortCode = Array.from({ length: 8 }, () => alphabet[randomInt(32)]).join("");
    } while ([...tickets.values()].some((ticket) => ticket.shortCode === shortCode));
    const digit = String(randomInt(100)).padStart(2, "0");
    const options = new Set([digit]);
    while (options.size < 3) options.add(String(randomInt(100)).padStart(2, "0"));
    const candidates = [...options];
    for (let index = candidates.length - 1; index > 0; index--) {
      const target = randomInt(index + 1);
      [candidates[index], candidates[target]] = [candidates[target]!, candidates[index]!];
    }
    const token = opaque();
    const pollSecret = opaque(32);
    const id = opaque();
    const ticket: Ticket = {
      id,
      token,
      shortCode,
      digit,
      candidates,
      pollHash: digest(pollSecret),
      createdAt: now(),
      expiresAt: now() + 120_000,
      status: "pending",
      guesses: 0,
    };
    tickets.set(id, ticket);
    const qrUrl = `${config.portalOrigin}/a?t=${token}`;
    return c.json({
      ticketId: id,
      qrUrl,
      qrDataUrl: await qrcode.toDataURL(qrUrl, { width: 480, margin: 2 }),
      shortCode,
      pairDigits: digit,
      pollSecret,
      expiresAt: new Date(ticket.expiresAt).toISOString(),
      pollIntervalMs: 2000,
    });
  });
  app.get("/api/probe/scan/tickets/:id", (c) => {
    const ticket = tickets.get(c.req.param("id"));
    if (!ticket || ticket.pollHash !== digest(c.req.header("X-Poll-Secret") ?? ""))
      throw new ProbeError("TICKET_NOT_FOUND", 404);
    return c.json({
      status: ticket.expiresAt <= now() ? "expired" : ticket.status,
      elapsedMs: now() - ticket.createdAt,
    });
  });
  app.use("/api/probe/*", async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const session = sessions.get(digest(header.startsWith("Bearer ") ? header.slice(7) : ""));
    if (!session || session.expiresAt <= now()) throw new ProbeError("AUTH_REQUIRED", 401);
    c.set("session", session);
    await next();
  });
  app.post("/api/probe/phone", async (c) => {
    const { code, kind } = codeSchema
      .extend({ kind: z.enum(["quick", "realtime"]) })
      .parse(await c.req.json());
    redactor.add(code);
    const phone = await provider.phone(code);
    redactor.add(phone);
    const identity = c.get("session").identity;
    const phoneKey = digest(phone);
    const oldAccount = identities.get(identity);
    let account = accounts.get(phoneKey);
    if (
      kind === "quick" &&
      ((account && !account.identities.has(identity)) || (oldAccount && oldAccount !== account?.id))
    )
      throw new ProbeError("REALTIME_REQUIRED", 409);
    account ??= { id: opaque(), identities: new Set() };
    for (const previous of accounts.values()) previous.identities.delete(identity);
    account.identities.add(identity);
    accounts.set(phoneKey, account);
    identities.set(identity, account.id);
    return c.json({
      accountId: account.id,
      phoneMasked: `${phone.slice(0, 3)}****${phone.slice(-4)}`,
      linkedWechatCount: account.identities.size,
    });
  });
  app.get("/api/probe/scan/lookup", (c) => {
    const token = c.req.query("token");
    const shortCode = c.req.query("shortCode")?.replace(/-/g, "").toUpperCase();
    if (
      !!token === !!shortCode ||
      (token && !/^[\w-]{22}$/.test(token)) ||
      (shortCode && !/^[0-9A-HJKMNP-TV-Z]{8}$/.test(shortCode))
    )
      throw new ProbeError("LOOKUP_INVALID");
    const ticket = [...tickets.values()].find((entry) =>
      token ? entry.token === token : entry.shortCode === shortCode,
    );
    if (!ticket) throw new ProbeError("TICKET_NOT_FOUND", 404);
    if (ticket.expiresAt <= now()) throw new ProbeError("TICKET_EXPIRED", 410);
    if (ticket.status !== "pending") throw new ProbeError("TICKET_CLOSED", 409);
    return c.json({
      ticketId: ticket.id,
      candidates: ticket.candidates,
      expiresAt: new Date(ticket.expiresAt).toISOString(),
    });
  });
  app.post("/api/probe/scan/confirm", async (c) => {
    const body = z
      .object({ ticketId: z.string(), digit: z.string().regex(/^\d{2}$/) })
      .strict()
      .parse(await c.req.json());
    if (!identities.has(c.get("session").identity)) throw new ProbeError("PHONE_REQUIRED", 403);
    const ticket = tickets.get(body.ticketId);
    if (!ticket) throw new ProbeError("TICKET_NOT_FOUND", 404);
    if (ticket.expiresAt <= now()) throw new ProbeError("TICKET_EXPIRED", 410);
    if (ticket.status !== "pending") throw new ProbeError("TICKET_CLOSED", 409);
    if (ticket.digit !== body.digit) {
      ticket.guesses++;
      if (ticket.guesses >= 3) ticket.status = "rejected";
      throw new ProbeError("PAIR_MISMATCH", 403);
    }
    ticket.status = "confirmed";
    return c.json({ status: "confirmed" });
  });
  app.post("/api/probe/uploads", async (c) => {
    const { clientToken, size } = z
      .object({
        clientToken: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
        size: z.number().int().min(1).max(500_000_000),
      })
      .strict()
      .parse(await c.req.json());
    const owner = c.get("session").identity;
    const registrationKey = `${owner}:${clientToken}`;
    let upload = registrations.get(registrationKey);
    if (upload && upload.size !== size) throw new ProbeError("CLIENT_TOKEN_CONFLICT", 409);
    if (!upload) {
      const id = randomBytes(16).toString("hex");
      upload = { id, owner, key: `incoming/${id}/source.mp4`, size };
      uploads.set(id, upload);
      registrations.set(registrationKey, upload);
      if (config.mode === "fake") provider.prepareFakeUpload?.(upload.key, size);
    }
    return c.json({ fileId: upload.id, key: upload.key });
  });
  function owned(id: string, owner: string) {
    const upload = uploads.get(id);
    if (!upload || upload.owner !== owner) throw new ProbeError("UPLOAD_NOT_FOUND", 404);
    return upload;
  }
  app.post("/api/probe/uploads/:id/credentials", async (c) => {
    const upload = owned(c.req.param("id"), c.get("session").identity);
    const credentials = await provider.credentials(upload.key);
    redactor.add(credentials.TmpSecretId, credentials.TmpSecretKey, credentials.SecurityToken);
    return c.json(credentials);
  });
  app.post("/api/probe/uploads/:id/confirm", async (c) => {
    const upload = owned(c.req.param("id"), c.get("session").identity);
    const { size } = z
      .object({ size: z.number().int() })
      .strict()
      .parse(await c.req.json());
    const actual = await provider.objectSize(upload.key);
    if (actual !== upload.size || size !== upload.size) throw new ProbeError("SIZE_MISMATCH", 409);
    return c.json({ verified: true, size: actual });
  });
  app.get("/api/probe/downloads/:size", async (c) => {
    const sizeMb = Number(c.req.param("size"));
    const mode = c.req.query("mode") ?? "temp";
    if (![30, 50, 60, 100, 150, 200].includes(sizeMb) || !["temp", "user_dir"].includes(mode))
      throw new ProbeError("DOWNLOAD_INVALID");
    const file = await provider.download(sizeMb);
    if (file.size !== sizeMb * 1_000_000 || file.size > 200_000_000)
      throw new ProbeError("FIXTURE_SIZE_MISMATCH", 409);
    redactor.add(file.url);
    return c.json({
      ...file,
      expiresAt: new Date(now() + 900_000).toISOString(),
      timeoutMs: Math.min(900_000, Math.max(120_000, Math.ceil(file.size / 100_000) * 1000)),
    });
  });
  app.post("/api/probe/attempts", async (c) => {
    const attempt = attemptSchema.parse(await c.req.json());
    const id = attempt.attemptId ? `${c.get("session").identity}:${attempt.attemptId}` : undefined;
    if (!id || !attemptIds.has(id)) {
      record(redactor.row(attempt));
      if (id) attemptIds.add(id);
    }
    return c.json({ recorded: true });
  });
  return app;
}
