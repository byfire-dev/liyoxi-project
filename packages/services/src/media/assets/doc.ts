import { z } from "zod";
import type { MediaJob } from "@liyoxi/db";
import { assertNotInTransaction, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { DocTextResultSchema } from "../../providers/types.js";
import type { JobJson, JobOutcome } from "../jobs/types.js";
import type { AssetDeps } from "./context.js";
import { AssetJobInputSchema, assetJobOwned } from "./pipeline.js";

const format = z.enum(["txt", "docx", "pdf"]);
const maxChars = 10000;
const skipped = (reason: string): JobOutcome => ({
  state: "succeeded",
  output: { status: "skipped", reason, content: {}, verdict: null },
});

/** The same format-specific facts are required from both the tool and historical cache. */
export function documentFacts(value: unknown, ext: string | null) {
  const parsed = DocTextResultSchema.safeParse(value);
  return parsed.success &&
    format.safeParse(ext).success &&
    !!parsed.data.text.trim() &&
    Array.from(parsed.data.text).length === Math.min(maxChars, parsed.data.charCount) &&
    (ext === "pdf" ? parsed.data.pageCount !== undefined : parsed.data.pageCount === undefined)
    ? parsed.data
    : null;
}

/** Local parsing owns no model admission, remote task, scheduler or new filesystem path. */
export function createAssetDocStrategy(
  deps: AssetDeps,
  current: (tx: Tx, job: MediaJob) => Promise<boolean>,
) {
  async function admitted(job: MediaJob) {
    if (job.kind !== "doc_extract" || job.state !== "running" || !assetJobOwned(job)) return null;
    const input = AssetJobInputSchema.parse(job.input);
    return deps.tx.run(async (tx) => {
      await lockRows(tx, "store_asset", [input.assetId]);
      await lockRows(tx, "media_job", [job.id]);
      const fresh = await tx.mediaJob.findUnique({ where: { id: job.id } });
      const now = deps.clock.now();
      if (
        !fresh ||
        fresh.state !== job.state ||
        fresh.attemptNo !== job.attemptNo ||
        !job.leaseOwner ||
        fresh.leaseOwner !== job.leaseOwner ||
        fresh.nextRunAt <= now ||
        fresh.deadlineAt <= now ||
        JSON.stringify(AssetJobInputSchema.parse(fresh.input)) !== JSON.stringify(input) ||
        !(await current(tx, fresh)) ||
        !input.fileId
      )
        return null;
      const file = await tx.fileObject.findUniqueOrThrow({ where: { id: input.fileId } });
      return file.bucket === "asset" && file.storeId ? file : null;
    });
  }

  async function execute(
    job: MediaJob,
    signal: AbortSignal,
    reused: { id: string; content: JobJson } | null,
  ): Promise<JobOutcome> {
    if (signal.aborted) return { state: "canceled" };
    try {
      const file = await admitted(job);
      if (!file || signal.aborted) return { state: "canceled" };
      const ext = format.safeParse(file.ext);
      if (!ext.success) return skipped("document_format_unsupported");
      if (!file.etag || file.sizeBytes === null || file.sizeBytes <= 0n)
        return skipped("document_missing");
      if (file.sizeBytes > 20n * 1024n ** 2n) return skipped("document_text_limit");
      const size = Number(file.sizeBytes),
        etag = file.etag;
      const cached = reused && documentFacts(reused.content, ext.data);
      if (cached)
        return {
          state: "succeeded",
          output: {
            status: "ok",
            reason: null,
            content: cached,
            verdict: null,
            reusedFromId: reused.id,
          },
        };
      const production = deps.production;
      if (!production?.tool.docText) return skipped("document_extractor_unconfigured");
      const docText = production.tool.docText.bind(production.tool);
      const sameSource = async () => {
        const fresh = await admitted(job);
        return (
          !signal.aborted &&
          fresh &&
          fresh.ext === file.ext &&
          fresh.objectKey === file.objectKey &&
          fresh.sha256 === file.sha256
        );
      };
      assertNotInTransaction("素材文档下载和隔离抽取");
      return await production.workspace.run(job, signal, async (work) => {
        const downloaded = await work.download({
          bucket: "asset",
          key: file.objectKey,
          size,
          etag,
        });
        if (!downloaded.ok) return skipped("document_read_unavailable");
        if (
          downloaded.value.size !== size ||
          !/^[0-9a-f]{64}$/.test(downloaded.value.sha256) ||
          (file.sha256 && downloaded.value.sha256 !== file.sha256)
        )
          return skipped("document_source_invalid");
        if (!(await sameSource())) return { state: "canceled" };
        assertNotInTransaction("素材文档隔离抽取");
        const timeoutMs = Math.min(10000, job.deadlineAt.getTime() - deps.clock.now().getTime());
        if (timeoutMs <= 0) return { state: "canceled" };
        const result = await docText({
          path: work.path("source.mp4"),
          ext: ext.data,
          maxChars,
          timeoutMs,
          signal,
        });
        if (!(await sameSource())) return { state: "canceled" };
        if (!result.ok) return skipped("document_extract_unavailable");
        const content = documentFacts(result.value, ext.data);
        return content
          ? {
              state: "succeeded",
              output: { status: "ok", reason: null, content, verdict: null },
            }
          : skipped("document_result_invalid");
      });
    } catch {
      return signal.aborted ? { state: "canceled" } : skipped("document_extract_unavailable");
    }
  }
  return { execute };
}
