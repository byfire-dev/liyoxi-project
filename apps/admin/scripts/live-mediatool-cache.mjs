// 只复用与本轮完整构建上下文匹配的工具镜像；媒体字节与业务事实不进入缓存。
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

const imagePattern = /^sha256:[a-f0-9]{64}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const buildTimeout = 30 * 60_000;

function regularFile(path) {
  try {
    if (!lstatSync(path).isFile()) throw new Error(`工具镜像缓存必须为普通文件：${path}`);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function buildLiveMediatool({ imageFile, cacheDirectory, contextDigest, run }) {
  let archive;
  let manifestFile;
  if (cacheDirectory) {
    if (!isAbsolute(cacheDirectory) || !digestPattern.test(contextDigest ?? ""))
      throw new Error("工具镜像缓存需要绝对目录与本轮完整上下文摘要");
    mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
    if (!lstatSync(cacheDirectory).isDirectory()) throw new Error("工具镜像缓存目录不能为链接");
    archive = join(cacheDirectory, "image.tar");
    manifestFile = join(cacheDirectory, "image.json");
    const hasArchive = regularFile(archive);
    const hasManifest = regularFile(manifestFile);
    if (hasArchive !== hasManifest) throw new Error("工具镜像缓存不完整，拒绝继续验收");
    if (hasArchive) {
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      if (
        manifest?.version !== 1 ||
        manifest.contextDigest !== contextDigest ||
        !imagePattern.test(manifest.imageId ?? "")
      )
        throw new Error("工具镜像缓存摘要或镜像 ID 不匹配，拒绝继续验收");
      const cachedImage = manifest.imageId;
      // 精确上下文已核对；load或inspect失败即中止，不把损坏缓存当作成功。
      await run(["load", "--input", archive], { timeout: buildTimeout });
      const loadedImage = await run(["image", "inspect", "--format", "{{.Id}}", cachedImage], {
        capture: true,
      });
      if (loadedImage !== cachedImage) throw new Error("工具镜像缓存恢复后 ID 不一致");
      console.log(`本轮工具镜像 ${cachedImage}（完整上下文匹配的缓存产物，未重新构建）`);
      return cachedImage;
    }
  } else if (contextDigest) {
    throw new Error("工具镜像上下文摘要缺少对应缓存目录");
  }

  await run(["build", "--iidfile", imageFile, "infra/docker/mediatool"], {
    timeout: buildTimeout,
  });
  const image = readFileSync(imageFile, "utf8").trim();
  if (!imagePattern.test(image)) throw new Error("Docker 未返回精确镜像 ID");
  if (cacheDirectory) {
    // 先保存完整镜像再替换缓存；失败时不发布半份 archive 或伪造成功 manifest。
    const pending = mkdtempSync(join(cacheDirectory, ".pending-"));
    try {
      const nextArchive = join(pending, "image.tar");
      const nextManifest = join(pending, "image.json");
      await run(["save", "--output", nextArchive, image], { timeout: buildTimeout });
      if (!regularFile(nextArchive)) throw new Error("Docker 未生成工具镜像缓存");
      writeFileSync(
        nextManifest,
        `${JSON.stringify({ version: 1, contextDigest, imageId: image })}\n`,
      );
      renameSync(nextArchive, archive);
      renameSync(nextManifest, manifestFile);
    } finally {
      rmSync(pending, { recursive: true });
    }
  }
  if (cacheDirectory) console.log(`本轮工具镜像 ${image}（冷缓存按当前Dockerfile构建）`);
  return image;
}
