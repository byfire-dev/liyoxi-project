import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ProbeError } from "./errors.ts";

export const attemptSchema = z
  .object({
    probeMode: z.enum(["fake", "real"]),
    item: z.enum(["V19", "V8", "V3", "V7"]),
    scenario: z.string().max(100),
    device: z.string().max(100),
    system: z.string().max(80),
    baseLibrary: z.string().max(30),
    network: z.string().max(30),
    sizeBytes: z.number().int().min(0).max(500_000_000),
    durationMs: z.number().int().min(0).max(86_400_000),
    result: z.enum(["success", "failure", "cancelled", "interrupted"]),
    errorCode: z.string().max(80),
    mode: z.enum(["temp", "user_dir"]).optional(),
    runId: z.string().max(80).optional(),
    attemptId: z.string().max(80).optional(),
    phase: z.string().max(40).optional(),
    index: z.number().int().min(0).max(1000).optional(),
    sentParts: z.number().int().min(0).max(1000).optional(),
    retransmittedParts: z.number().int().min(0).max(1000).optional(),
    completedParts: z.number().int().min(0).max(1000).optional(),
    totalParts: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
export type Attempt = z.infer<typeof attemptSchema>;
export type RecordRow = Attempt & { recordedAt: string; probeMode: "fake" | "real" };
export class Redactor {
  private readonly values = new Set<string>();
  add(...values: string[]) {
    for (const value of values) if (value) this.values.add(value);
  }
  text(value: string) {
    let result = value;
    for (const secret of this.values) result = result.split(secret).join("[redacted]");
    return result
      .replace(/https?:\/\/\S+/g, "[url]")
      .replace(/(?:\+?86)?1[3-9]\d{9}/g, "[phone]")
      .replace(
        /(?:openid|session_key|appsecret|secretkey|access_token|authorization)\s*[:=]\s*[^\s,;]+/gi,
        "[redacted]",
      )
      .replace(/[\r\n|<>`]/g, " ")
      .slice(0, 100);
  }
  row(attempt: Attempt): Attempt {
    return Object.fromEntries(
      Object.entries(attempt).map(([key, value]) => [
        key,
        typeof value === "string" && !["probeMode", "item", "result", "mode"].includes(key)
          ? this.text(value)
          : value,
      ]),
    ) as Attempt;
  }
}
export function fileRecorder(
  mode: "fake" | "real",
  redactor: Redactor,
  root = path.resolve(import.meta.dirname, "../.logs"),
) {
  return (attempt: Attempt) => {
    if (attempt.probeMode !== mode) throw new ProbeError("PROBE_MODE_MISMATCH", 409);
    // Sanitize before write; never keep an unsanitized intermediate log.
    const row: RecordRow = {
      ...redactor.row(attempt),
      recordedAt: new Date().toISOString(),
      probeMode: attempt.probeMode,
    };
    mkdirSync(root, { recursive: true, mode: 0o700 });
    appendFileSync(path.join(root, `${mode}.jsonl`), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  };
}
