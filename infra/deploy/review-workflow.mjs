#!/usr/bin/env node
// 手动送审的私有编排；仅工作流执行，测试注入GitHub/SSH替身。不会提交审核或设置体验版。
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REVIEW_TAG } from "./review-artifact.mjs";
import { validateRelease } from "../ci/stg-image-facts.mjs";
import { reviewReadiness } from "../ci/review-readiness.mjs";
import { createChannel } from "./orchestrate.mjs";

export function reviewIdentity(source, version, repository) {
  const tag = `weapp-v${version}`;
  if (
    !/^[a-f0-9]{40}$/.test(source) ||
    !REVIEW_TAG.test(tag) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)
  )
    throw Error("送审身份无效");
  return tag;
}
export function reviewCiPassed(body, source, repository) {
  const rows = body?.workflow_runs;
  if (!Array.isArray(rows) || !rows.length || rows.length > 100 || body.total_count !== rows.length)
    return false;
  const ids = new Set(),
    numbers = new Set(),
    workflows = new Set();
  for (const row of rows) {
    if (
      ![row?.id, row?.run_number, row?.run_attempt, row?.workflow_id].every(
        (v) => Number.isSafeInteger(v) && v > 0,
      ) ||
      ids.has(row.id) ||
      numbers.has(row.run_number) ||
      row.name !== "ci" ||
      row.event !== "push" ||
      row.head_branch !== "main" ||
      row.head_sha !== source ||
      row.repository?.full_name !== repository ||
      row.head_repository?.full_name !== repository ||
      ![
        ".github/workflows/ci.yml",
        ".github/workflows/ci.yml@main",
        `.github/workflows/ci.yml@${source}`,
      ].includes(row.path)
    )
      return false;
    ids.add(row.id);
    numbers.add(row.run_number);
    workflows.add(row.workflow_id);
  }
  const latest = rows.reduce((a, b) => (a.run_number > b.run_number ? a : b));
  return workflows.size === 1 && latest.status === "completed" && latest.conclusion === "success";
}

/** 写操作至少相隔60秒；拒绝/限流后停止本轮全部请求，不自动重试。 */
export function reviewGitHubApi(
  run,
  now = Date.now,
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
) {
  let lastWrite = -Infinity,
    stopped = false;
  return async (method, path, body) => {
    if (stopped) throw Object.assign(Error("GitHub已停止"), { stopWrites: true });
    if (method !== "GET") {
      const delay = 60_000 - (now() - lastWrite);
      if (delay > 0) await wait(delay);
      lastWrite = now();
    }
    const result = run(method, path, body);
    if (result.status !== 0) {
      stopped = /HTTP\s+(403|429)\b/.test(result.stderr ?? "");
      throw Object.assign(Error("GitHub操作未确认"), { stopWrites: stopped });
    }
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  };
}

