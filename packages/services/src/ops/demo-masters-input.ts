// 显式演示原片输入；manifest 只绑定输入字节，绝不替代媒体流水线的探针与检查结果。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "@liyoxi/contract";
import { createIdempotencyContext } from "../kernel/index.js";
import type { Clock, Env, TxRunner } from "../kernel/index.js";
import type { Content, ContentDemoDeps } from "../content/index.js";
import type { Media } from "../media/index.js";
import type { StorageProvider } from "../providers/types.js";
import { loadCliStaffContext } from "../staff/index.js";

interface DemoMasterRuntime {
  env: Pick<Env, "APP_ENV" | "MEDIA_PRODUCTION">;
  tx: TxRunner;
  clock: Clock;
  providers: { storage: StorageProvider };
  media: Pick<Media, "uploadBatches" | "jobs">;
  content: Pick<Content, "mediaReadiness">;
}

const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const ManifestSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        size: z.int().positive().max(MAX_VIDEO_BYTES),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        checks: z.object({
          duration: z.literal(true),
          video: z.literal(true),
          audio: z.literal(true),
          faststart: z.literal(true),
          serviceDuration: z.literal(true),
          size: z.literal(true),
        }),
      }),
    )
    .min(1)
    .max(10),
});
export class DemoMasterInputError extends Error {
  constructor(message: string) {
    super(`演示原片：${message}`);
    this.name = "DemoMasterInputError";
  }
}
export interface DemoMasterInput {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}
export function parseDemoMasterArgs(args: readonly string[]) {
  if (args.length === 0) return undefined;
  if (args.length === 1 && args[0] === "--help") return "help";
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      !["--video", "--probe-facts"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      values.has(key)
    )
      throw new DemoMasterInputError("只接受成对且不重复的 --video 与 --probe-facts");
    values.set(key, value);
  }
  const video = values.get("--video"),
    facts = values.get("--probe-facts");
  if (!video || !facts) throw new DemoMasterInputError("--video 与 --probe-facts 必须同时提供");
  return { video, facts };
}
async function regular(path: string, maximum: number) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > maximum)
    throw new DemoMasterInputError("输入必须是上限内的普通非空文件");
  return stat;
}
/** 在运行器写任何演示内容前执行；所有文件系统错误投影为不带路径的诊断。 */
export async function readDemoMasterInput(input: {
  video: string;
  facts: string;
}): Promise<DemoMasterInput> {
  try {
    const path = resolve(input.video),
      factsPath = resolve(input.facts);
    const before = await regular(path, MAX_VIDEO_BYTES);
    await regular(factsPath, MAX_MANIFEST_BYTES);
    const handle = await open(factsPath, "r");
    let bytes: Buffer;
    try {
      bytes = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
      const read = await handle.read(bytes, 0, bytes.length, 0);
      bytes = bytes.subarray(0, read.bytesRead);
      if (bytes.length > MAX_MANIFEST_BYTES) throw new DemoMasterInputError("输入清单超过上限");
    } finally {
      await handle.close();
    }
    const parsed = ManifestSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success) throw new DemoMasterInputError("输入清单格式或合法性观测不完整");
    const matches = parsed.data.results.filter((row) => row.name === basename(path));
    if (matches.length !== 1) throw new DemoMasterInputError("输入清单必须唯一匹配视频文件名");
    const fact = matches[0]!;
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
      if (!(chunk instanceof Uint8Array)) throw new DemoMasterInputError("视频流类型不合格");
      size += chunk.length;
      if (size > MAX_VIDEO_BYTES) throw new DemoMasterInputError("视频超过大小上限");
      hash.update(chunk);
    }
    const after = await regular(path, MAX_VIDEO_BYTES);
    if (
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size ||
      size !== fact.size ||
      size !== before.size ||
      hash.digest("hex") !== fact.sha256
    )
      throw new DemoMasterInputError("视频字节与输入清单不匹配或读取时发生变化");
    return Object.freeze({ path, size, sha256: fact.sha256 });
  } catch (error) {
    if (error instanceof DemoMasterInputError) throw error;
    throw new DemoMasterInputError("无法读取或验证显式视频输入");
  }
}
/** 只驱动本次创建/复用批次的真实任务；不扫描其他业务数据，不写入检查/媒体事实。 */
export function createDemoMasterInputPreparer(
  runtime: DemoMasterRuntime,
  input: DemoMasterInput,
  signal: AbortSignal,
): NonNullable<ContentDemoDeps["prepareMasters"]> {
  if (runtime.env.APP_ENV === "prod" || !runtime.env.MEDIA_PRODUCTION)
    throw new DemoMasterInputError("需要非生产环境的完整媒体工具配置");
  return async (target) => {
    signal.throwIfAborted();
    const staff = await runtime.tx.run((tx) => loadCliStaffContext(tx, target.staffId));
    const actor = { identity: target.identity, staff };
    const hasCurrent = await runtime.tx.run((tx) =>
      tx.dramaEpisodeMaster.count({
        where: { dramaId: target.dramaId, isCurrent: true },
      }),
    );
    const body = {
      purpose: "drama_master",
      targetId: target.dramaId,
      scope: "full",
      replaceReason: hasCurrent ? "quality_fix" : null,
      isContentChanged: false,
      note: "显式合法视频演示输入；每集由真实流水线检查",
      files: Array.from({ length: target.totalEpisodes }, (_, i) => ({
        clientToken: `demo-episode-${i + 1}`,
        originalName: `第${i + 1}集.mp4`,
        sizeBytes: String(input.size),
      })),
    };
    const idem = createIdempotencyContext({
      mode: "required",
      scope: "admin.uploadBatch.create",
      actor: target.identity.actor,
      key: `demo-master:${target.dramaId}:${input.sha256}`,
      request: { method: "POST", body },
    });
    let batch = await runtime.media.uploadBatches.create(actor, body, { idem });
    if (batch.state === "matching")
      batch = await runtime.media.uploadBatches.start(actor, batch.uploadBatchId, {});
    if (!["uploading", "verifying", "ready", "committed"].includes(batch.state))
      throw new DemoMasterInputError("已有演示批次不能继续，请按真实失败状态处理");
    for (const item of batch.items) {
      signal.throwIfAborted();
      if (item.state !== "pending") continue;
      if (!item.uploadKey || !item.uploadKey.startsWith(batch.prefix))
        throw new DemoMasterInputError("上传目标与当前批次不匹配");
      const written = await runtime.providers.storage.putStream({
        bucket: "media",
        key: item.uploadKey,
        size: input.size,
        sha256: input.sha256,
        contentIdentity: `demo-master:${input.sha256}`,
        contentType: "video/mp4",
        ifAbsent: true,
        signal,
        body: async function* (ownedSignal) {
          for await (const chunk of createReadStream(input.path, {
            highWaterMark: 1024 * 1024,
            signal: ownedSignal,
          })) {
            if (!(chunk instanceof Uint8Array)) throw new DemoMasterInputError("视频流类型不合格");
            yield chunk;
          }
        },
      });
      if (!written.ok) throw new DemoMasterInputError(`原片写入未完成（${written.reason}）`);
      await runtime.media.uploadBatches.complete(actor, item.uploadBatchItemId, {});
    }
    // 原任务自己的 deadline/lease/重试规则决定能否继续，不用等待循环伪造 ready。
    while (true) {
      signal.throwIfAborted();
      batch = await runtime.media.uploadBatches.get(actor, batch.uploadBatchId);
      if (batch.state === "committed") break;
      if (batch.state === "ready") {
        await runtime.media.uploadBatches.commit(actor, batch.uploadBatchId, {});
        break;
      }
      if (
        batch.items.some((item) => item.state === "rejected") ||
        ["failed", "expired", "canceled"].includes(batch.state)
      )
        throw new DemoMasterInputError("原片流水线明确拒绝或批次已终止");
      const jobs = await runtime.tx.run((tx) =>
        tx.mediaJob.findMany({
          where: {
            parentType: "upload_batch",
            parentId: batch.uploadBatchId,
            state: { in: ["queued", "running", "submitting", "submitted"] },
            nextRunAt: { lte: runtime.clock.now() },
          },
          select: { id: true },
          orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
        }),
      );
      if (!jobs.length)
        throw new DemoMasterInputError("原片尚未就绪；保留真实批次供正常 worker 恢复");
      for (const job of jobs) {
        signal.throwIfAborted();
        await runtime.media.jobs.run({ jobId: job.id });
      }
    }
    const ready = await runtime.tx.run((tx) => runtime.content.mediaReadiness(tx, target.dramaId));
    if (!ready.mastersReady)
      throw new DemoMasterInputError("批次提交后原片仍未通过当前真实 readiness");
  };
}
