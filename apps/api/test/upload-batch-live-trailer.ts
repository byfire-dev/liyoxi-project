// W312-only native cloud adapter. Production jobs still own probe, rendition and installation.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Runtime, RuntimeOptions } from "@liyoxi/services";
import { assertContentAdminLiveTargets } from "@liyoxi/services/testing";
import type { ContentAdminLiveScope } from "@liyoxi/services/testing";

type Input = Parameters<Runtime["providers"]["media"]["transcode"]>[0];
type Transcode = Runtime["providers"]["media"]["transcode"];
const rejected = (message: string) => ({
  ok: false as const,
  reason: "rejected" as const,
  message,
});
const playableInput = z.strictObject({
  fileId: z.uuid(),
  playableAssetId: z.uuid(),
  destinationFileId: z.uuid(),
  quality: z.enum(["sd", "hd"]),
  objectKey: z.string().regex(/^t\/[0-9a-f-]{36}\/[a-f0-9]{16}\/(?:sd|hd)\.mp4$/),
  scratchKey: z.string().regex(/^ci-out\/[0-9a-f-]{36}\/output\.mp4$/),
  template: z.enum(["test_sd", "test_hd"]),
  specVersion: z.number().int().min(1).max(32767),
  aiUsed: z.boolean(),
  watermarks: z
    .array(z.strictObject({ templateId: z.enum(["test_brand", "test_ai"]) }))
    .min(1)
    .max(2),
});
/** Fixed mappings of this fixture's test templates; these are not real vendor template evidence. */
export function trailerEncoding(quality: "sd" | "hd", ai: boolean) {
  const width = quality === "sd" ? 480 : 720,
    height = quality === "sd" ? 854 : 1280;
  const text = (value: string, position: string, aiMark = false) =>
    `drawtext=fontfile=/app/fonts/NotoSansCJKsc-Regular.otf:text='${value}':expansion=none:fontsize=${Math.ceil(width * (aiMark ? 0.06 : 0.05))}:fontcolor=${aiMark ? "white" : "white@0.7"}:${position}`;
  return {
    filter: `[0:v]scale=${width}:${height},setsar=1,${text("狸有戏", "x=w-text_w-16:y=16")}${ai ? `,${text("AI 生成", "x=16:y=h-text_h-16", true)}` : ""}[out]`,
    profile: quality === "sd" ? "main" : "high",
    videoBitrate: quality === "sd" ? "700k" : "1500k",
    audioBitrate: quality === "sd" ? "64k" : "96k",
  };
}
export function parseTrailerSubmission(input: Input) {
  const match = /^([0-9a-f-]{36}):([1-9][0-9]{0,5})$/.exec(input.userData);
  if (
    !match ||
    !z.uuid().safeParse(match[1]).success ||
    !input.signal ||
    input.src.bucket !== "media" ||
    !/^trailer_src\/platform\/[0-9a-f-]{36}\.mp4$/.test(input.src.key) ||
    input.dst.bucket !== "media" ||
    input.dst.key !== `ci-out/${match[1]}/output.mp4`
  )
    return null;
  return { id: match[1]!, attemptNo: Number(match[2]) };
}
export function matchesTrailerInput(input: Input, raw: unknown) {
  const parsed = playableInput.safeParse(raw);
  if (!parsed.success) return null;
  const value = parsed.data;
  if (
    input.template !== `test_${value.quality}` ||
    value.template !== input.template ||
    value.scratchKey !== input.dst.key ||
    JSON.stringify(value.watermarks) !== JSON.stringify(input.watermarks) ||
    JSON.stringify(value.watermarks) !==
      JSON.stringify([
        { templateId: "test_brand" },
        ...(value.aiUsed ? [{ templateId: "test_ai" }] : []),
      ])
  )
    return null;
  return value;
}
export function createContentTrailerCloud(options: {
  runtime(): Runtime;
  scope: ContentAdminLiveScope;
  registeredIds(): readonly string[];
  storage: Runtime["providers"]["storage"];
  tools: NonNullable<RuntimeOptions["mediaProductionTools"]>;
  relay: {
    renderTrailer(input: {
      path: string;
      outPath: string;
      quality: "sd" | "hd";
      ai: boolean;
      signal: AbortSignal;
    }): Promise<void>;
  };
}) {
  return async (input: Input, original: Transcode): ReturnType<Transcode> => {
    const submission = parseTrailerSubmission(input);
    if (!submission) return rejected("W312 trailer submission is outside its exact scope");
    const runtime = options.runtime(),
      scope = await assertContentAdminLiveTargets(runtime, options.scope);
    const registered = options.registeredIds();
    if (registered.length > 100 || !registered.every((id) => z.uuid().safeParse(id).success))
      return rejected("W312 registered trailer set is not bounded");
    const facts = await runtime.tx.run(async (tx) => {
      const job = await tx.mediaJob.findUnique({ where: { id: submission.id } });
      const value = job && matchesTrailerInput(input, job.input);
      if (
        !job ||
        !value ||
        job.kind !== "transcode_mp4" ||
        job.mode !== "remote" ||
        job.provider !== runtime.providers.media.status ||
        job.state !== "submitting" ||
        job.attemptNo !== submission.attemptNo ||
        job.subjectType !== "file_object" ||
        job.subjectId !== value.fileId ||
        job.parentType !== "playable_asset" ||
        job.parentId !== value.playableAssetId ||
        job.createdAt < new Date(scope.startedAt) ||
        !registered.includes(value.fileId) ||
        job.dedupeKey !==
          `transcode_mp4:${value.playableAssetId}:${value.quality}:v${value.specVersion}`
      )
        return null;
      const [file, asset] = await Promise.all([
        tx.fileObject.findUnique({ where: { id: value.fileId } }),
        tx.playableAsset.findUnique({ where: { id: value.playableAssetId } }),
      ]);
      if (
        !file ||
        !asset ||
        file.category !== "trailer_src" ||
        file.scopeType !== "platform" ||
        file.status !== "stored" ||
        file.moderationState === "block" ||
        file.uploadClient !== "admin" ||
        file.uploadActorType !== "staff" ||
        file.uploadActorId !== scope.uploaderId ||
        file.createdAt < new Date(scope.startedAt) ||
        file.bucket !== input.src.bucket ||
        file.objectKey !== input.src.key ||
        !file.sha256 ||
        !file.sizeBytes ||
        file.sizeBytes < 1n ||
        file.sizeBytes > 200n * 1024n * 1024n ||
        asset.kind !== "trailer" ||
        asset.ownerType !== "drama" ||
        !scope.dramaIds.includes(asset.ownerId) ||
        asset.sourceFileId !== file.id ||
        asset.specVersion !== value.specVersion ||
        asset.state !== "processing"
      )
        return null;
      const [drama, pointer] = await Promise.all([
        tx.drama.findUnique({ where: { id: asset.ownerId } }),
        tx.dramaTrailer.findUnique({ where: { dramaId: asset.ownerId } }),
      ]);
      if (
        !drama ||
        drama.archivedAt ||
        pointer?.targetPlayableAssetId !== asset.id ||
        drama.isAiGenerated !== value.aiUsed ||
        !value.objectKey.startsWith(`t/${drama.id}/`) ||
        !value.objectKey.endsWith(`/${value.quality}.mp4`)
      )
        return null;
      return { value, size: Number(file.sizeBytes), sha256: file.sha256 };
    });
    if (!facts) return rejected("W312 trailer source/job/asset provenance does not match");
    const signal = input.signal!;
    const head = await options.storage.head({ ...input.src, signal });
    if (!head.ok || !head.value.exists || !head.value.etag || head.value.size !== facts.size)
      return rejected("W312 trailer actual source bytes are missing");
    const published = await options.tools.workspace
      .run(submission, signal, async (work) => {
        const downloaded = await work.download({
          ...input.src,
          size: facts.size,
          etag: head.value.etag!,
        });
        if (!downloaded.ok) return downloaded;
        if (downloaded.value.size !== facts.size || downloaded.value.sha256 !== facts.sha256)
          return rejected("W312 trailer downloaded source differs from the stored SHA/size");
        await options.relay.renderTrailer({
          path: work.path("source.mp4"),
          outPath: work.path("stamped.mp4"),
          quality: facts.value.quality,
          ai: facts.value.aiUsed,
          signal,
        });
        return work.publish({
          name: "stamped.mp4",
          dst: input.dst,
          contentIdentity: createHash("sha256")
            .update(JSON.stringify([facts.sha256, input.template, input.watermarks]))
            .digest("hex"),
        });
      })
      .catch(() => null);
    if (!published || signal.aborted)
      return {
        ok: false,
        reason: "unavailable",
        message: "W312 owned native trailer render did not complete",
      };
    if (!published.ok) return published;
    // The fake supplies only identity; production re-probes these real bytes and installs both renditions.
    return original(input);
  };
}
