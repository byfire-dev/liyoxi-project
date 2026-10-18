// Task-private native-cloud double: sample bytes are rendered by the pinned codec, then re-probed.
import { createHash } from "node:crypto";
import type { Runtime, RuntimeOptions } from "@liyoxi/services";
import type { createOutputBatchMediaToolRelay } from "./upload-batch-live-mediatool.js";
type Storage = Runtime["providers"]["storage"];
type Ref = Parameters<Storage["head"]>[0];
const rejected = (message: string) => ({
  ok: false as const,
  reason: "rejected" as const,
  message,
});
export function attachOutputBatchLiveCloud(options: {
  media: Runtime["providers"]["media"];
  storage: Storage;
  tools: NonNullable<RuntimeOptions["mediaProductionTools"]>;
  relay: Awaited<ReturnType<typeof createOutputBatchMediaToolRelay>>;
  storeIds: readonly string[];
  trailer?: (
    input: Parameters<Runtime["providers"]["media"]["transcode"]>[0],
    original: Runtime["providers"]["media"]["transcode"],
  ) => ReturnType<Runtime["providers"]["media"]["transcode"]>;
  pngProof(ref: Ref): { size: number; sha256: string } | undefined;
}) {
  const original = options.media.transcode;
  options.media.transcode = async (input) => {
    if (!input.watermarks?.length) return original(input);
    if (input.watermarks.some((mark) => "templateId" in mark) && options.trailer)
      return options.trailer(input, original);
    const [id, attempt, extra] = input.userData.split(":"),
      mark = input.watermarks[0];
    if (
      !id ||
      !/^[0-9a-f-]{36}$/.test(id) ||
      !attempt ||
      !/^[1-9][0-9]{0,5}$/.test(attempt) ||
      extra ||
      !input.signal ||
      input.watermarks.length !== 1 ||
      !mark ||
      !("image" in mark) ||
      mark.position !== "Center" ||
      mark.transparency !== 30 ||
      input.src.bucket !== "media" ||
      !options.storeIds.some((store) =>
        new RegExp(`^sample_video/${store}/[0-9a-f-]{36}\\.mp4$`).test(input.src.key),
      ) ||
      mark.image.bucket !== "media" ||
      !new RegExp(`^ci-out/${id}/watermark-[a-f0-9]{64}\\.png$`).test(mark.image.key) ||
      input.dst.bucket !== "media" ||
      !/^ci-out\/[0-9a-f-]{36}\/output\.mp4$/.test(input.dst.key)
    )
      return rejected("W307 sample cloud input is outside its exact owned scope");
    const signal = input.signal,
      proof = options.pngProof(mark.image);
    const source = await options.storage.head({ ...input.src, signal }),
      pngHead = await options.storage.head({ ...mark.image, signal });
    if (
      !source.ok ||
      !pngHead.ok ||
      !source.value.exists ||
      !source.value.etag ||
      source.value.size < 1 ||
      source.value.size > 200 * 1024 * 1024 ||
      !pngHead.value.exists ||
      !pngHead.value.etag ||
      !proof ||
      proof.size !== pngHead.value.size ||
      proof.size < 8 ||
      proof.size > 1024 * 1024
    )
      return rejected("W307 sample cloud source/PNG proof is missing");
    const chunks: Uint8Array[] = [];
    const png = await options.storage.readTo({
      ...mark.image,
      expectedSize: proof.size,
      maxBytes: 1024 * 1024,
      ifMatchEtag: pngHead.value.etag,
      signal,
      sink: async (bytes) => {
        chunks.push(Uint8Array.from(bytes));
      },
    });
    if (!png.ok || png.value.sha256 !== proof.sha256 || png.value.size !== proof.size)
      return rejected("W307 actual PNG bytes differ from the rendered proof");
    try {
      const published = await options.tools.workspace.run(
        { id, attemptNo: Number(attempt) },
        signal,
        async (work) => {
          const downloaded = await work.download({
            ...input.src,
            size: source.value.size,
            etag: source.value.etag!,
          });
          if (!downloaded.ok) return downloaded;
          await options.relay.renderSample({
            path: work.path("source.mp4"),
            outPath: work.path("stamped.mp4"),
            png: Buffer.concat(chunks),
            signal,
          });
          return work.publish({
            name: "stamped.mp4",
            dst: input.dst,
            contentIdentity: createHash("sha256")
              .update(`${downloaded.value.sha256}:${proof.sha256}`)
              .digest("hex"),
          });
        },
      );
      if (!published.ok) return published;
      // The existing fake only supplies a queryable cloud job identity after real rendering/storage.
      return original(input);
    } catch {
      return {
        ok: false,
        reason: "unavailable",
        message: "W307 owned sample render did not complete",
      };
    }
  };
  return {
    close() {
      options.media.transcode = original;
    },
  };
}
