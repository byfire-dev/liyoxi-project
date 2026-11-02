// M5 borrows the existing M1 resource owner and transports; all business writes stay in HTTP.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createM1Support } from "./m1-support.js";
import { loadM5AdMedia } from "./m5-media.js";
import { readM5Facts } from "./m5-facts.js";
import type { M5FactScope } from "./m5-facts.js";
import type { M1SupportOptions } from "./m1-types.js";

export async function createM5Support(options: Pick<M1SupportOptions, "runId" | "clock"> = {}) {
  const ad = await loadM5AdMedia();
  const base = await createM1Support({
    ...options,
    additionalProductionReports: [
      { sha256: ad.video.sha256, sizeBytes: ad.video.sizeBytes, report: ad.report },
    ],
  });
  let closed = false;
  const owned = () => {
    assert.ok(!closed && base.runtime.env.APP_ENV === "test", "M5隔离支架已关闭或环境改变");
    const target = new URL(base.runtime.env.DATABASE_URL);
    assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
    assert.equal(target.pathname, `/${base.databaseName}`);
    assert.equal(base.databaseName, `lyx_test_api_${base.runId}_0_m1`);
    assert.equal(base.redisPrefix, `lyx:test:${base.runId}:0:`);
  };
  return {
    ...base,
    adVideo: ad.video,
    async readM5Facts(scope: M5FactScope) {
      owned();
      return base.runtime.tx.run((tx) => readM5Facts(tx, scope));
    },
    async finishAdProduction(
      fileId: string,
      scope: { adId: string; entityId: string; storeId: string; uploaderId: string },
    ) {
      owned();
      await base.promote(fileId);
      await base.runtime.tx.run(async (tx) => {
        const adRow = await tx.ad.findFirstOrThrow({
          where: { id: scope.adId, entityId: scope.entityId, storeId: scope.storeId },
        });
        const file = await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } });
        const record = await tx.productionRecord.findUniqueOrThrow({ where: { fileId } });
        assert.equal(adRow.editorId, scope.uploaderId);
        assert.equal(file.entityId, scope.entityId);
        assert.equal(file.storeId, scope.storeId);
        assert.equal(file.category, "ad_video");
        assert.equal(file.status, "stored");
        assert.equal(file.uploadActorId, scope.uploaderId);
        assert.equal(record.adId, scope.adId);
        assert.equal(record.kind, "ad");
        const object = base.providers.storage.objects.get(`${file.bucket}/${file.objectKey}`);
        assert.ok(object);
        assert.equal(createHash("sha256").update(object.body).digest("hex"), ad.video.sha256);
        assert.equal(object.body.length, ad.video.sizeBytes);
      });
      const probe = await base.runtime.tx.run((tx) => base.runtime.media.enqueueProbe(tx, fileId));
      await base.runtime.media.jobs.run({ jobId: probe });
      for (let round = 0; round < 12; round++) {
        await base.drainEvents();
        const jobs = await base.runtime.tx.run((tx) =>
          tx.mediaJob.findMany({
            where: {
              subjectType: "file_object",
              subjectId: fileId,
              kind: { in: ["probe", "thumbnail"] },
              state: "queued",
              nextRunAt: { lte: base.clock.now() },
            },
            select: { id: true },
            orderBy: { id: "asc" },
          }),
        );
        if (!jobs.length) {
          const facts = await base.runtime.tx.run((tx) =>
            base.runtime.media.adProductionFacts(tx, fileId),
          );
          assert.ok(
            facts.ready && facts.durationMs === ad.video.durationMs,
            "M5广告实际检查尚未就绪",
          );
          return;
        }
        for (const job of jobs) await base.runtime.media.jobs.run({ jobId: job.id });
      }
      throw new Error("M5本文件广告制作任务未在有界轮次完成");
    },
    async close() {
      closed = true;
      await base.close();
    },
  };
}
export type M5Support = Awaited<ReturnType<typeof createM5Support>>;
export type { M5Scope, M5FactScope, M5Facts } from "./m5-facts.js";
