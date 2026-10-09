// 前一北京时间自然日，只哈希证据的全部列，不输出证据内容；摘要私有存储且禁止覆盖旧摘要。
import { createHash } from "node:crypto";
import { addDays, calendarDate, dayRange } from "@liyoxi/shared/time";
import type { Alerts, Tx, TxRunner } from "../kernel/index.js";
import { AppError } from "../kernel/index.js";
import type { ProviderResult, StorageProvider } from "../providers/types.js";
const LIMIT = 4096;
export interface ConsentDigest {
  readonly v: 1;
  readonly day: string;
  readonly rows: number;
  readonly firstSeq: string | null;
  readonly lastSeq: string | null;
  readonly sha256: string;
}
export interface ConsentDigestDeps {
  readonly tx: TxRunner;
  readonly storage: Pick<StorageProvider, "head" | "readObject" | "putObject">;
  readonly alerts: Alerts;
}
function check(signal: AbortSignal | undefined) {
  signal?.throwIfAborted();
}
/** 类型标签与有序键避免Date/byte/bigint/字符串碰撞，JSON空白与对象键顺序不影响哈希。 */
export function canonicalEvidence(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Date) return JSON.stringify({ date: value.toISOString() });
  if (typeof value === "bigint") return JSON.stringify({ bigint: value.toString() });
  if (value instanceof Uint8Array)
    return JSON.stringify({ bytes: Buffer.from(value).toString("hex") });
  if (Array.isArray(value)) return "[" + value.map(canonicalEvidence).join(",") + "]";
  if (typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonicalEvidence(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function calculateConsentDigest(
  tx: Pick<Tx, "agreementConsent">,
  day: string,
  signal?: AbortSignal,
): Promise<ConsentDigest> {
  const range = dayRange(day),
    hash = createHash("sha256");
  let lastSeq: bigint | undefined,
    firstSeq: string | null = null,
    rows = 0;
  for (;;) {
    check(signal);
    const found = await tx.agreementConsent.findMany({
      where: {
        consentedAt: { gte: range.start, lt: range.end },
        ...(lastSeq === undefined ? {} : { seq: { gt: lastSeq } }),
      },
      orderBy: { seq: "asc" },
      take: 500,
    });
    if (!found.length) break;
    for (const row of found) {
      if (firstSeq === null) firstSeq = String(row.seq);
      lastSeq = row.seq;
      hash.update(canonicalEvidence(row) + "\n", "utf8");
      rows += 1;
    }
  }
  return {
    v: 1,
    day,
    rows,
    firstSeq,
    lastSeq: lastSeq === undefined ? null : String(lastSeq),
    sha256: hash.digest("hex"),
  };
}
const keyOf = (day: string) => `evidence/consents/${day}.json`;
function provider<T>(result: ProviderResult<T>): T {
  if (!result.ok) throw new AppError("FILE_NOT_AVAILABLE");
  return result.value;
}
async function savedDigest(
  deps: ConsentDigestDeps,
  day: string,
  signal?: AbortSignal,
): Promise<ConsentDigest | null> {
  check(signal);
  const ref = { bucket: "secure" as const, key: keyOf(day) },
    head = provider(await deps.storage.head({ ...ref, ...(signal ? { signal } : {}) }));
  if (!head.exists) return null;
  if (head.size < 1 || head.size > LIMIT) throw new AppError("FILE_NOT_AVAILABLE");
  check(signal);
  const bytes = provider(
    await deps.storage.readObject({
      ...ref,
      maxBytes: LIMIT,
      ...(signal ? { signal } : {}),
      ...(head.etag ? { ifMatchEtag: head.etag } : {}),
    }),
  );
  if (bytes.byteLength !== head.size) throw new AppError("FILE_NOT_AVAILABLE");
  // 原始JSON解析异常可能带证据片段，只抛固定领域错。
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new AppError("FILE_NOT_AVAILABLE");
  }
  if (!value || typeof value !== "object") throw new AppError("FILE_NOT_AVAILABLE");
  const v = value as Record<string, unknown>;
  if (
    v.v !== 1 ||
    v.day !== day ||
    !Number.isSafeInteger(v.rows) ||
    Number(v.rows) < 0 ||
    typeof v.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(v.sha256) ||
    ![v.firstSeq, v.lastSeq].every((s) => s === null || (typeof s === "string" && /^\d+$/.test(s)))
  )
    throw new AppError("FILE_NOT_AVAILABLE");
  return value as ConsentDigest;
}
class ConsentDigestMismatch extends AppError {
  constructor() {
    super("FILE_NOT_AVAILABLE");
  }
}
async function assertSame(deps: ConsentDigestDeps, actual: ConsentDigest, saved: ConsentDigest) {
  if (canonicalEvidence(actual) !== canonicalEvidence(saved)) {
    await deps.alerts.raise({
      rule: "evidence.consent_digest_mismatch",
      dimension: actual.day,
      severity: "P1",
      detail: { day: actual.day, rows: actual.rows },
    });
    throw new ConsentDigestMismatch();
  }
}
export async function runConsentDigest(
  deps: ConsentDigestDeps,
  scheduledFor: Date,
  signal?: AbortSignal,
) {
  const day = addDays(calendarDate(scheduledFor), -1),
    prior = addDays(day, -1);
  try {
    const previous = await savedDigest(deps, prior, signal);
    if (previous) {
      const recalculated = await deps.tx.run((tx) => calculateConsentDigest(tx, prior, signal));
      await assertSame(deps, recalculated, previous);
    }
    const digest = await deps.tx.run((tx) => calculateConsentDigest(tx, day, signal)),
      saved = await savedDigest(deps, day, signal);
    if (saved) {
      await assertSame(deps, digest, saved);
      return {
        day,
        rows: digest.rows,
        sha256: digest.sha256,
        created: false,
        verifiedPrevious: previous !== null,
      };
    }
    check(signal);
    const body = Buffer.from(JSON.stringify(digest), "utf8");
    if (body.byteLength > LIMIT) throw new AppError("FILE_NOT_AVAILABLE");
    provider(
      await deps.storage.putObject({
        bucket: "secure",
        key: keyOf(day),
        body,
        contentType: "application/json",
        ifAbsent: true,
        contentIdentity: digest.sha256,
      }),
    );
    const written = await savedDigest(deps, day, signal);
    if (!written) throw new AppError("FILE_NOT_AVAILABLE");
    await assertSame(deps, digest, written);
    return {
      day,
      rows: digest.rows,
      sha256: digest.sha256,
      created: true,
      verifiedPrevious: previous !== null,
    };
  } catch (error) {
    if (!(error instanceof ConsentDigestMismatch)) {
      await deps.alerts.raise({
        rule: "evidence.consent_digest_unavailable",
        dimension: day,
        severity: "P2",
        detail: { day },
      });
    }
    throw error;
  }
}
