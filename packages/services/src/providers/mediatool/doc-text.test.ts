import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMediaToolClient } from "./client.js";

// These are hostile UNIX protocol peers, not evidence that a real document was parsed.
// Real bytes and the isolated parser are exercised by verify/cases/08-doc-text.test.mjs.
type Reply = { status?: number; json: unknown } | { raw: string } | "hang" | "drop";
type Request = { method: string; path: string; body: unknown; id: string };
const owned: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((close) => close()));
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const value = { text: "虚构文档😀", truncated: false, charCount: 5 };
const input = { path: "job/source.txt", ext: "txt" as const, maxChars: 100 };
async function fixture(responseTimeoutMs = 2000) {
  const root = await mkdtemp("/tmp/lyx-doc-text-"),
    socketPath = join(root, "tool.sock");
  const instance = randomUUID(),
    entered = deferred(),
    cancelled = deferred();
  const seen: Request[] = [];
  let response: Reply = { json: { ok: true, ...value } },
    holdCancel = false;
  let acknowledge: () => void = () => undefined;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (req.url === "/cancel") {
        const credential = body as { requestId: string; instanceId: string };
        seen.push({ method: req.method!, path: req.url, body, id: credential.requestId });
        expect(credential.instanceId).toBe(instance);
        acknowledge = () => res.end(JSON.stringify({ ok: true, ...credential, done: true }));
        cancelled.resolve();
        if (!holdCancel) acknowledge();
        return;
      }
      const id = String(req.headers["x-lyx-call-id"]);
      seen.push({ method: req.method!, path: req.url!, body, id });
      res.writeInformation(102, { "x-lyx-call-id": id, "x-lyx-instance": instance });
      entered.resolve();
      if (response === "hang") return;
      if (response === "drop") {
        res.writeHead(200, { "content-type": "application/json", "content-length": 100 });
        res.write('{"ok', () => res.socket?.destroy());
        return;
      }
      res.writeHead("status" in response ? (response.status ?? 200) : 200, {
        "content-type": "application/json",
        "x-lyx-call-id": id,
        "x-lyx-instance": instance,
        "x-lyx-complete": "1",
      });
      res.end("raw" in response ? response.raw : JSON.stringify(response.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  owned.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return {
    seen,
    entered,
    cancelled,
    root,
    client: createMediaToolClient({ workDir: root, socketPath, responseTimeoutMs }),
    reply: (next: Reply) => {
      response = next;
    },
    holdCancel: () => {
      holdCancel = true;
    },
    acknowledge: () => acknowledge(),
  };
}

describe("docText client: bounded and untrusted UNIX responses", () => {
  it.each(["txt", "docx", "pdf"] as const)(
    "sends %s parameters and receives plain text only",
    async (ext) => {
      const f = await fixture(),
        expected = { ...value, ...(ext === "pdf" ? { pageCount: 2 } : {}) };
      f.reply({ json: { ok: true, ...expected } });
      expect(await f.client.docText!({ ...input, ext, timeoutMs: 1000 })).toEqual({
        ok: true,
        value: expected,
      });
      expect(f.seen).toEqual([
        {
          method: "POST",
          path: "/docText",
          id: expect.any(String),
          body: { ...input, ext, timeoutMs: 1000 },
        },
      ]);
    },
  );

  it("counts Unicode codepoints, preserving a whole supplementary character at the limit", async () => {
    const f = await fixture();
    f.reply({ json: { ok: true, text: "😀中", truncated: true, charCount: 6 } });
    expect(await f.client.docText!({ ...input, maxChars: 2 })).toEqual({
      ok: true,
      value: { text: "😀中", truncated: true, charCount: 6 },
    });
  });

  it("accepts the maximum complete character count without a false truncation flag", async () => {
    const f = await fixture(),
      text = "😀".repeat(250000);
    f.reply({ json: { ok: true, text, truncated: false, charCount: 250000 } });
    const result = await f.client.docText!({ ...input, maxChars: 250000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ text, truncated: false, charCount: 250000 });
  });

  it.each([
    null,
    [],
    { ok: true },
    { ok: "true", ...value },
    { ok: true, ...value, text: null },
    { ok: true, ...value, text: 1 },
    { ok: true, ...value, truncated: "false" },
    { ok: true, ...value, truncated: null },
    { ok: true, ...value, charCount: "5" },
    { ok: true, ...value, charCount: null },
    { ok: true, ...value, charCount: -1 },
    { ok: true, ...value, charCount: 1.5 },
    { ok: true, ...value, charCount: 250001 },
    { ok: true, ...value, charCount: 4 },
    { ok: true, ...value, charCount: 6 },
    { ok: true, ...value, truncated: true },
    { ok: true, text: "", truncated: false, charCount: 0 },
    { ok: true, ...value, contentHtml: "<p>unexpected</p>" },
    { ok: true, text: "x".repeat(250001), truncated: false, charCount: 250001 },
  ])("rejects malformed or internally inconsistent success %#", async (json) => {
    const f = await fixture();
    f.reply({ json });
    expect(await f.client.docText!(input)).toMatchObject({ ok: false, reason: "rejected" });
  });

  it.each([
    { text: "😀中A", truncated: true, charCount: 6 },
    { text: "😀", truncated: true, charCount: 6 },
    { text: "😀中", truncated: false, charCount: 6 },
    { text: "😀中", truncated: true, charCount: 2 },
  ])("rejects a response inconsistent with the requested maxChars %#", async (result) => {
    const f = await fixture();
    f.reply({ json: { ok: true, ...result } });
    expect(await f.client.docText!({ ...input, maxChars: 2 })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
  });

  it.each([0, 101, 1.5, "1", null])(
    "rejects invalid actual PDF pageCount %s",
    async (pageCount) => {
      const f = await fixture();
      f.reply({ json: { ok: true, ...value, pageCount } });
      expect(await f.client.docText!({ ...input, ext: "pdf" })).toMatchObject({
        ok: false,
        reason: "rejected",
      });
    },
  );

  it("requires actual PDF pages and refuses fabricated TXT/DOCX pages", async () => {
    const f = await fixture();
    expect(await f.client.docText!({ ...input, ext: "pdf" })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    f.reply({ json: { ok: true, ...value, pageCount: 1 } });
    for (const ext of ["txt", "docx"] as const)
      expect(await f.client.docText!({ ...input, ext })).toMatchObject({
        ok: false,
        reason: "rejected",
      });
  });

  it.each(["<html>bad gateway</html>", "", "null", "[1]", " ".repeat(4 * 1024 * 1024 + 1)])(
    "rejects invalid JSON and oversized transport bytes %#",
    async (raw) => {
      const f = await fixture();
      f.reply({ raw });
      expect(await f.client.docText!(input)).toMatchObject({ ok: false, reason: "rejected" });
    },
  );

  it.each([
    [503, "busy", "unavailable"],
    [504, "timeout", "unavailable"],
    [503, "killed", "unavailable"],
    [500, "internal", "unavailable"],
    [422, "invalid_document", "rejected"],
    [422, "unsupported_document", "rejected"],
    [413, "too_large", "rejected"],
    [400, "bad_path", "rejected"],
  ] as const)("maps HTTP %s/%s to %s", async (status, code, reason) => {
    const f = await fixture();
    f.reply({ status, json: { ok: false, error: { code, message: "controlled failure" } } });
    expect(await f.client.docText!(input)).toMatchObject({ ok: false, reason });
  });

  it("returns unavailable for absent sockets, broken responses and a bounded silent peer", async () => {
    const f = await fixture(40);
    const missing = createMediaToolClient({
      socketPath: join(f.root, "missing.sock"),
      workDir: f.root,
    });
    expect(await missing.docText!(input)).toMatchObject({ ok: false, reason: "unavailable" });
    f.reply("drop");
    expect(await f.client.docText!(input)).toMatchObject({ ok: false, reason: "unavailable" });
    f.reply("hang");
    expect(await f.client.docText!(input)).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("docText client: admission and cancellation", () => {
  it.each([
    { path: "../etc/passwd" },
    { path: "/etc/passwd" },
    { path: "job/../source.txt" },
    { path: "job/.hidden" },
    { path: "source.txt" },
    { path: "job//source.txt" },
    { path: "job\\source.txt" },
    { path: "job/%2e%2e/source.txt" },
    { path: "" },
    { ext: "xlsx" },
    { ext: "PDF" },
    { ext: "doc" },
    { ext: null },
    { maxChars: 0 },
    { maxChars: -1 },
    { maxChars: 250001 },
    { maxChars: 1.5 },
    { maxChars: "100" },
    { maxChars: null },
    { maxChars: Number.NaN },
    { timeoutMs: 0 },
    { timeoutMs: 999 },
    { timeoutMs: 1.5 },
    { timeoutMs: null },
  ])("rejects invalid parameters before opening a socket %#", async (over) => {
    const f = await fixture();
    expect(await f.client.docText!({ ...input, ...over } as never)).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(f.seen).toEqual([]);
  });

  it("does no socket I/O for pre-aborted work", async () => {
    const f = await fixture(),
      controller = new AbortController();
    controller.abort();
    expect(await f.client.docText!({ ...input, signal: controller.signal })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(f.seen).toEqual([]);
  });

  it("clamps an excessive timeout to the parser's 10-second hard limit", async () => {
    const f = await fixture();
    expect(await f.client.docText!({ ...input, timeoutMs: Number.MAX_SAFE_INTEGER })).toMatchObject(
      { ok: true },
    );
    expect(f.seen[0]!.body).toEqual({ ...input, timeoutMs: 10000 });
  });

  it("waits for this operation's cancellation ACK and sends no second docText request", async () => {
    const f = await fixture(),
      controller = new AbortController();
    f.reply("hang");
    f.holdCancel();
    let settled = false;
    const result = f.client.docText!({ ...input, signal: controller.signal }).then((r) => {
      settled = true;
      return r;
    });
    await f.entered.promise;
    controller.abort();
    await f.cancelled.promise;
    expect(settled).toBe(false);
    expect(f.seen.map((request) => request.path)).toEqual(["/docText", "/cancel"]);
    expect(f.seen[1]!.body).toEqual({ requestId: f.seen[0]!.id, instanceId: expect.any(String) });
    f.acknowledge();
    expect(await result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(f.seen.filter((request) => request.path === "/docText")).toHaveLength(1);
  });
});
