import { createHash } from "node:crypto";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { StorageProvider } from "../providers/types.js";
import { analyticsPartitionName } from "./partition-month.js";

export const ANALYTICS_ARCHIVE_PAGE_ROWS = 128;
export const ANALYTICS_ARCHIVE_CHUNK_BYTES = 1_048_576;
export const ANALYTICS_ARCHIVE_ROW_BYTES = 65_536;
type RunTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
interface Cursor {
  occurredAt: string;
  id: string;
}
interface ExportRow {
  body: string | null;
  bytes: number;
  occurredAt: string;
  id: string;
}
interface Receipt {
  key: string;
  sha256: string;
  size: number;
  etag: string;
}
export interface AnalyticsArchiveResult {
  readonly rows: bigint;
  readonly chunks: number;
  readonly manifest: Receipt;
}
export function assertAnalyticsActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("analytics任务已取消");
}
const digest = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");

async function writeVerified(
  storage: StorageProvider,
  month: string,
  kind: "ndjson" | "index.json" | "manifest.json",
  body: Uint8Array,
  signal?: AbortSignal,
): Promise<Receipt> {
  assertAnalyticsActive(signal);
  const sha256 = digest(body),
    key = `analytics/archive/${month}/${sha256}.${kind}`;
  const contentIdentity = digest(
    Buffer.from(JSON.stringify(["analytics.archive", month, kind, sha256])),
  );
  const put = await storage.putObject({
    bucket: "secure",
    key,
    body,
    contentType: kind === "ndjson" ? "application/x-ndjson" : "application/json",
    contentDisposition: "attachment",
    ifAbsent: true,
    contentIdentity,
  });
  assertAnalyticsActive(signal);
  if (!put.ok || !put.value.etag || put.value.size !== body.byteLength)
    throw new AppError("PROVIDER_UNAVAILABLE");
  const head = await storage.head({ bucket: "secure", key });
  assertAnalyticsActive(signal);
  if (
    !head.ok ||
    !head.value.exists ||
    head.value.size !== body.byteLength ||
    head.value.etag !== put.value.etag
  )
    throw new AppError("PROVIDER_UNAVAILABLE");
  return { key, sha256, size: body.byteLength, etag: put.value.etag };
}

/** 每页短TX，外呼在TX外；索引哈希链使manifest元数据也保持有界内存。 */
export async function archiveAnalyticsPartition(input: {
  readonly month: string;
  readonly runTx: RunTx;
  readonly storage: StorageProvider;
  readonly signal?: AbortSignal;
}): Promise<AnalyticsArchiveResult> {
  const { month, runTx, storage, signal } = input;
  const partition = analyticsPartitionName(month);
  let cursor: Cursor | undefined, first: Cursor | undefined, last: Cursor | undefined;
  let pieces: Buffer[] = [],
    bytes = 0,
    chunkRows = 0,
    chunks = 0,
    rows = 0n;
  let previous: Receipt | null = null;
  const flush = async () => {
    if (chunkRows === 0) return;
    const data = await writeVerified(
      storage,
      month,
      "ndjson",
      Buffer.concat(pieces, bytes),
      signal,
    );
    const index = Buffer.from(
      JSON.stringify({
        version: 1,
        month,
        ordinal: chunks,
        data,
        rows: chunkRows,
        first,
        last,
        previous,
      }),
    );
    previous = await writeVerified(storage, month, "index.json", index, signal);
    chunks++;
    pieces = [];
    bytes = 0;
    chunkRows = 0;
    first = undefined;
  };
  for (;;) {
    assertAnalyticsActive(signal);
    const page = await runTx((tx) => {
      assertAnalyticsActive(signal);
      // row_to_json保留全部21列及数据库时间精度；大行只返回长度，不将其传入进程。
      return tx.$queryRawUnsafe<ExportRow[]>(
        `
        SELECT CASE WHEN octet_length(x.body) <= $3::integer THEN x.body ELSE NULL END AS body,
          octet_length(x.body)::integer AS bytes,
          to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt", e.id::text
        FROM public.analytics_event e
        CROSS JOIN LATERAL (SELECT row_to_json(e)::text AS body) x
        WHERE e.tableoid=to_regclass($5::text)
          AND e.occurred_at >= ($6::date::timestamp AT TIME ZONE 'Asia/Shanghai')
          AND e.occurred_at < (($6::date::timestamp + interval '1 month') AT TIME ZONE 'Asia/Shanghai')
          AND ($1::timestamptz IS NULL OR (e.occurred_at,e.id) > ($1::timestamptz,$2::uuid))
        ORDER BY e.occurred_at,e.id LIMIT $4::integer`,
        cursor?.occurredAt ?? null,
        cursor?.id ?? null,
        ANALYTICS_ARCHIVE_ROW_BYTES,
        ANALYTICS_ARCHIVE_PAGE_ROWS,
        `public.${partition}`,
        `${month}-01`,
      );
    });
    assertAnalyticsActive(signal);
    for (const row of page) {
      if (row.body === null || row.bytes > ANALYTICS_ARCHIVE_ROW_BYTES)
        throw new AppError("VALIDATION_FAILED");
      const line = Buffer.from(`${row.body}\n`);
      if (bytes + line.byteLength > ANALYTICS_ARCHIVE_CHUNK_BYTES) await flush();
      cursor = { occurredAt: row.occurredAt, id: row.id };
      first ??= cursor;
      last = cursor;
      pieces.push(line);
      bytes += line.byteLength;
      chunkRows++;
      rows++;
    }
    if (page.length < ANALYTICS_ARCHIVE_PAGE_ROWS) break;
  }
  await flush();
  const manifest = await writeVerified(
    storage,
    month,
    "manifest.json",
    Buffer.from(
      JSON.stringify({
        version: 1,
        format: "postgres-row-json-v1",
        month,
        partition,
        rows: rows.toString(),
        chunks,
        lastIndex: previous,
      }),
    ),
    signal,
  );
  return { rows, chunks, manifest };
}
