import { createHash } from "node:crypto";
import type { MediaJob } from "@liyoxi/db";
import type { BoundMediaDeps } from "../context.js";
import type { MediaJobHandler, JobOutcome, JobJson } from "../jobs/types.js";
import { systemProduceId } from "../jobs/convergence.js";
import {
  contextHash,
  createDerivedFile,
  enqueueProbe,
  json,
  readProductionWork,
  requiredJson,
} from "../production.js";
import { LabelSchema, parseLabel, technicalReport } from "../production-report.js";
import { saveTechnical } from "./probe.js";
import { link } from "../refs.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import { AppError, lockRows } from "../../kernel/index.js";
import type { StorageBucket } from "../../providers/types.js";
import { DerivationInputSchema, DerivationOutputSchema } from "../production-job-schemas.js";
export { DerivationInputSchema, DerivationOutputSchema } from "../production-job-schemas.js";
const failure = (code: string, retryable = false): JobOutcome => ({
  state: "failed",
  failure: { code, retryable },
});
export async function derivationCurrent(deps: BoundMediaDeps, tx: Tx, job: MediaJob) {
  const input = DerivationInputSchema.safeParse(job.input);
  if (
    !input.success ||
    job.parentType !== "production_record" ||
    job.parentId !== job.subjectId ||
    job.subjectType !== "file_object" ||
    input.data.fileId !== job.subjectId ||
    input.data.objectKey !==
      `derived/${input.data.destinationFileId}/${job.kind}-v${input.data.ruleVersion}.mp4`
  )
    return false;
  await lockRows(tx, "file_object", [job.subjectId, input.data.destinationFileId]);
  const facts = await readProductionWork(deps, tx, job.subjectId);
  return (
    facts.file.status === "stored" &&
    facts.file.moderationState !== "block" &&
    facts.production !== null &&
    contextHash(facts.production) === input.data.contextHash &&
    facts.parameters.ruleVersion === input.data.ruleVersion
  );
}
export async function finishDerivation(
  deps: BoundMediaDeps,
  tx: Tx,
  job: MediaJob,
  outcome: JobOutcome,
  ctx: IdentityContext,
) {
  if (outcome.state !== "succeeded") return;
  if (deps.production?.mode !== undefined && deps.production.mode !== "full")
    throw new AppError("PROVIDER_UNAVAILABLE");
  const output = DerivationOutputSchema.parse(outcome.output),
    input = DerivationInputSchema.parse(job.input),
    facts = await readProductionWork(deps, tx, job.subjectId);
  if (!facts.production || output.fileId !== input.destinationFileId)
    throw new Error("媒体派生结果归属不一致");
  const now = deps.clock.now();
  await createDerivedFile(
    tx,
    facts.file,
    { id: output.fileId, objectKey: input.objectKey, ...output },
    now,
  );
  const { fileId: _id, createdAt: _created, updatedAt: _updated, ...context } = facts.production;
  await tx.productionRecord.createMany({
    data: [
      {
        ...context,
        fileId: output.fileId,
        source: job.kind === "restamp" ? "restamped" : "normalized",
        derivedFromFileId: facts.file.id,
        pipelineState: "checking",
        aigcState: output.technical.aigcMeta ? "verified" : "pending",
        aigcOrigin: output.aigcOrigin,
        uploadedByStaffId: null,
        aiUsage: requiredJson(facts.production.aiUsage),
        similarity: json(facts.production.similarity),
        createdAt: now,
        updatedAt: now,
      },
    ],
    skipDuplicates: true,
  });
  const derived = await tx.productionRecord.findUniqueOrThrow({ where: { fileId: output.fileId } });
  if (
    contextHash(derived) !== contextHash(facts.production) ||
    derived.derivedFromFileId !== facts.file.id
  )
    throw new Error("媒体派生上下文不一致");
  await saveTechnical(tx, output.fileId, output.technical, null, now);
  await link(deps, tx, {
    fileId: facts.file.id,
    entityId: facts.file.entityId,
    storeId: facts.file.storeId,
    refType: "production_record",
    refId: output.fileId,
    role: "source",
  });
  await deps.events.emit(tx, ctx, {
    type: "media.production.derived",
    aggregate: { type: "production_record", id: output.fileId },
    entityId: facts.file.entityId,
    storeId: facts.file.storeId,
    payload: {
      v: 1,
      fileId: output.fileId,
      sourceFileId: facts.file.id,
      derivation: job.kind as "restamp" | "normalize",
    },
    dedupeKey: output.fileId,
  });
  return [
    await enqueueProbe(deps, tx, output.fileId, {
      parentBatchId: facts.file.uploadBatchId ?? undefined,
    }),
  ];
}
export function createRestampHandler(deps: BoundMediaDeps): MediaJobHandler {
  return {
    kind: "restamp",
    mode: "local",
    provider: "mediatool",
    validInput: (input) => DerivationInputSchema.safeParse(input).success,
    validOutput: (output) => DerivationOutputSchema.safeParse(output).success,
    current: (tx, job) => derivationCurrent(deps, tx, job),
    canRetry: (tx, job) =>
      deps.production?.mode !== undefined && deps.production.mode !== "full"
        ? Promise.resolve(false)
        : derivationCurrent(deps, tx, job),
    prepare: (tx, job) => readProductionWork(deps, tx, job.subjectId),
    execute: async (job, context, signal) => {
      const production = deps.production;
      if (!production || (production.mode !== undefined && production.mode !== "full"))
        return failure("MEDIA_PROVIDER_UNSUPPORTED");
      const facts = context as Awaited<ReturnType<typeof readProductionWork>>,
        input = DerivationInputSchema.parse(job.input),
        size = Number(facts.file.sizeBytes);
      if (!Number.isSafeInteger(size) || size <= 0 || !facts.file.etag)
        return failure("MEDIA_FACTS_MISSING");
      return production.workspace.run(job, signal, async (work) => {
        const source = await work.download({
          bucket: facts.file.bucket as StorageBucket,
          key: facts.file.objectKey,
          size,
          etag: facts.file.etag!,
        });
        if (!source.ok) return failure("MEDIA_SOURCE_CHANGED", source.reason === "unavailable");
        const before = await production.tool.probe({
          path: work.path("source.mp4"),
          demuxers: ["mov"],
          signal,
        });
        if (!before.ok) return failure("MEDIA_PROBE_FAILED", before.reason === "unavailable");
        const upstream = parseLabel(before.value.aigc);
        if (before.value.aigc !== null && !upstream) return failure("MEDIA_AIGC_INVALID");
        const label =
          upstream ??
          LabelSchema.parse({
            ...production.config.aigc,
            ProduceID: systemProduceId(input.destinationFileId),
            PropagateID: production.config.aigc.ContentPropagator
              ? systemProduceId(input.destinationFileId)
              : "",
          });
        const name = upstream ? ("source.mp4" as const) : ("stamped.mp4" as const);
        if (!upstream) {
          const stamped = await production.tool.stampAigc({
            path: work.path("source.mp4"),
            outPath: work.path("stamped.mp4"),
            aigcJson: JSON.stringify(label),
            signal,
          });
          if (!stamped.ok)
            return failure("MEDIA_AIGC_STAMP_FAILED", stamped.reason === "unavailable");
        }
        // An independent probe of the actual output is mandatory even when upstream seven fields were preserved.
        const readback = await production.tool.probe({
          path: work.path(name),
          demuxers: ["mov"],
          signal,
        });
        if (!readback.ok)
          return failure("MEDIA_AIGC_READBACK_FAILED", readback.reason === "unavailable");
        const actual = parseLabel(readback.value.aigc),
          technical = technicalReport(readback.value);
        if (
          !actual ||
          !technical ||
          Object.keys(label).some(
            (key) => actual[key as keyof typeof actual] !== label[key as keyof typeof label],
          )
        )
          return failure("MEDIA_AIGC_READBACK_MISMATCH");
        const result = await work.publish({
          name,
          dst: { bucket: facts.file.bucket as StorageBucket, key: input.objectKey },
          contentIdentity: createHash("sha256")
            .update(JSON.stringify([input.destinationFileId, input.contextHash, "restamp"]))
            .digest("hex"),
        });
        if (!result.ok || result.value.size !== technical.sizeBytes)
          return failure("MEDIA_DERIVED_VERIFY_FAILED");
        await deps.tx.run((tx) =>
          createDerivedFile(
            tx,
            facts.file,
            { id: input.destinationFileId, objectKey: input.objectKey, ...result.value },
            deps.clock.now(),
          ),
        );
        return {
          state: "succeeded",
          output: {
            fileId: input.destinationFileId,
            ...result.value,
            technical,
            aigcOrigin: upstream ? "upstream" : "stamped",
          } as unknown as JobJson,
        };
      });
    },
    finish: (tx, job, result, ctx) => finishDerivation(deps, tx, job, result, ctx),
  };
}
