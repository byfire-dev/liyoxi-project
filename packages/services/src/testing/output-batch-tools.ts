// W302-only assembly: the original guarded factory, workspace and output validation stay in use.
import { assertNotInTransaction } from "../kernel/index.js";
import { createProductionMediaTools } from "../providers/index.js";
import type {
  MediaWorkSession,
  ProbeReport,
  ProductionMediaTools,
  StorageProvider,
} from "../providers/index.js";
import { OutputBatchVideoInputSchema } from "./admin-live/w302.fixture.js";

type Ref = { bucket: string; key: string };
export function createOutputBatchToolsForTest(options: {
  socketPath: string;
  workDir: string;
  storage: StorageProvider;
  rememberDerived(source: Ref, destination: Ref): void;
  bindAttempt(directory: string, signal: AbortSignal): () => void;
  releaseDirectory(directory: string): Promise<void>;
  rememberRenderedPng(ref: Ref, proof: { sha256: string; size: number }): void;
}): ProductionMediaTools {
  const tools = createProductionMediaTools({
    ...options,
    beforeCall: () => assertNotInTransaction("mediatool"),
  });
  const generatedPng = new Map<string, { sha256: string; size: number }>();
  return {
    ...tools,
    client: {
      ...tools.client,
      watermarkPng: tools.client.watermarkPng
        ? async (input) => {
            const result = await tools.client.watermarkPng!(input);
            if (result.ok)
              generatedPng.set(input.outPath, {
                sha256: result.value.sha256,
                size: result.value.sizeBytes,
              });
            return result;
          }
        : undefined,
    },
    workspace: {
      run: (job, signal, action) =>
        tools.workspace.run(job, signal, async (work) => {
          const directory = work.path("source.mp4").split("/")[0]!;
          const unbind = options.bindAttempt(directory, signal);
          let source: Ref | undefined;
          const delegated: MediaWorkSession = {
            ...work,
            async download(input) {
              const result = await work.download(input);
              if (result.ok) source = { bucket: input.bucket, key: input.key };
              return result;
            },
            async publish(input) {
              if (!source) {
                const proof = generatedPng.get(work.path("watermark.png"));
                const digest = /^ci-out\/[0-9a-f-]{36}\/watermark-([a-f0-9]{64})\.png$/.exec(
                  input.dst.key,
                )?.[1];
                if (
                  input.name !== "watermark.png" ||
                  input.dst.bucket !== "media" ||
                  !input.dst.key.startsWith(`ci-out/${job.id}/`) ||
                  !proof ||
                  proof.sha256 !== input.expectedSha256 ||
                  proof.size !== input.expectedSize ||
                  digest !== input.contentIdentity
                )
                  throw new Error(
                    "W302 output lacks an actual downloaded source or exact rendered PNG proof",
                  );
              } else options.rememberDerived(source, input.dst);
              const result = await work.publish(input);
              if (result.ok && input.name === "watermark.png")
                options.rememberRenderedPng(input.dst, {
                  sha256: result.value.sha256,
                  size: result.value.size,
                });
              return result;
            },
          };
          try {
            return await action(delegated);
          } finally {
            try {
              await options.releaseDirectory(directory);
            } finally {
              generatedPng.delete(work.path("watermark.png"));
              unbind();
            }
          }
        }),
      close: () => tools.workspace.close(),
    },
  };
}

/** Only already-existing input masters use this real probe projection; finals are probed by jobs. */
export function outputBatchInputFromProbe(
  input: { path: string; size: number; sha256: string },
  report: ProbeReport,
) {
  const video = report.streams.find(
    (stream) => stream.codecType === "video" && !stream.attachedPic,
  );
  const audio = report.streams.filter((stream) => stream.codecType === "audio"),
    first = audio[0];
  const frameRate = video?.avgFrameRate?.match(/^([1-9][0-9]*)\/([1-9][0-9]*)$/);
  if (
    !video ||
    !first ||
    !frameRate ||
    report.format.sizeBytes !== input.size ||
    report.demuxer !== "mov" ||
    !/^(isom|iso[2-9]|avc1|mp4[12]|M4[AV]|dash)$/.test(report.format.majorBrand?.trim() ?? "")
  )
    throw new Error("W302 real input probe is incomplete");
  return OutputBatchVideoInputSchema.parse({
    path: input.path,
    size: input.size,
    sha256: input.sha256,
    probe: {
      kind: "video",
      container: "mp4",
      durationMs: report.format.durationMs,
      width: video.width,
      height: video.height,
      rotation: video.rotation,
      displayWidth: video.displayWidth,
      displayHeight: video.displayHeight,
      fpsNum: Number(frameRate[1]),
      fpsDen: Number(frameRate[2]),
      vcodec: video.codecName,
      vprofile: video.profile,
      pixFmt: video.pixFmt,
      acodec: first.codecName,
      audioSampleRate: first.sampleRate,
      audioChannels: first.channels,
      audioStreamCount: audio.length,
      bitrateKbps: report.format.bitRate === null ? null : Math.ceil(report.format.bitRate / 1000),
      isFaststart: report.moovBeforeMdat,
      avDriftMs:
        video.durationMs === null || first.durationMs === null
          ? null
          : Math.abs(video.durationMs - first.durationMs),
      aigcMeta: report.aigc === null ? null : JSON.parse(report.aigc),
      probeVersion: 1, // Actual media/handlers/probe saveTechnical implementation version.
      raw: {
        demuxer: report.demuxer,
        formatName: report.format.formatName,
        majorBrand: report.format.majorBrand?.trim() ?? null,
        boxes: report.boxes,
      },
    },
  });
}
