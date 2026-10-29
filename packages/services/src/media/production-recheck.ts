import type { MediaJob, ProductionRecord } from "@liyoxi/db";
import type { Tx } from "../kernel/index.js";
import { ProbeInputSchema } from "./production-job-schemas.js";
import { contextHash } from "./production.js";

const active = ["queued", "running", "submitting", "submitted"];
/** A failed/canceled manual round can be replaced only by a new explicit user intent. */
export async function manualRecheckState(tx: Tx, record: ProductionRecord, now: Date) {
  const jobs = await tx.mediaJob.findMany({
    where: {
      kind: "probe",
      subjectType: "file_object",
      subjectId: record.fileId,
      parentType: "production_record",
      parentId: record.fileId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const valid = jobs.filter((job) => {
    const parsed = ProbeInputSchema.safeParse(job.input);
    if (
      !parsed.success ||
      job.provider !== "mediatool" ||
      job.mode !== "local" ||
      parsed.data.fileId !== record.fileId ||
      parsed.data.profile !== record.kind ||
      parsed.data.contextHash !== contextHash(record)
    )
      return false;
    const key = `probe:${record.fileId}:v${parsed.data.ruleVersion}:${parsed.data.contextHash}`;
    return job.dedupeKey === key || job.dedupeKey === `${key}:manual:${job.id}`;
  });
  const inflight = valid.find((job) => active.includes(job.state) && job.deadlineAt > now) ?? null;
  const previous: MediaJob | undefined = valid[0];
  return {
    inflight,
    recoverable:
      !inflight &&
      !!previous &&
      previous.dedupeKey.endsWith(`:manual:${previous.id}`) &&
      ["failed", "canceled"].includes(previous.state) &&
      previous.finishedAt !== null,
  };
}
