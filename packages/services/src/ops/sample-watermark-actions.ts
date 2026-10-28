import { IdSchema, z } from "@liyoxi/contract";
import { assertPermission } from "../authz/index.js";
import { record } from "../audit/index.js";
import { lockCurrentSampleWatermarkTarget } from "../delivery/index.js";
import { AppError, createActor } from "../kernel/index.js";
import type { Clock, Env, TxRunner } from "../kernel/index.js";
import type { Media } from "../media/index.js";
import { loadCliStaffContext } from "../staff/index.js";

const inputSchema = z.strictObject({
  staffId: IdSchema,
  sampleId: IdSchema,
  note: z
    .string()
    .trim()
    .refine((value) => Array.from(value).length >= 5 && Array.from(value).length <= 200),
});
export type SampleWatermarkCliInput = z.infer<typeof inputSchema>;

/** 本机运维使用真实员工权限，只补排正式水印任务，不代录人工质检或商家决定。 */
export function createSampleWatermarkActions(deps: {
  env: Pick<Env, "APP_ENV" | "DATABASE_URL" | "MEDIA_PRODUCTION">;
  tx: TxRunner;
  clock: Clock;
  media: Pick<Media, "ensureSampleWatermark" | "jobs">;
}) {
  return {
    async runCli(input: SampleWatermarkCliInput) {
      let localDatabase = false;
      try {
        const database = new URL(deps.env.DATABASE_URL);
        localDatabase =
          ["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) &&
          database.pathname.length > 1;
      } catch {
        /* Invalid connection data is never echoed. */
      }
      const production = deps.env.MEDIA_PRODUCTION;
      if (
        !["local", "test"].includes(deps.env.APP_ENV) ||
        !localDatabase ||
        !production ||
        !("mode" in production) ||
        production.mode !== "local_sample_watermark"
      )
        throw new AppError("STATE_NOT_ALLOWED");
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) throw new AppError("VALIDATION_FAILED");
      const value = parsed.data;
      const result = await deps.tx.run(async (tx) => {
        const staff = await loadCliStaffContext(tx, value.staffId),
          now = deps.clock.now();
        assertPermission(staff, "media.job.retry", now);
        assertPermission(staff, "delivery.sample.push", now);
        const target = await lockCurrentSampleWatermarkTarget(tx, value.sampleId, staff);
        const jobId = await deps.media.ensureSampleWatermark(tx, target.fileId);
        await record(
          tx,
          createActor({ type: "staff", id: staff.staff.id, client: "cli" }),
          {
            requestId: null,
            ip: null,
            userAgent: null,
            authMethod: null,
            sessionId: null,
            jobName: "cli.sample.watermark",
            actorRole: staff.staff.roleKey,
          },
          {
            stream: "ops",
            category: "system_ops",
            action: "media.sample.watermark_enqueue",
            summary: "补排样片水印预览",
            target: { type: "sample", id: value.sampleId },
            entityId: target.entityId,
            storeId: target.storeId,
            reason: { code: "other", text: value.note },
            before: { status: "qc_passed", fileId: target.fileId },
            after: { status: "qc_passed", fileId: target.fileId, jobId },
            fields: ["jobId"],
          },
        );
        return { sampleId: value.sampleId, fileId: target.fileId, jobId };
      });
      await deps.media.jobs.wake(result.jobId);
      return result;
    },
  };
}
