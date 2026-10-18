#!/usr/bin/env node
// W2-28: consume two already-fetched, SHA-filtered Actions responses; never poll or retry.
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const WORKFLOWS = ["images", "mixed-smoke"];
const positive = (value) => Number.isSafeInteger(value) && value > 0;
function identity(repository, source) {
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository) ||
    typeof source !== "string" ||
    !/^[a-f0-9]{40}$/.test(source)
  )
    throw new Error("发布检查身份无效");
}

/** Exactly two GETs in the later workflow, without a status filter that could hide a newer RED. */
export function releaseCheckRequests(repository, source) {
  identity(repository, source);
  return Object.fromEntries(
    WORKFLOWS.map((name) => [
      name,
      `repos/${repository}/actions/workflows/${name}.yml/runs?branch=main&event=push&head_sha=${source}&per_page=100`,
    ]),
  );
}

function selectRun(response, name, repository, source) {
  const fail = () => {
    throw new Error(`发布检查未就绪：${name}`);
  };
  const rows = response?.workflow_runs;
  if (
    !Array.isArray(rows) ||
    rows.length < 1 ||
    rows.length > 100 ||
    response.total_count !== rows.length
  )
    fail();
  const ids = new Set(),
    numbers = new Set(),
    workflows = new Set();
  const path = `.github/workflows/${name}.yml`;
  for (const row of rows) {
    if (
      !row ||
      !positive(row.id) ||
      !positive(row.run_number) ||
      !positive(row.run_attempt) ||
      !positive(row.workflow_id) ||
      ids.has(row.id) ||
      numbers.has(row.run_number) ||
      row.name !== name ||
      ![path, `${path}@main`, `${path}@${source}`].includes(row.path) ||
      row.repository?.full_name !== repository ||
      row.head_repository?.full_name !== repository ||
      row.event !== "push" ||
      row.head_branch !== "main" ||
      row.head_sha !== source
    )
      fail();
    ids.add(row.id);
    numbers.add(row.run_number);
    workflows.add(row.workflow_id);
  }
  if (workflows.size !== 1) fail();
  const latest = rows.reduce((a, b) => (a.run_number > b.run_number ? a : b));
  if (latest.status !== "completed" || latest.conclusion !== "success") fail();
  return { id: latest.id, attempt: latest.run_attempt };
}

export function selectReleaseChecks(input) {
  identity(input?.repository, input?.source);
  const images = selectRun(input.images, "images", input.repository, input.source);
  const mixed = selectRun(input.mixed, "mixed-smoke", input.repository, input.source);
  if (images.id === mixed.id) throw new Error("发布检查身份无效");
  return {
    source: input.source,
    repository: input.repository,
    compatibility: "passed",
    imagesRunId: images.id,
    imagesAttempt: images.attempt,
    mixedRunId: mixed.id,
    mixedAttempt: mixed.attempt,
  };
}

/** Local metadata only. The caller must invoke this before SSH setup, pull, or deployment. */
export function main(args, env = process.env) {
  if (args.length !== 2) throw new Error("发布检查参数无效");
  const load = (file) => {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("发布检查输入无效");
    return JSON.parse(readFileSync(file, "utf8"));
  };
  return selectReleaseChecks({
    repository: env.GITHUB_REPOSITORY,
    source: env.EXPECTED_SHA,
    images: load(args[0]),
    mixed: load(args[1]),
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
  } catch {
    process.stderr.write("发布检查缺失、不完整或未成功，拒绝部署\n");
    process.exitCode = 1;
  }
}
