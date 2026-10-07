// CI私有消费者：仅在部署步骤成功后调用，节点仍重新核验全部事实。
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createChannel } from "./orchestrate.mjs";
import { validateRelease } from "../ci/stg-image-facts.mjs";
import { fileURLToPath } from "node:url";
export function uploadRelease(env, channel) {
  if (env.STG_WEAPP_UPLOAD_ENABLED !== "true") return { status: "skipped", reason: "disabled" };
  if (env.STG_FREEZE === "true") throw Error("预发已冻结");
  const raw = readFileSync(`${env.RUNNER_TEMP}/images-release/images.json`);
  const manifest = validateRelease(JSON.parse(raw), env.EXPECTED_SHA);
  const result = channel("weapp-upload", [
    manifest.source,
    createHash("sha256").update(raw).digest("hex"),
  ]);
  const rows = result.stdout.split("\n").filter((row) => row.startsWith("LYX_WEAPP_UPLOAD="));
  if (result.status !== 0 || rows.length !== 1) throw Error("节点上传失败");
  const value = JSON.parse(rows[0].slice("LYX_WEAPP_UPLOAD=".length));
  if (value.status === "skipped" && value.reason === "disabled_or_bucket_unconfigured")
    return { status: "skipped", reason: value.reason, source: manifest.source };
  if (
    value.status !== "uploaded" ||
    value.source !== manifest.source ||
    value.version !== manifest.tag ||
    value.robot !== 1
  )
    throw Error("节点上传结果无效");
  return { status: "uploaded", source: manifest.source, version: manifest.tag, robot: 1 };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let summary;
  try {
    summary = uploadRelease(process.env, (step, args) =>
      createChannel({ node: `${process.env.STG_NODE_USER}@${process.env.STG_NODE_HOST}` })(
        step,
        args,
      ),
    );
  } catch {
    summary = { status: "failed" };
    process.exitCode = 1;
  }
  const json = JSON.stringify(summary);
  writeFileSync(`${process.env.RUNNER_TEMP}/weapp-upload-summary.json`, json + "\n");
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### 预发体验版上传\n\n${json}\n`);
  console.log(json);
}
