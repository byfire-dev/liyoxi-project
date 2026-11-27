import { execFile } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";
import { createDocumentConverter } from "@liyoxi/services";
import {
  fictionalDocumentDocx as docx,
  fictionalDocumentPdf as pdf,
} from "@liyoxi/services/testing";

const root = fileURLToPath(new URL("../", import.meta.url));
const scope = `dist/test-document-${process.pid}-${Date.now().toString(36)}`;
const out = `${scope}/release/apps/worker/dist`;
const repository = fileURLToPath(new URL("../../../", import.meta.url));
afterAll(() => rmSync(`${root}${scope}`, { recursive: true, force: true }));
it("the actual worker application artifact converts Chinese with declared external dependencies", async () => {
  await promisify(execFile)(process.execPath, ["scripts/build.mjs", "--outdir", out], {
    cwd: root,
  });
  // Run the real release guard: all entries must retain usable
  // maps under the existing budget, then execute the stripped production files.
  await promisify(execFile)(process.execPath, [
    `${repository}infra/deploy/source-maps.mjs`,
    "split",
    "worker",
    `${root}${scope}/release`,
    `${root}${scope}/private`,
    "test-worker-release",
  ]);
  expect(readdirSync(`${root}${out}`).some((name) => name.endsWith(".map"))).toBe(false);
  // Import a real business entry too: a successful esbuild alone misses dynamic font assets.
  await expect(
    promisify(execFile)(process.execPath, [`${root}${out}/staff-bootstrap.js`], {
      cwd: root,
      env: { PATH: process.env.PATH, APP_ENV: "test" },
    }),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("用法：staff:bootstrap") });
  await expect(
    promisify(execFile)(process.execPath, [`${root}${out}/legacy-snapshot-recovery.js`], {
      cwd: root,
      env: { PATH: process.env.PATH, APP_ENV: "test" },
    }),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("恢复参数/环境无效") });
  const converter = createDocumentConverter({
    workerUrl: pathToFileURL(`${root}${out}/document-converter.js`),
  });
  try {
    expect(
      await converter.convert({
        load: async () => ({ sourceBytes: docx(undefined, true), pdfBytes: pdf() }),
      }),
    ).toMatchObject({ ok: true, value: { similarityBp: 10000 } });
    expect(
      await converter.convert({ load: async () => ({ sourceBytes: null, pdfBytes: pdf("") }) }),
    ).toMatchObject({
      ok: true,
      value: { contentHtml: null, htmlSha256: null, similarityBp: null },
    });
  } finally {
    await converter.close();
  }
}, 60_000);
