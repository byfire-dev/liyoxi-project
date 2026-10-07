#!/usr/bin/env node
// W2-25b 私有制品事实：固定 registry → linux/amd64 manifest → config，兼容两种 Docker store 的 .Id。
// Docker --raw 保留原字节：https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const SHA = /^sha256:[a-f0-9]{64}$/;
const NAMES = ["gateway", "mediatool", "server", "weapp-uploader"];
const FIELDS = ["amd64ConfigDigest", "amd64ManifestDigest", "registryDigest"];
const MANIFEST = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];
const INDEX = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
];
const CONFIG = [
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
];
const hash = (raw) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
const invalid = () => {
  throw new Error("镜像制品事实无效");
};
function sameKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === keys.join()
  );
}
export function validateRelease(value, expectedSha) {
  if (
    !/^[a-f0-9]{40}$/.test(expectedSha) ||
    value?.source !== expectedSha ||
    value.tag !== `sha-${expectedSha.slice(0, 12)}` ||
    !sameKeys(value.images, NAMES)
  )
    invalid();
  for (const fact of Object.values(value.images))
    if (
      !sameKeys(fact, FIELDS) ||
      Object.values(fact).some((d) => typeof d !== "string" || !SHA.test(d))
    )
      invalid();
  return value;
}
export function assertNodeImages(release, stdout) {
  validateRelease(release, release?.source);
  const rows = stdout.split("\n").filter((line) => line.startsWith("LYX_IMAGE="));
  if (rows.length !== 3) invalid();
  const seen = new Set();
  for (const row of rows) {
    const match = /^LYX_IMAGE=(server|gateway|mediatool)\|(sha256:[a-f0-9]{64})$/.exec(row);
    if (!match || seen.has(match[1]) || !Object.values(release.images[match[1]]).includes(match[2]))
      invalid();
    seen.add(match[1]);
  }
}
function inspect(ref, ...args) {
  const result = spawnSync("docker", ["buildx", "imagetools", "inspect", ref, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) invalid();
  return result.stdout;
}
function rawManifest(repository, digest) {
  if (!SHA.test(digest)) invalid();
  const raw = inspect(`${repository}@${digest}`, "--raw");
  if (hash(raw) !== digest) invalid();
  const value = JSON.parse(raw);
  if (value.schemaVersion !== 2) invalid();
  return value;
}
export function collectImageFact(target) {
  if (!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9][a-z0-9/_-]*:(?:sha-[a-f0-9]{12})$/.test(target))
    invalid();
  const repository = target.slice(0, target.lastIndexOf(":"));
  const registryDigest = inspect(target, "--format", "{{.Manifest.Digest}}").trim();
  let manifest = rawManifest(repository, registryDigest),
    amd64ManifestDigest = registryDigest;
  if (INDEX.includes(manifest.mediaType)) {
    if (!Array.isArray(manifest.manifests)) invalid();
    const candidates = manifest.manifests.filter(
      (m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64",
    );
    if (candidates.length !== 1 || !MANIFEST.includes(candidates[0].mediaType)) invalid();
    amd64ManifestDigest = candidates[0].digest;
    manifest = rawManifest(repository, amd64ManifestDigest);
  }
  if (
    !MANIFEST.includes(manifest.mediaType) ||
    !CONFIG.includes(manifest.config?.mediaType) ||
    !SHA.test(manifest.config?.digest)
  )
    invalid();
  const image = JSON.parse(
    inspect(`${repository}@${amd64ManifestDigest}`, "--format", "{{json .Image}}"),
  );
  if (image.os !== "linux" || image.architecture !== "amd64") invalid();
  return { registryDigest, amd64ManifestDigest, amd64ConfigDigest: manifest.config.digest };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) invalid();
    console.log(JSON.stringify(collectImageFact(process.argv[2])));
  } catch {
    console.error("镜像制品事实采集失败");
    process.exitCode = 2;
  }
}
