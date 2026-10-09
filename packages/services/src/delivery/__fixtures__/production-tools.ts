import type { PrismaClient } from "@liyoxi/db";
import { uuidv7 } from "../../kernel/index.js";
import type { DeliveredEvent } from "../../kernel/index.js";
import type { MediaProductionDeps } from "../../media/index.js";
import { createProductionChecked } from "../production-checked.js";
import { harness } from "./harness.js";
import { createDeliveryProductionTools } from "../../testing/index.js";

/** External codec/cloud doubles only: all job claims, hashes, rows, refs and delivery writes are real. */
export function productionHarness(prisma: PrismaClient) {
  let external: ReturnType<typeof createDeliveryProductionTools>;
  const h = harness(prisma, true, ({ fake }) => {
    external = createDeliveryProductionTools(fake);
    const production: MediaProductionDeps = {
      tool: external.tool,
      workspace: external.workspace,
      cloud: fake.media,
      config: {
        aigc: {
          Label: "1",
          ContentProducer: "TEST-SYSTEM",
          ReservedCode1: "",
          ContentPropagator: "",
          ReservedCode2: "",
        },
        templates: {
          normalize: "normalize",
          sample: "sample",
          sd: "sd",
          hd: "hd",
          brand: "brand",
          ai: "ai",
        },
      },
      parameters: async () => ({
        finalMaxMb: 200,
        softDurationMs: 180_000,
        ruleVersion: 1,
        specVersion: 1,
      }),
      readStoreFacts: async (tx, id) => {
        const store = await tx.store.findUnique({ where: { id } });
        return store?.name ? { name: store.name } : null;
      },
      readMasterFacts: async (tx, id) => {
        const master = await tx.dramaEpisodeMaster.findUnique({ where: { id } });
        const info = master
          ? await tx.mediaInfo.findUnique({ where: { fileId: master.fileId } })
          : null;
        return master && info?.durationMs && info.displayWidth && info.displayHeight
          ? {
              id,
              durationMs: info.durationMs,
              displayWidth: info.displayWidth,
              displayHeight: info.displayHeight,
              isCurrent: master.isCurrent,
            }
          : null;
      },
    };
    return production;
  });
  const consume = createProductionChecked({ clock: h.clock, flow: h.flow, media: h.media });
  async function checked(fileId: string): Promise<DeliveredEvent> {
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: "media.production.checked", aggregateId: fileId },
      orderBy: { id: "desc" },
    });
    return {
      id: event.id,
      type: event.eventType,
      payload: event.payload as Record<string, unknown>,
    };
  }
  async function probe(fileId: string) {
    const jobId = await h.tx.run((tx) => h.media.enqueueProbe(tx, fileId));
    await h.media.jobs.run({ jobId });
    return jobId;
  }
  return {
    ...h,
    failStamp: (value: boolean) => external.failStamp(value),
    probe,
    checked,
    consume: (event: DeliveredEvent) => h.tx.run((tx) => consume(tx, event)),
    async finish(fileId: string, watermark = false) {
      await probe(fileId);
      await this.consume(await checked(fileId));
      if (watermark) {
        const job = await prisma.mediaJob.findFirstOrThrow({
          where: { subjectId: fileId, kind: "watermark_sample" },
        });
        await h.media.jobs.run({ jobId: job.id });
        h.clock.advance(5000);
        await h.media.jobs.run({ jobId: job.id });
      }
    },
    async master(dramaId: string, episodeNo: number, staffId: string) {
      const before = await prisma.dramaEpisodeMaster.findFirst({
        where: { dramaId, episodeNo, isCurrent: true },
      });
      if (before) return before;
      const bytes = new Uint8Array(1234);
      bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
      const file = await h.make.fileObject({
        category: "drama_master",
        bucket: "media",
        ext: "mp4",
        mime: "video/mp4",
        declaredMime: "video/mp4",
        sizeBytes: bytes.length,
        declaredSize: bytes.length,
      });
      const etag = h.fake.storage.put({ bucket: "media", key: file.objectKey }, bytes, "video/mp4");
      await prisma.fileObject.update({ where: { id: file.id }, data: { etag } });
      await probe(file.id);
      return prisma.dramaEpisodeMaster.create({
        data: {
          id: uuidv7(),
          dramaId,
          episodeNo,
          revNo: 1,
          fileId: file.id,
          state: "ready",
          isCurrent: true,
          durationMs: 60_000,
          createdByStaffId: staffId,
          activatedAt: h.clock.now(),
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
    },
    async close() {
      await h.media.jobs.shutdown();
      h.unbind();
      await external.tools.close();
    },
  };
}
export type ProductionHarness = ReturnType<typeof productionHarness>;
