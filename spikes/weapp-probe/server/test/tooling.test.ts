import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { padMp4, fixtureSizes } from "../src/fixtures.ts";
import { fileRecorder, Redactor } from "../src/records.ts";
import { generateReport } from "../src/report.ts";

it("fixture padding preserves payload and writes an exact sized free box without generating real media", () => {
  const root = mkdtempSync(path.join(tmpdir(), "lyx-probe-fixture-test-"));
  try {
    const file = path.join(root, "fake.mp4");
    writeFileSync(file, Buffer.from("fake-small-container"));
    padMp4(file, 64);
    expect(statSync(file).size).toBe(64);
    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 20).toString()).toBe("fake-small-container");
    expect(bytes.readUInt32BE(20)).toBe(44);
    expect(bytes.subarray(24, 28).toString()).toBe("free");
    expect(fixtureSizes).toEqual([30, 50, 60, 100, 150, 200, 300, 500]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("secrets are redacted before the recorder writes; report produces only the selected mode", () => {
  const root = mkdtempSync(path.join(tmpdir(), "lyx-probe-record-test-"));
  try {
    const redactor = new Redactor();
    redactor.add("private-test-value");
    const logs = path.join(root, "server/.logs");
    const record = fileRecorder("fake", redactor, logs);
    record({
      probeMode: "fake",
      item: "V3",
      scenario: "resume",
      device: "private-test-value",
      system: "test-os",
      baseLibrary: "2.32.3",
      network: "wifi",
      sizeBytes: 150_000_000,
      durationMs: 1000,
      result: "success",
      errorCode: "",
    });
    // This is a newly created disposable fake file, not server/.logs of any real run.
    expect(readFileSync(path.join(logs, "fake.jsonl"), "utf8")).not.toContain("private-test-value");
    generateReport(root, "fake");
    const report = readFileSync(path.join(root, "results/fake-summary.md"), "utf8");
    expect(report).toContain("替身演练");
    expect(report).toContain("V19 | 未实测");
    expect(report).not.toContain("private-test-value");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("fake fixtures CLI cannot read credential files or contact providers", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const result = spawnSync(process.execPath, ["server/src/fixtures.ts"], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      PROBE_MODE: "fake",
      PROBE_SECRETS_FILE: "/nonexistent/do-not-read",
    },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("不生成、不上传媒体");
  expect(result.stderr).toBe("");
});
