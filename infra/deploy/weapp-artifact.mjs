// 私有上传消费者；所有来源、节点事实和哈希检查完成后才加载微信 SDK。
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateRelease } from "../ci/stg-image-facts.mjs";
import { readRecords } from "./node-record.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function uploadArtifacts(options, upload) {
  const {
    source,
    manifestSha256,
    appid,
    apiBaseUrl,
    imageId,
    artifacts,
    releaseEnv,
    releaseLog,
    key,
  } = options;
  if (
    !/^[a-f0-9]{40}$/.test(source) ||
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    !/^wx[a-f0-9]{16}$/.test(appid) ||
    !/^sha256:[a-f0-9]{64}$/.test(imageId)
  )
    throw Error("上传参数无效");
  const url = new URL(apiBaseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw Error("API来源无效");
  const raw = readFileSync(`${artifacts}/images.json`);
  if (hash(raw) !== manifestSha256) throw Error("发布摘要不符");
  const manifest = validateRelease(JSON.parse(raw), source);
  if (
    manifest.appid !== appid ||
    manifest.apiBaseUrl !== apiBaseUrl ||
    !/^[a-f0-9]{64}$/.test(manifest.weappSha256) ||
    hash(readFileSync(`${artifacts}/weapp.tar.gz`)) !== manifest.weappSha256 ||
    !Object.values(manifest.images["weapp-uploader"]).includes(imageId)
  )
    throw Error("制品或上传器来源不符");
  const state = readFileSync(releaseEnv, "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  if (state.length !== 1 || state[0] !== `LYX_TAG=${manifest.tag}`) throw Error("当前版本不符");
  const last = readRecords(releaseLog).at(-1);
  if (last?.version !== manifest.tag || last.result !== "success" || last.action !== "release")
    throw Error("本次部署未成功");
  const project = `${artifacts}/project`;
  if (
    !statSync(`${project}/app.json`).isFile() ||
    JSON.parse(readFileSync(`${project}/project.config.json`)).appid !== appid
  )
    throw Error("项目来源不符");
  await upload([
    "--upload",
    "--project",
    project,
    "--appid",
    appid,
    "--private-key",
    key,
    "--version",
    manifest.tag,
    "--robot",
    "1",
  ]);
  return { status: "uploaded", source, version: manifest.tag, robot: 1 };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await uploadArtifacts(
      {
        source: process.env.LYX_UPLOAD_SOURCE,
        manifestSha256: process.env.LYX_UPLOAD_MANIFEST_SHA,
        appid: process.env.WEAPP_APPID,
        apiBaseUrl: process.env.WEAPP_API_BASE_URL,
        imageId: process.env.LYX_UPLOADER_IMAGE_ID,
        artifacts: "/artifacts",
        releaseEnv: "/node-release.env",
        releaseLog: "/node-releases.log",
        key: "/run/secrets/weapp-upload-private-key",
      },
      async (args) => {
        const { main } = await import("/app/upload.mjs");
        await main(args, { ...process.env, LYX_WEAPP_UPLOAD_ENABLED: "true" });
      },
    );
    process.stdout.write(`LYX_WEAPP_UPLOAD=${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('LYX_WEAPP_UPLOAD={"status":"failed"}\n');
    process.exitCode = 1;
  }
}
