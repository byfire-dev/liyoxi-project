// @ts-check
// Real isolated /docText, unlike the hostile local socket peers in services tests.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { call, healthz, SOCKET } from "../lib/client.mjs";
import { WORK } from "../lib/spec.mjs";
import { docx, docxParts, encryptedPdf, pdf, zip } from "../lib/document-fixtures.mjs";

const directory = `doc-text-${process.pid}`,
  root = join(WORK, directory);
const original = "😀虚构正文\n第二段";
/** @param {string} name @param {Uint8Array|string} bytes */
const put = (name, bytes) => writeFile(join(root, name), bytes);
/** @param {string} name @param {"txt"|"docx"|"pdf"} ext @param {object} [extra] */
const extract = (name, ext, extra = {}) =>
  call("POST", "/docText", {
    path: `${directory}/${name}`,
    ext,
    maxChars: 1000,
    ...extra,
  });
/** @param {any} response @param {boolean} [truncated] */
function success(response, truncated = false) {
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(response.json.ok, true);
  assert.equal(typeof response.json.text, "string");
  assert.equal(response.json.truncated, truncated);
  assert.equal(Number.isSafeInteger(response.json.charCount), true);
  assert.ok(response.json.charCount >= 0 && response.json.charCount <= 250000);
  if (!truncated) assert.equal(response.json.charCount, [...response.json.text].length);
  return response.json;
}
/** @param {{status:number,json:any}} response */
function rejected(response) {
  assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(response));
  assert.equal(response.json.ok, false);
  assert.equal(typeof response.json.error.code, "string");
  assert.equal(response.json.text, undefined, "no partial text is returned after a parse failure");
}
before(async () => {
  await mkdir(root);
  await put("utf8.txt", original);
  await put("gbk.txt", Buffer.from("d6d0cec4", "hex")); // 中文, real GBK bytes.
  await put("bad-encoding.txt", Buffer.from([0x81]));
  await put("source.docx", docx("虚构段落😀", { tableText: "表格秘密不应抽出" }));
  await put("descriptor.docx", docx("普通描述器", { descriptor: true }));
  await put("two-pages.pdf", pdf("虚构正文😀", 2));
  await put("scan.pdf", pdf(""));
  await put("encrypted.pdf", encryptedPdf());
  await put("corrupt.pdf", "%PDF-1.7\nprivate malformed bytes");
  await put("corrupt.docx", "PK\x03\x04private malformed bytes");
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("docText real TXT: fatal UTF8, real GBK fallback, complete codepoint count and no fake pages", async () => {
  const text = success(await extract("utf8.txt", "txt"));
  assert.equal(text.text, original);
  assert.equal(text.charCount, [...original].length);
  assert.equal(text.pageCount, undefined);
  const short = success(await extract("utf8.txt", "txt", { maxChars: 1 }), true);
  assert.equal(short.text, "😀");
  assert.equal(short.charCount, [...original].length);
  assert.equal(short.pageCount, undefined);
  assert.equal(success(await extract("gbk.txt", "txt")).text, "中文");
  rejected(await extract("bad-encoding.txt", "txt"));
  await put("empty.txt", "");
  const empty = await extract("empty.txt", "txt");
  rejected(empty);
  assert.equal(empty.json.error.code, "no_text");
});

test("docText real DOCX: paragraphs are text, table AST subtrees are excluded, descriptor ZIP works", async () => {
  const full = success(await extract("source.docx", "docx"));
  assert.ok(full.text.includes("虚构段落😀"));
  assert.ok(full.text.includes("末段"));
  assert.equal(full.text.includes("表格秘密不应抽出"), false);
  assert.doesNotMatch(full.text, /<\/?(?:p|strong|table|w:)/);
  assert.equal(full.pageCount, undefined);
  const short = success(await extract("source.docx", "docx", { maxChars: 3 }), true);
  assert.equal(short.text, [...full.text].slice(0, 3).join(""));
  assert.equal(short.charCount, full.charCount);
  assert.equal(success(await extract("descriptor.docx", "docx")).text.trim(), "普通描述器");
});

test("docText real PDF: actual two-page Chinese text layer and count precede truncation", async () => {
  const full = success(await extract("two-pages.pdf", "pdf"));
  assert.equal(full.pageCount, 2);
  assert.equal(full.text.replace(/\s/gu, ""), "虚构正文😀虚构正文😀");
  const short = success(await extract("two-pages.pdf", "pdf", { maxChars: 2 }), true);
  assert.equal(short.text, [...full.text].slice(0, 2).join(""));
  assert.equal(short.charCount, full.charCount);
  assert.equal(short.pageCount, 2);
});

test("docText real PDF has no OCR: an image-only page fails with no_text", async () => {
  const result = await extract("scan.pdf", "pdf");
  rejected(result);
  assert.equal(result.json.error.code, "no_text");
});

test("docText damaged or genuinely encrypted documents fail without leaking private fragments", async () => {
  for (const [name, ext] of /** @type {const} */ ([
    ["corrupt.pdf", "pdf"],
    ["encrypted.pdf", "pdf"],
    ["corrupt.docx", "docx"],
  ])) {
    const result = await extract(name, ext);
    rejected(result);
    assert.doesNotMatch(JSON.stringify(result.json), /private malformed bytes|stack|\/app\//);
  }
  assert.equal(
    success(await extract("utf8.txt", "txt")).text,
    original,
    "parser recovers after bad inputs",
  );
});

test("docText enforces actual 250k text, 100 PDF pages and 20MiB input budgets", async () => {
  await put("max.txt", "😀".repeat(250000));
  const exact = success(await extract("max.txt", "txt", { maxChars: 250000 }));
  assert.equal(exact.charCount, 250000);
  assert.equal([...exact.text].length, 250000);
  await put("too-many-chars.txt", "x".repeat(250001));
  rejected(await extract("too-many-chars.txt", "txt", { maxChars: 1 }));
  await put("too-large.txt", Buffer.alloc(20 * 1024 * 1024 + 1, 0x61));
  rejected(await extract("too-large.txt", "txt"));
  await put("max-pages.pdf", pdf("页", 100));
  assert.equal(success(await extract("max-pages.pdf", "pdf")).pageCount, 100);
  await put("too-many-pages.pdf", pdf("页", 101));
  rejected(await extract("too-many-pages.pdf", "pdf"));
});

test("docText validates real DOCX ZIP inflation, CRC, paths and macros before parsing", async () => {
  const cases = [
    {
      name: "bomb",
      bytes: zip([
        ...docxParts(),
        { name: "word/bomb.xml", bytes: Buffer.alloc(9 * 1024 * 1024, 0x41) },
      ]),
    },
    {
      name: "traversal",
      bytes: zip([...docxParts(), { name: "../canary.txt", bytes: Buffer.from("private") }]),
    },
    {
      name: "macro",
      bytes: zip([...docxParts(), { name: "word/vbaProject.bin", bytes: Buffer.from([1]) }]),
    },
    { name: "duplicate", bytes: zip([...docxParts(), ...docxParts().slice(2)]) },
  ];
  const crc = zip(docxParts(undefined, { stored: true }));
  const marker = crc.indexOf(Buffer.from("虚构段落"));
  assert.ok(marker > 0);
  crc[marker] = (crc[marker] ?? 0) ^ 1;
  cases.push({ name: "crc", bytes: crc });
  for (const item of cases) {
    await put(`${item.name}.docx`, item.bytes);
    rejected(await extract(`${item.name}.docx`, "docx"));
  }
});

test("docText preserves DOCX hyperlink labels without returning the external target", async () => {
  const parts = docxParts("独立正文");
  const document = parts[2];
  assert.ok(document);
  document.bytes = Buffer.from(
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:hyperlink r:id="external"><w:r><w:t>独立正文</w:t></w:r></w:hyperlink></w:p></w:body></w:document>',
  );
  parts.push({
    name: "word/_rels/document.xml.rels",
    bytes: Buffer.from(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="file:///private-fictional-canary" TargetMode="External"/></Relationships>',
    ),
  });
  await put("external.docx", zip(parts));
  const result = success(await extract("external.docx", "docx"));
  assert.equal(result.text.trim(), "独立正文");
  assert.doesNotMatch(JSON.stringify(result), /file:\/|private-fictional-canary/);
});

test("docText rejects unsupported ext and bad request boundaries; timeout cannot exceed 10s", async () => {
  for (const over of [
    { ext: "xlsx" },
    { ext: "doc" },
    { ext: "PDF" },
    { ext: null },
    { maxChars: 0 },
    { maxChars: 250001 },
    { maxChars: 1.5 },
    { maxChars: "2" },
    { maxChars: null },
    { timeoutMs: 0 },
    { timeoutMs: 999 },
    { timeoutMs: 1.5 },
    { timeoutMs: null },
  ]) {
    const result = await extract("utf8.txt", "txt", over);
    assert.equal(result.status, 400, JSON.stringify(over));
    rejected(result);
  }
  assert.equal(success(await extract("utf8.txt", "txt", { timeoutMs: 3600000 })).text, original);
  for (const body of ["not json", "null", "[]", '"text"'])
    assert.equal((await call("POST", "/docText", body)).status, 400);
});

test("docText rejects traversal, absolute paths, symlinks and directories", async () => {
  for (const path of [
    "../etc/passwd",
    "/etc/passwd",
    `${directory}/../utf8.txt`,
    `${directory}//utf8.txt`,
    `${directory}/.hidden`,
    "utf8.txt",
    ".sock/mediatool.sock",
  ])
    rejected(await call("POST", "/docText", { path, ext: "txt", maxChars: 100 }));
  await symlink(join(root, "utf8.txt"), join(root, "link.txt"));
  rejected(await extract("link.txt", "txt"));
  await mkdir(join(root, "folder.txt"));
  rejected(await extract("folder.txt", "txt"));
});

/** @param {(health:any)=>boolean} matches @param {number} ms */
async function until(matches, ms) {
  const deadline = Date.now() + ms;
  let last;
  do {
    last = (await healthz()).json;
    if (matches(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  return last;
}
/** @param {object} body */
function operation(body) {
  const requestId = randomUUID();
  /** @type {(instance:string)=>void} */
  let register = () => undefined;
  /** @type {Promise<string>} */
  const registration = new Promise((resolve) => {
    register = resolve;
  });
  /** @type {http.ClientRequest|undefined} */
  let req;
  /** @type {Promise<{status:number,json:any}>} */
  const result = new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    req = http.request(
      {
        socketPath: SOCKET,
        path: "/docText",
        method: "POST",
        agent: false,
        timeout: 5000,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "x-lyx-call-id": requestId,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
      },
    );
    req.on("information", (info) => {
      if (info.statusCode === 102 && info.headers["x-lyx-call-id"] === requestId)
        register(String(info.headers["x-lyx-instance"]));
    });
    req.on("error", reject);
    req.on("timeout", () => req?.destroy(new Error("docText test operation timed out")));
    req.end(payload);
  });
  result.catch(() => undefined);
  return { requestId, registration, result, abort: () => req?.destroy() };
}

test(
  "docText cancellation ACK waits for its real parser child to exit and releases the slot",
  { timeout: 10000 },
  async () => {
    const parts = docxParts(undefined, { stored: true });
    const document = parts[2];
    assert.ok(document);
    document.bytes = Buffer.from(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        "<w:p><w:r><w:t>虚构</w:t></w:r></w:p>".repeat(30000) +
        "</w:body></w:document>",
    );
    await put("cancel.docx", zip(parts));
    const before = (await healthz()).json;
    const existing = new Set(before.procs.map((/** @type {{pid:number}} */ p) => p.pid));
    const op = operation({ path: `${directory}/cancel.docx`, ext: "docx", maxChars: 1000 });
    /** @type {string|undefined} */
    let instance;
    const cancel = () => call("POST", "/cancel", { requestId: op.requestId, instanceId: instance });
    try {
      instance = await Promise.race([
        op.registration,
        op.result.then(() => {
          throw new Error("docText ended before registration");
        }),
      ]);
      const started = await until(
        (h) =>
          h.stats.running === 1 &&
          h.procs.some(
            (/** @type {{pid:number,comm:string}} */ p) =>
              p.comm === "node" && !existing.has(p.pid),
          ),
        2000,
      );
      const child = started.procs.find(
        (/** @type {{pid:number,comm:string}} */ p) => p.comm === "node" && !existing.has(p.pid),
      );
      assert.ok(
        child,
        "must observe this real parser child; a pre-abort is not parser cancellation",
      );
      assert.equal(started.stats.running, 1);
      const ack = await cancel();
      assert.equal(ack.status, 200);
      assert.equal(ack.json.done, true);
      assert.equal(ack.json.requestId, op.requestId);
      const ended = (await healthz()).json;
      assert.equal(ended.stats.running, 0);
      assert.equal(ended.stats.queued, 0);
      assert.equal(
        ended.procs.some((/** @type {{pid:number}} */ p) => p.pid === child.pid),
        false,
      );
      const response = /** @type {{status:number,json:any}} */ (await op.result);
      assert.equal(response.json.ok, false);
      assert.equal(response.json.error.code, "killed");
      assert.equal((await cancel()).json.done, true, "repeat cancellation is idempotent");
      assert.equal(success(await extract("utf8.txt", "txt")).text, original);
    } finally {
      try {
        if (instance) await cancel();
      } finally {
        op.abort();
      }
    }
  },
);
