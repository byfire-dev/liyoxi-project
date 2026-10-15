#!/usr/bin/env node
// Two bounded, sequential reads. No retry, pagination, polling, redirect, or response logging.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { releaseCheckRequests, selectReleaseChecks } from "./release-checks.mjs";

async function readResponse(response) {
  if (!response.ok || response.headers.has("retry-after") || !response.body) {
    await response.body?.cancel();
    throw new Error("发布检查请求未成功，停止请求");
  }
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error("发布检查响应超限");
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function fetchReleaseChecks(env = process.env, request = fetch) {
  const repository = env.GITHUB_REPOSITORY;
  const source = env.EXPECTED_SHA;
  const paths = releaseCheckRequests(repository, source);
  const token = env.GH_TOKEN;
  if (!token || /[\r\n]/.test(token)) throw new Error("缺少发布检查凭据");
  const responses = {};
  for (const name of ["images", "mixed-smoke"]) {
    const response = await request(`https://api.github.com/${paths[name]}`, {
      method: "GET",
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    responses[name] = await readResponse(response);
  }
  return selectReleaseChecks({
    repository,
    source,
    images: responses.images,
    mixed: responses["mixed-smoke"],
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv.length !== 2 || !process.env.GITHUB_OUTPUT)
      throw new Error("发布检查工作流参数无效");
    const selected = await fetchReleaseChecks();
    appendFileSync(process.env.GITHUB_OUTPUT, `images-run-id=${selected.imagesRunId}\n`);
    process.stdout.write(`${JSON.stringify(selected)}\n`);
  } catch {
    process.stderr.write("同提交发布检查未通过；停止请求，不部署\n");
    process.exitCode = 1;
  }
}
