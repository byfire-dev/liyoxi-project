// 提审专用消费者：冻结、版本绑定与同源事实全过后才加载机器人2。
import { fileURLToPath } from "node:url";
import { validateUploadArtifacts } from "./weapp-artifact.mjs";

export const REVIEW_TAG = /^weapp-v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;

export async function uploadReviewArtifacts(options, upload) {
  if (options.enabled !== "true" || options.freeze !== "true" || !REVIEW_TAG.test(options.tag))
    throw Error("提审上传须已启用、冻结并绑定合法版本标签");
  const facts = validateUploadArtifacts(options);
  const version = options.tag.slice("weapp-v".length);
  await upload({ project: facts.project, appid: facts.appid, key: facts.key, version });
  return {
    status: "uploaded",
    source: facts.source,
    tag: options.tag,
    version,
    clientVersion: facts.version,
    robot: 2,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await uploadReviewArtifacts(
      {
        source: process.env.LYX_UPLOAD_SOURCE,
        manifestSha256: process.env.LYX_UPLOAD_MANIFEST_SHA,
        tag: process.env.LYX_REVIEW_TAG,
        enabled: process.env.LYX_WEAPP_UPLOAD_ENABLED,
        freeze: process.env.STG_FREEZE,
        appid: process.env.WEAPP_APPID,
        apiBaseUrl: process.env.WEAPP_API_BASE_URL,
        imageId: process.env.LYX_UPLOADER_IMAGE_ID,
        artifacts: "/artifacts",
        releaseEnv: "/node-release.env",
        releaseLog: "/node-releases.log",
        key: "/run/secrets/weapp-upload-private-key",
      },
      async (options) => {
        const { uploadReview } = await import("./review-upload-sdk.mjs");
        await uploadReview(options);
      },
    );
    process.stdout.write(`LYX_WEAPP_REVIEW_UPLOAD=${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('LYX_WEAPP_REVIEW_UPLOAD={"status":"failed"}\n');
    process.exitCode = 1;
  }
}
