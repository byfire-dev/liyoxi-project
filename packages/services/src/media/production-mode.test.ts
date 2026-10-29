import { describe, expect, it, vi } from "vitest";
import type { MediaJob } from "@liyoxi/db";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { MediaProvider, MediaToolClient, MediaWorkspace } from "../providers/types.js";
import type { BoundMediaDeps } from "./context.js";
import type { MediaProductionDeps } from "./production-types.js";
import { enqueueDerivation } from "./production.js";
import { enqueueSampleWatermark, enqueueTrailer } from "./production-playables.js";
import { createRestampHandler, finishDerivation } from "./handlers/restamp.js";
import { createCloudProductionHandler } from "./handlers/transcode.js";

const id = "12345678-1234-4234-8234-123456789abc";
function probeOnly(mode: "probe_only" | "local_sample_watermark" = "probe_only") {
  const unexpected = vi.fn((): never => {
    throw new Error("probe_only不得访问派生任务的数据库或外部IO");
  });
  const blocked = new Proxy({}, { get: unexpected });
  const production: MediaProductionDeps = {
    mode,
    config: null,
    tool: blocked as MediaToolClient,
    workspace: blocked as MediaWorkspace,
    cloud: blocked as MediaProvider,
    parameters: unexpected,
    readStoreFacts: unexpected,
  };
  return {
    deps: { production } as BoundMediaDeps,
    tx: blocked as Tx,
    job: { id, subjectId: id } as MediaJob,
    signal: new AbortController().signal,
    unexpected,
  };
}
describe("probe_only制作边界", () => {
  it("所有派生入队入口在数据库写入前拒绝", async () => {
    const h = probeOnly();
    for (const kind of ["restamp", "normalize"] as const)
      await expect(enqueueDerivation(h.deps, h.tx, id, kind)).rejects.toMatchObject({
        error: "PROVIDER_UNAVAILABLE",
      });
    await expect(enqueueSampleWatermark(h.deps, h.tx, id)).rejects.toMatchObject({
      error: "PROVIDER_UNAVAILABLE",
    });
    await expect(
      enqueueTrailer(h.deps, h.tx, { dramaId: id, fileId: id, staffId: id }),
    ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
    expect(h.unexpected).not.toHaveBeenCalled();
  });
  it("已有补标任务不能重试、执行或接受成功派生结果", async () => {
    const h = probeOnly(),
      handler = createRestampHandler(h.deps);
    expect(await handler.canRetry!(h.tx, h.job)).toBe(false);
    expect(await handler.execute(h.job, undefined, h.signal)).toEqual({
      state: "failed",
      failure: { code: "MEDIA_PROVIDER_UNSUPPORTED", retryable: false },
    });
    await expect(
      finishDerivation(
        h.deps,
        h.tx,
        h.job,
        { state: "succeeded", output: null },
        {} as IdentityContext,
      ),
    ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
    expect(h.unexpected).not.toHaveBeenCalled();
  });
  it.each(["transcode_mp4", "watermark_sample", "normalize"] as const)(
    "已有%s任务不能重试、执行、恢复提交或轮询云结果",
    async (kind) => {
      const h = probeOnly(),
        handler = createCloudProductionHandler(h.deps, kind),
        rejected = {
          state: "failed",
          failure: { code: "MEDIA_PROVIDER_UNSUPPORTED", retryable: false },
        };
      expect(await handler.canRetry!(h.tx, h.job)).toBe(false);
      expect(await handler.execute(h.job, undefined, h.signal)).toEqual(rejected);
      expect(await handler.recover!(h.job, h.signal)).toEqual(rejected);
      expect(await handler.poll!(h.job, h.signal)).toEqual(rejected);
      expect(h.unexpected).not.toHaveBeenCalled();
    },
  );
});
describe("本地样片水印不扩大完整制作能力", () => {
  it("补标、规格化和预告片入队在读取数据库或外呼前拒绝", async () => {
    const h = probeOnly("local_sample_watermark");
    for (const kind of ["restamp", "normalize"] as const)
      await expect(enqueueDerivation(h.deps, h.tx, id, kind)).rejects.toMatchObject({
        error: "PROVIDER_UNAVAILABLE",
      });
    await expect(
      enqueueTrailer(h.deps, h.tx, { dramaId: id, fileId: id, staffId: id }),
    ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
    expect(h.unexpected).not.toHaveBeenCalled();
  });
  it("已有补标任务与结果不能在本地样片水印模式执行", async () => {
    const h = probeOnly("local_sample_watermark"),
      handler = createRestampHandler(h.deps);
    expect(await handler.canRetry!(h.tx, h.job)).toBe(false);
    expect(await handler.execute(h.job, undefined, h.signal)).toEqual({
      state: "failed",
      failure: { code: "MEDIA_PROVIDER_UNSUPPORTED", retryable: false },
    });
    await expect(
      finishDerivation(
        h.deps,
        h.tx,
        h.job,
        { state: "succeeded", output: null },
        {} as IdentityContext,
      ),
    ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
    expect(h.unexpected).not.toHaveBeenCalled();
  });
  it.each(["transcode_mp4", "watermark_sample", "normalize"] as const)(
    "已有云%s任务不获得本地模式的外呼能力",
    async (kind) => {
      const h = probeOnly("local_sample_watermark"),
        handler = createCloudProductionHandler(h.deps, kind);
      expect(await handler.canRetry!(h.tx, h.job)).toBe(false);
      expect(await handler.execute(h.job, undefined, h.signal)).toEqual({
        state: "failed",
        failure: { code: "MEDIA_PROVIDER_UNSUPPORTED", retryable: false },
      });
      expect(h.unexpected).not.toHaveBeenCalled();
    },
  );
});
