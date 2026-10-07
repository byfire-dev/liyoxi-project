// M3 在线探测仍留桩；这里仅给 M1 隔离演示安装固定 MP4 的实测事实。
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isUuid, lockRows } from "../kernel/index.js";
import type { Runtime } from "../runtime.js";
import type { FakeProviders } from "./providers/index.js";
import type { M1MediaScope } from "./m1-types.js";

const FACTS = {
  sha256: "201115661100985c0f01c470f60f2fba5eb36ef53721cb640e657f5727c578fb",
  sizeBytes: 17212,
  durationMs: 2000,
  width: 1080,
  height: 1920,
  videoCodec: "h264",
  hasAudio: false,
} as const;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function guard(ok: unknown): asserts ok {
  if (!ok) throw new Error("M1 固定媒体事实与本轮文件归属不一致");
}
export async function m1Video() {
  const bytes = await readFile(new URL("./m1-known.mp4", import.meta.url));
  guard(bytes.length === FACTS.sizeBytes && digest(bytes) === FACTS.sha256);
  return { ...FACTS, bytes: new Uint8Array(bytes) };
}
export async function installM1KnownMedia(
  runtime: Runtime,
  providers: FakeProviders,
  runId: string,
  fileId: string,
  scope: M1MediaScope,
) {
  guard(
    [
      fileId,
      scope.entityId,
      scope.storeId,
      scope.orderId,
      scope.orderItemId,
      scope.deliveryTicketId,
      scope.uploaderId,
      scope.merchantUserId,
    ].every(isUuid),
  );
  await runtime.tx.run(async (tx) => {
    await lockRows(tx, "staff", [scope.uploaderId]);
    await lockRows(tx, "entity", [scope.entityId]);
    await lockRows(tx, "store", [scope.storeId]);
    await lockRows(tx, "drama_order", [scope.orderId]);
    await lockRows(tx, "order_item", [scope.orderItemId]);
    await lockRows(tx, "delivery_ticket", [scope.deliveryTicketId]);
    await lockRows(tx, "production_record", [fileId]);
    const lockedJobs = await tx.mediaJob.findMany({
      where: { subjectId: fileId, kind: "promote" },
      select: { id: true },
    });
    await lockRows(
      tx,
      "media_job",
      lockedJobs.map((job) => job.id),
    );
    await lockRows(tx, "file_object", [fileId]);
    const [file, record, item, ticket, member, staff, jobs] = await Promise.all([
      tx.fileObject.findUniqueOrThrow({ where: { id: fileId } }),
      tx.productionRecord.findUniqueOrThrow({ where: { fileId } }),
      tx.orderItem.findUniqueOrThrow({ where: { id: scope.orderItemId } }),
      tx.deliveryTicket.findUniqueOrThrow({ where: { id: scope.deliveryTicketId } }),
      tx.entityMember.findFirst({
        where: {
          entityId: scope.entityId,
          merchantUserId: scope.merchantUserId,
          role: "owner",
          status: "active",
        },
      }),
      tx.staff.findFirst({ where: { id: scope.uploaderId, status: "active" } }),
      tx.mediaJob.findMany({ where: { subjectId: fileId, kind: "promote" } }),
    ]);
    const category = scope.category;
    guard(
      member &&
        staff &&
        file.category === category &&
        file.scopeType === "store" &&
        file.entityId === scope.entityId &&
        file.storeId === scope.storeId &&
        file.uploadActorType === "staff" &&
        file.uploadActorId === scope.uploaderId &&
        file.uploadClient === "admin" &&
        file.status === "stored" &&
        file.sizeBytes === BigInt(FACTS.sizeBytes) &&
        file.declaredSize === BigInt(FACTS.sizeBytes) &&
        file.mime === "video/mp4" &&
        file.declaredMime === "video/mp4" &&
        file.ext === "mp4" &&
        file.storedAt &&
        file.objectKey &&
        !file.objectKey.startsWith("incoming/") &&
        item.entityId === scope.entityId &&
        item.storeId === scope.storeId &&
        item.dramaOrderId === scope.orderId &&
        ticket.entityId === scope.entityId &&
        ticket.storeId === scope.storeId &&
        ticket.dramaOrderId === scope.orderId &&
        ticket.orderItemId === item.id &&
        record.orderItemId === item.id &&
        record.kind === (category === "sample_video" ? "sample" : "final") &&
        record.episodeNo === (category === "sample_video" ? 1 : scope.episodeNo) &&
        record.source === "manual_upload" &&
        record.variant === "common" &&
        record.uploadedByStaffId === scope.uploaderId &&
        record.aigcState === "not_required" &&
        (record.aiUsage as { used?: unknown }).used === false &&
        record.pipelineState === "uploading" &&
        jobs.length === 1 &&
        jobs[0]?.state === "succeeded" &&
        jobs[0].subjectType === "file_object" &&
        jobs[0].dedupeKey === `promote:${fileId}`,
    );
    const filename = file.objectKey.split("/").at(-1);
    guard(
      filename &&
        /^[0-9a-f-]{36}\.mp4$/.test(filename) &&
        file.objectKey === `${category}/${scope.storeId}/${filename}` &&
        (file.incomingKey === null || file.incomingKey === `incoming/${fileId}/${filename}`),
    );
    const object = providers.storage.objects.get(`${file.bucket}/${file.objectKey}`);
    guard(
      object &&
        object.mime === "video/mp4" &&
        object.etag === file.etag &&
        object.body.length === FACTS.sizeBytes &&
        digest(object.body) === FACTS.sha256,
    );
    guard(!(await tx.mediaInfo.findUnique({ where: { fileId } })));
    const now = runtime.clock.now();
    await tx.mediaInfo.create({
      data: {
        fileId,
        kind: "video",
        container: "mp4",
        durationMs: FACTS.durationMs,
        width: FACTS.width,
        height: FACTS.height,
        rotation: 0,
        displayWidth: FACTS.width,
        displayHeight: FACTS.height,
        fpsNum: 12,
        fpsDen: 1,
        vcodec: FACTS.videoCodec,
        vprofile: "Constrained Baseline",
        pixFmt: "yuv420p",
        isFaststart: true,
        audioStreamCount: 0,
        probeVersion: 1,
        raw: {
          fixture: "M1 fixed MP4 measured by local ffprobe; online probing remains M3",
          runId,
          sha256: FACTS.sha256,
          sizeBytes: FACTS.sizeBytes,
          uploaderId: scope.uploaderId,
          orderItemId: item.id,
          deliveryTicketId: ticket.id,
        },
        probedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  });
}
