import { failed, ok } from "../types.js";
import type { ObjectRef, ProviderResult } from "../types.js";
import { xmlField } from "./cos-signature.js";

type Reply = { status: number; text: string };
type Request = (
  ref: ObjectRef,
  method: string,
  query: Record<string, string>,
  signal: AbortSignal,
) => Promise<Reply>;
/** 只处理精确key；prefix分页结果中的邻居永不删除，分页不完整不能答复成功。 */
export async function changeCosVersions(
  request: Request,
  input: ObjectRef & { signal: AbortSignal },
  erase: boolean,
): Promise<ProviderResult<void>> {
  const bad = () => failed("unavailable", "对象版本操作未取得完整可验证结果");
  input.signal.throwIfAborted();
  const bucket = { ...input, key: "" };
  const configuration = await request(bucket, "GET", { versioning: "" }, input.signal);
  if (configuration.status !== 200) return bad();
  const versioning = xmlField(configuration.text, "Status");
  if (versioning !== "Enabled" && versioning !== "Suspended") {
    if (versioning !== undefined || !/<VersioningConfiguration[\s/>]/u.test(configuration.text))
      return bad();
    if (!erase || input.bucket !== "pub") return failed("unsupported", "桶未启用所需版本控制");
    const result = await request(input, "DELETE", {}, input.signal);
    if (![200, 204, 404].includes(result.status)) return bad();
    return (await request(input, "HEAD", {}, input.signal)).status === 404 ? ok(undefined) : bad();
  }
  const versions: Array<{ id: string; marker: boolean }> = [];
  let keyMarker = "",
    versionMarker = "",
    complete = false;
  for (let page = 0; page < 20; page++) {
    input.signal.throwIfAborted();
    const reply = await request(
      bucket,
      "GET",
      {
        versions: "",
        prefix: input.key,
        "max-keys": "100",
        ...(keyMarker ? { "key-marker": keyMarker, "version-id-marker": versionMarker } : {}),
      },
      input.signal,
    );
    if (reply.status !== 200 || !/<ListVersionsResult[\s>]/u.test(reply.text)) return bad();
    for (const entry of reply.text.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/gu)) {
      const key = xmlField(entry[2]!, "Key"),
        id = xmlField(entry[2]!, "VersionId");
      if (!key || !id) return bad();
      if (key === input.key) versions.push({ id, marker: entry[1] === "DeleteMarker" });
    }
    const truncated = xmlField(reply.text, "IsTruncated");
    if (truncated === "false") {
      complete = true;
      break;
    }
    const nextKey = xmlField(reply.text, "NextKeyMarker"),
      nextVersion = xmlField(reply.text, "NextVersionIdMarker");
    if (
      truncated !== "true" ||
      !nextKey ||
      !nextVersion ||
      (nextKey === keyMarker && nextVersion === versionMarker)
    )
      return bad();
    keyMarker = nextKey;
    versionMarker = nextVersion;
  }
  if (!complete) return bad();
  if (!erase && !versions.some((v) => !v.marker))
    return failed("rejected", "对象历史版本已不可恢复");
  for (const version of versions.filter((v) => erase || v.marker)) {
    input.signal.throwIfAborted();
    const result = await request(input, "DELETE", { versionId: version.id }, input.signal);
    if (![200, 204, 404].includes(result.status)) return bad();
  }
  const head = await request(input, "HEAD", {}, input.signal);
  return (erase ? head.status === 404 : head.status === 200) ? ok(undefined) : bad();
}