export async function reviewWorkflow(options, { readiness, api, channel }) {
  const { source, version, repository, rawManifest, freeze, enabled, execute } = options;
  const tag = reviewIdentity(source, version, repository);
  if (freeze !== "true" || enabled !== "true" || execute !== "true")
    throw Error("送审必须手动启用、确认并冻结");
  const manifest = validateRelease(JSON.parse(rawManifest), source);
  const checks = await readiness();
  if (!checks.length || checks.some((v) => !v.ok)) throw Error("出包条件未满足，未创建标签");
  const ci = await api(
    "GET",
    `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${source}&per_page=100`,
  );
  if (!reviewCiPassed(ci, source, repository)) throw Error("同提交main CI未成功，未创建标签");
  const refs = await api("GET", `repos/${repository}/git/matching-refs/tags/${tag}`);
  if (!Array.isArray(refs) || refs.some((r) => r.ref === `refs/tags/${tag}`))
    throw Error("标签已存在或查询不完整");
  let created = false,
    uploadStarted = false;
  try {
    const ref = await api("POST", `repos/${repository}/git/refs`, {
      ref: `refs/tags/${tag}`,
      sha: source,
    });
    if (
      ref?.ref !== `refs/tags/${tag}` ||
      ref.object?.sha !== source ||
      ref.object?.type !== "commit"
    )
      throw Error("新建标签未确认");
    created = true;
    uploadStarted = true;
    const result = channel("weapp-review-upload", [
      source,
      createHash("sha256").update(rawManifest).digest("hex"),
      tag,
    ]);
    const rows = result.stdout.split("\n").filter((v) => v.startsWith("LYX_WEAPP_REVIEW_UPLOAD="));
    if (result.status !== 0 || rows.length !== 1) throw Error("上传失败");
    const receipt = JSON.parse(rows[0].slice("LYX_WEAPP_REVIEW_UPLOAD=".length));
    if (
      receipt.status !== "uploaded" ||
      receipt.source !== source ||
      receipt.tag !== tag ||
      receipt.version !== version ||
      receipt.clientVersion !== manifest.tag ||
      receipt.robot !== 2
    )
      throw Error("上传回执不符");
    return receipt;
  } catch (error) {
    if (created && uploadStarted) {
      // SSH失败或回执丢失不能证明SDK没成功，保留仍可能在役的契约保护。
      try {
        await api("GET", `repos/${repository}/git/ref/tags/${tag}`);
      } catch {
        /* 未确认仍保留标签 */
      }
      throw Error("上传结果未确认；本轮标签保留，请人工核对，不重试上传", { cause: error });
    }
    if (error?.stopWrites)
      throw Error("标签创建未确认；GitHub拒绝或限流，停止本轮操作，请人工核对", { cause: error });
    if (created) {
      const ref = await api("GET", `repos/${repository}/git/ref/tags/${tag}`);
      if (
        ref?.ref !== `refs/tags/${tag}` ||
        ref.object?.sha !== source ||
        ref.object?.type !== "commit"
      )
        throw Error("上传失败；标签已变化，需人工核对，未删除", { cause: error });
      await api("DELETE", `repos/${repository}/git/refs/tags/${tag}`);
      throw Error("上传失败；本轮新建标签已删除", { cause: error });
    }
    // POST结果未知时只读复核，不重试创建、不凭同SHA就认领/删除该标签。
    try {
      await api("GET", `repos/${repository}/git/ref/tags/${tag}`);
    } catch {
      /* 保留未知事实，人工核对 */
    }
    throw Error("标签创建未确认；已尝试只读核对，未上传或删除标签，请人工核对", { cause: error });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (
      process.argv.length !== 2 ||
      process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      process.env.GITHUB_REF !== "refs/heads/main"
    )
      throw Error("只接受main手动工作流");
    const env = process.env,
      source = env.EXPECTED_SHA,
      version = env.REVIEW_VERSION,
      repository = env.GITHUB_REPOSITORY;
    reviewIdentity(source, version, repository);
    const path = `${env.RUNNER_TEMP}/images-release/images.json`;
    if (!lstatSync(path).isFile() || lstatSync(path).size > 65_536) throw Error("摘要不可用");
    const rawManifest = readFileSync(path, "utf8"),
      manifest = validateRelease(JSON.parse(rawManifest), source);
    if (
      env.STG_FREEZE !== "true" ||
      env.STG_WEAPP_REVIEW_UPLOAD_ENABLED !== "true" ||
      env.REVIEW_EXECUTE !== "true" ||
      !/^[a-z_][a-z0-9_-]*$/.test(env.STG_NODE_USER) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(env.STG_NODE_HOST) ||
      !env.SSH_PRIVATE_KEY ||
      !env.SSH_KNOWN_HOSTS ||
      !env.GH_TOKEN
    )
      throw Error("手动送审配置不可用");
    const ssh = `${env.HOME}/.ssh`;
    mkdirSync(ssh, { recursive: true, mode: 0o700 });
    writeFileSync(`${ssh}/id_ed25519`, env.SSH_PRIVATE_KEY, { mode: 0o600 });
    writeFileSync(`${ssh}/known_hosts`, env.SSH_KNOWN_HOSTS, { mode: 0o600 });
    const receipt = await reviewWorkflow(
      {
        source,
        version,
        repository,
        rawManifest,
        freeze: env.STG_FREEZE,
        enabled: env.STG_WEAPP_REVIEW_UPLOAD_ENABLED,
        execute: env.REVIEW_EXECUTE,
      },
      {
        readiness: async () => {
          const checks = await reviewReadiness({
            commit: source,
            baseUrl: manifest.apiBaseUrl,
            freeze: env.STG_FREEZE,
          });
          for (const v of checks)
            console.log(`${v.ok ? "通过" : "未满足"}：${v.name}；${v.detail}`);
          return checks;
        },
        api: reviewGitHubApi((method, path, body) => {
          const result = spawnSync(
            "gh",
            ["api", "--method", method, path, ...(body ? ["--input", "-"] : [])],
            {
              input: body ? JSON.stringify(body) : undefined,
              encoding: "utf8",
              timeout: 20_000,
              maxBuffer: 2 * 1024 * 1024,
            },
          );
          return result;
        }),
        channel: createChannel({ node: `${env.STG_NODE_USER}@${env.STG_NODE_HOST}` }),
      },
    );
    const summary = `机器人2已上传 ${receipt.tag}；source=${receipt.source}；client=${receipt.clientVersion}。\n\n后续由业主：设体验版→三设备Wi-Fi/4G P0回归→后台填写审核说明/账号并提审→核O4与手机号→过审不发布→独立PR退役标签后解冻。\n`;
    console.log(summary);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  } catch (error) {
    const safe =
      error instanceof Error &&
      /^(出包条件未满足|同提交main CI未成功|上传失败|上传结果未确认|标签创建未确认)/.test(
        error.message,
      )
        ? error.message
        : "送审参数、事实、GitHub或节点操作未确认；停止，必要时人工核对新建标签";
    console.error(safe);
    process.exitCode = 1;
  }
}
