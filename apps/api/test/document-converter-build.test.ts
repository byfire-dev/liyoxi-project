import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";
import { createDocumentConverter } from "@liyoxi/services";
import {
  fictionalDocumentDocx as docx,
  fictionalDocumentPdf as pdf,
} from "@liyoxi/services/testing";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = `dist/test-document-${process.pid}-${Date.now().toString(36)}`;
afterAll(() => rmSync(`${root}${out}`, { recursive: true, force: true }));
it("the actual API artifact converts Chinese and remains usable after cancellation", async () => {
  await promisify(execFile)(process.execPath, ["scripts/build.mjs", "--outdir", out], {
    cwd: root,
  });
  const converter = createDocumentConverter({
    workerUrl: pathToFileURL(`${root}${out}/document-converter.js`),
  });
  try {
    const abort = new AbortController();
    abort.abort();
    expect(
      await converter.convert({
        signal: abort.signal,
        load: async () => {
          throw new Error("must not read");
        },
      }),
    ).toMatchObject({ ok: false, reason: "cancelled" });
    expect(
      await converter.convert({ load: async () => ({ sourceBytes: docx(), pdfBytes: pdf() }) }),
    ).toMatchObject({ ok: true, value: { similarityBp: 10000 } });
  } finally {
    await converter.close();
  }
}, 60_000);
