import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDocumentConverter } from "./host.js";
import type { DocumentConverter } from "./host.js";
import { sanitizeConvertedHtml } from "./html.js";
import { textSimilarityBp } from "./similarity.js";
import { validateDocxZip } from "./zip.js";
import {
  fictionalDocumentBoundaryDocx as boundaryDocx,
  fictionalDocumentDocx as docx,
  fictionalDocumentParts as docxParts,
  fictionalDocumentPdf as pdf,
  fictionalDocumentZip as zip,
} from "../../testing/index.js";

const api = fileURLToPath(new URL("../../../../../apps/api/", import.meta.url));
const out = `dist/test-doc-services-${process.pid}-${Date.now().toString(36)}`;
const scratch = mkdtempSync(`${tmpdir()}/lyx-doc-`);
const converters: DocumentConverter[] = [];
let workerUrl: URL;
const create = (url = workerUrl) => {
  const converter = createDocumentConverter({ workerUrl: url });
  converters.push(converter);
  return converter;
};
beforeAll(async () => {
  await promisify(execFile)(process.execPath, ["scripts/build.mjs", "--outdir", out], { cwd: api });
  workerUrl = pathToFileURL(`${api}${out}/document-converter.js`);
}, 60_000);
afterAll(async () => {
  await Promise.all(converters.map((c) => c.close()));
  rmSync(`${api}${out}`, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});
const sum = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("isolated real document conversion", () => {
  it("preserves headings, paragraphs, lists and tables from a real fictional Word document", async () => {
    const parts = docxParts();
    parts[2]!.bytes = Buffer.from(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>虚构标题</w:t></w:r></w:p><w:p><w:r><w:t>段落 ABC 123</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>列表项</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格单元</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    );
    parts.push({
      name: "word/styles.xml",
      bytes: Buffer.from(
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>',
      ),
    });
    parts.push({
      name: "word/numbering.xml",
      bytes: Buffer.from(
        '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
      ),
    });
    parts.push({
      name: "word/_rels/document.xml.rels",
      bytes: Buffer.from(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="style" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="number" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>',
      ),
    });
    const result = await create().convert({
      load: async () => ({ sourceBytes: zip(parts), pdfBytes: null }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.contentHtml).toContain("<h1>虚构标题</h1>");
      expect(result.value.contentHtml).toContain("<p>段落 ABC 123</p>");
      expect(result.value.contentHtml).toContain("<ol><li>列表项</li></ol>");
      expect(result.value.contentHtml).toContain(
        "<table><tr><td><p>表格单元</p></td></tr></table>",
      );
    }
  });

  it("converts Chinese DOCX/PDF, hashes actual bytes, returns sanitized structure and integer similarity", async () => {
    const sourceBytes = docx(),
      pdfBytes = pdf(),
      sourceHash = sum(sourceBytes),
      pdfHash = sum(pdfBytes);
    const result = await create().convert({ load: async () => ({ sourceBytes, pdfBytes }) });
    expect(result).toMatchObject({
      ok: true,
      value: { sourceSha256: sourceHash, pdfSha256: pdfHash, similarityBp: 10000 },
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.contentHtml).toBe("<p><strong>狸有戏虚构协议 测试门店 123</strong></p>");
    expect(result.value.htmlSha256).toBe(sum(Buffer.from(result.value.contentHtml!)));
  });
  it("accepts image-only PDF drafts; paired Word reports 0, and changed Chinese/number text reports mismatch", async () => {
    const converter = create();
    const encrypted = () =>
      Uint8Array.from(readFileSync(new URL("./__fixtures__/encrypted.pdf", import.meta.url)));
    const encryptedHash = sum(encrypted());
    expect(
      await converter.convert({ load: async () => ({ sourceBytes: null, pdfBytes: encrypted() }) }),
    ).toMatchObject({
      ok: true,
      value: {
        pdfSha256: encryptedHash,
        contentHtml: null,
        htmlSha256: null,
        similarityBp: null,
        pdfTextIssue: null,
      },
    });
    expect(
      await converter.convert({
        load: async () => ({ sourceBytes: docx(), pdfBytes: encrypted() }),
      }),
    ).toMatchObject({ ok: true, value: { similarityBp: 0, pdfTextIssue: "unsupported_document" } });
    expect(
      await converter.convert({ load: async () => ({ sourceBytes: null, pdfBytes: pdf("") }) }),
    ).toMatchObject({
      ok: true,
      value: { contentHtml: null, htmlSha256: null, similarityBp: null },
    });
    expect(
      await converter.convert({ load: async () => ({ sourceBytes: docx(), pdfBytes: pdf("") }) }),
    ).toMatchObject({ ok: true, value: { similarityBp: 0 } });
    const changed = await converter.convert({
      load: async () => ({ sourceBytes: docx(), pdfBytes: pdf("全新虚构门店 999") }),
    });
    expect(changed.ok && changed.value.similarityBp! < 9800).toBe(true);
  });
  it("supports normal data descriptors; rejects bad/corrupt/macro/encrypted and page limits without parser details", async () => {
    const converter = create();
    expect(
      await converter.convert({
        load: async () => ({ sourceBytes: docx(undefined, true), pdfBytes: null }),
      }),
    ).toMatchObject({ ok: true });
    expect(
      await converter.convert({
        load: async () => ({ sourceBytes: Buffer.from("private corrupt body"), pdfBytes: null }),
      }),
    ).toEqual({ ok: false, reason: "invalid_document", role: "source" });
    const opaque = Buffer.from("%PDF-corrupt private body");
    const opaqueHash = sum(opaque);
    expect(
      await converter.convert({ load: async () => ({ sourceBytes: null, pdfBytes: opaque }) }),
    ).toMatchObject({
      ok: true,
      value: { pdfSha256: opaqueHash, contentHtml: null, htmlSha256: null, similarityBp: null },
    });
    const parts = docxParts();
    parts.push({ name: "word/vbaProject.bin", bytes: new Uint8Array([1]) });
    expect(
      await converter.convert({ load: async () => ({ sourceBytes: zip(parts), pdfBytes: null }) }),
    ).toEqual({ ok: false, reason: "unsupported_document", role: "source" });
    expect(
      await converter.convert({
        load: async () => ({ sourceBytes: docx(), pdfBytes: pdf("文字", 101) }),
      }),
    ).toEqual({ ok: false, reason: "too_large", role: "pdf" });
  });
  it("keeps URLs/images/script/attributes out of output and never needs external file access", async () => {
    const parts = docxParts("合法文本");
    parts[2]!.bytes = Buffer.from(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:hyperlink r:id="external"><w:r><w:t>链接文字</w:t></w:r></w:hyperlink><w:r><w:t>&lt;script&gt;私有测试&lt;/script&gt;</w:t></w:r></w:p></w:body></w:document>',
    );
    parts.push({
      name: "word/_rels/document.xml.rels",
      bytes: Buffer.from(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="file:///private-test-file" TargetMode="External"/></Relationships>',
      ),
    });
    const result = await create().convert({
      load: async () => ({ sourceBytes: zip(parts), pdfBytes: null }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.contentHtml).toContain("链接文字");
      expect(result.value.contentHtml).not.toMatch(/href|src=|file:\/|<script|<a[\s>]/);
    }
  });
  it("accepts the actual 20+20MiB upload boundary with one bounded worker", async () => {
    const sourceBytes = boundaryDocx(),
      pdfBytes = pdf(undefined, 1, true);
    expect(sourceBytes.byteLength).toBe(20 * 1024 * 1024);
    expect(pdfBytes.byteLength).toBe(20 * 1024 * 1024);
    const converter = create();
    expect(
      await converter.convert({ load: async () => ({ sourceBytes, pdfBytes }) }),
    ).toMatchObject({ ok: true, value: { similarityBp: 10000 } });
    expect(
      await converter.convert({ load: async () => ({ sourceBytes: docx(), pdfBytes: null }) }),
    ).toMatchObject({ ok: true });
  }, 25_000);
});

describe("admission and cleanup", () => {
  it("does not invoke queued loaders, cancels queued work, forwards loader failures, and closes active I/O", async () => {
    const converter = create(),
      abort = new AbortController();
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    const first = converter.convert({
      load: async () => {
        started();
        await new Promise<void>((r) => {
          release = r;
        });
        return { sourceBytes: docx(), pdfBytes: null };
      },
    });
    await ready;
    let calls = 0;
    const queued = converter.convert({
      signal: abort.signal,
      load: async () => {
        calls++;
        return { sourceBytes: docx(), pdfBytes: null };
      },
    });
    abort.abort();
    expect(await queued).toEqual({ ok: false, reason: "cancelled", role: null });
    expect(calls).toBe(0);
    release();
    expect(await first).toMatchObject({ ok: true });
    const marker = new Error("caller handles unavailable storage");
    await expect(
      converter.convert({
        load: async () => {
          throw marker;
        },
      }),
    ).rejects.toBe(marker);
    let ioStarted!: () => void;
    const ioReady = new Promise<void>((r) => {
      ioStarted = r;
    });
    const active = converter.convert({
      load: (signal) =>
        new Promise((_, reject) => {
          ioStarted();
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    await ioReady;
    await converter.close();
    expect(await active).toEqual({ ok: false, reason: "cancelled", role: null });
    expect(
      await converter.convert({
        load: async () => {
          throw marker;
        },
      }),
    ).toMatchObject({ ok: false, reason: "cancelled" });
  });
  it("terminates an actual stuck CPU worker at the 10s wall deadline and the parent remains usable", async () => {
    const path = `${scratch}/stuck.mjs`;
    writeFileSync(
      path,
      'import { parentPort } from "node:worker_threads"; parentPort.on("message",()=>{while(true){}});',
    );
    const converter = create(pathToFileURL(path));
    const start = Date.now();
    const active = converter.convert({ load: async () => ({ sourceBytes: null, pdfBytes: null }) });
    let queuedReads = 0;
    const queued = converter.convert({
      load: async () => {
        queuedReads++;
        return { sourceBytes: null, pdfBytes: null };
      },
    });
    expect(await active).toEqual({ ok: false, reason: "deadline_exceeded", role: null });
    expect(await queued).toEqual({ ok: false, reason: "deadline_exceeded", role: null });
    expect(queuedReads).toBe(0);
    expect(Date.now() - start).toBeGreaterThanOrEqual(9_900);
    expect(Date.now() - start).toBeLessThan(13_000);
    await converter.close();
    expect(
      await create().convert({ load: async () => ({ sourceBytes: docx(), pdfBytes: null }) }),
    ).toMatchObject({ ok: true });
  }, 20_000);
});

describe("ZIP validation and text metrics", () => {
  it("uses NFC codepoints and multiset Dice with empty/single/duplicate/Chinese/number cases", () => {
    expect(textSimilarityBp("狸é 123", "狸e\u0301\n123")).toBe(10000);
    expect(textSimilarityBp("", "")).toBe(0);
    expect(textSimilarityBp("狸", "狸")).toBe(10000);
    expect(textSimilarityBp("aaaa", "aa")).toBe(5000);
    expect(textSimilarityBp("门店123", "门店999")).toBeLessThan(9800);
    expect(() => textSimilarityBp("字".repeat(250001), "字")).toThrow("too_large");
  });
  it("enforces raw DOCX/PDF extracted codepoint and HTML UTF8 byte budgets", async () => {
    const largeWord = docxParts("字".repeat(250001));
    largeWord[2]!.stored = true;
    expect(
      await create().convert({
        load: async () => ({ sourceBytes: zip(largeWord), pdfBytes: null }),
      }),
    ).toEqual({ ok: false, reason: "too_large", role: "source" });
    const largePdf = pdf("字".repeat(2501), 100);
    expect(
      await create().convert({ load: async () => ({ sourceBytes: docx(), pdfBytes: largePdf }) }),
    ).toEqual({ ok: false, reason: "too_large", role: "pdf" });
    await expect(sanitizeConvertedHtml("字".repeat(349526))).rejects.toMatchObject({
      reason: "too_large",
      role: "source",
    });
    expect(
      await sanitizeConvertedHtml(
        '<p onclick="x()" style="color:red"><a href="https://invalid.example">字</a><img src="file:///private"/><script>private</script></p>',
      ),
    ).toBe("<p>字</p>");
  }, 25_000);
  it("rejects genuine CRC corruption, both encrypted headers, local mismatch and overlapping member ranges", async () => {
    const corrupt = Buffer.from(docx());
    const end = corrupt.length - 22,
      central = corrupt.readUInt32LE(end + 16);
    const checksum = corrupt.readUInt32LE(central + 16) ^ 1;
    corrupt.writeUInt32LE(checksum >>> 0, central + 16);
    corrupt.writeUInt32LE(checksum >>> 0, 14);
    await expect(validateDocxZip(corrupt)).rejects.toMatchObject({ reason: "invalid_document" });
    const encrypted = Buffer.from(docx()),
      encryptedCentral = encrypted.readUInt32LE(encrypted.length - 6);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 1, 6);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(encryptedCentral + 8) | 1, encryptedCentral + 8);
    await expect(validateDocxZip(encrypted)).rejects.toMatchObject({
      reason: "unsupported_document",
    });
    const mismatch = Buffer.from(docx());
    mismatch[30] = 65;
    await expect(validateDocxZip(mismatch)).rejects.toMatchObject({ reason: "invalid_document" });
    const overlap = Buffer.from(docx()),
      first = overlap.readUInt32LE(overlap.length - 6);
    const second =
      first +
      46 +
      overlap.readUInt16LE(first + 28) +
      overlap.readUInt16LE(first + 30) +
      overlap.readUInt16LE(first + 32);
    overlap.writeUInt32LE(0, second + 42);
    await expect(validateDocxZip(overlap)).rejects.toMatchObject({ reason: "invalid_document" });
  });
  it("enforces actual inflation and paths/duplicates/CRC independently of directory size claims", async () => {
    const bomb = docxParts();
    bomb.push({ name: "word/bomb.bin", bytes: new Uint8Array(1024 * 1024), declaredSize: 1 });
    await expect(validateDocxZip(zip(bomb))).rejects.toMatchObject({ reason: "too_large" });
    for (const name of ["../escape", "word/document.xml", "word/./escape", "word\\escape"]) {
      const parts = docxParts();
      parts.push({ name, bytes: new Uint8Array([1]) });
      await expect(validateDocxZip(zip(parts))).rejects.toMatchObject({
        reason: "invalid_document",
      });
    }
    const encrypted = docx();
    encrypted[6]! |= 1;
    await expect(validateDocxZip(encrypted)).rejects.toMatchObject({ reason: "invalid_document" });
    const entries = docxParts();
    for (let i = 0; i < 254; i++) entries.push({ name: `unused${i}`, bytes: new Uint8Array() });
    await expect(validateDocxZip(zip(entries))).rejects.toMatchObject({ reason: "too_large" });
  });
});
