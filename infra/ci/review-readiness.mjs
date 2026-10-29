#!/usr/bin/env node
// 出包前只读核对。外部条件只认已登记的完成事实；缺失/部分完成一律拒绝。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { checkReviewFlags, privacyReport } from "../deploy/review-check.mjs";
import { trialConfigErrors } from "../../apps/weapp/scripts/trial-config.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const REVIEW_REQUIREMENTS = JSON.parse(
  readFileSync(new URL("./review-readiness.json", import.meta.url), "utf8"),
);
const text = (root, path) => readFileSync(join(root, path), "utf8");
const cells = (line) =>
  line
    .split("|")
    .slice(1, -1)
    .map((v) => v.trim());
function row(markdown, key) {
  return markdown
    .split("\n")
    .map(cells)
    .find((v) => v[0] === key);
}

/** 页面登记用AST读取，不能把注释、note或其他页的implemented当成注销页。 */
export function deletionPageImplemented(source) {
  const ast = ts.createSourceFile("pages.ts", source, ts.ScriptTarget.Latest, true);
  let implemented = false;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "page" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "sub/service/settings/index"
    ) {
      const options = node.arguments.at(-1);
      implemented =
        ts.isObjectLiteralExpression(options) &&
        options.properties.some(
          (v) =>
            ts.isPropertyAssignment(v) &&
            v.name.getText(ast) === "implemented" &&
            v.initializer.kind === ts.SyntaxKind.TrueKeyword,
        );
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return implemented;
}

export async function reviewReadiness({
  root = ROOT,
  commit,
  baseUrl,
  freeze,
  run,
  fetcher = fetch,
}) {
  const results = [],
    record = (name, ok, detail) => results.push({ name, ok, detail });
  const execute =
    run ??
    ((command, args) => spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30_000 }));
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw Error("提交必须是完整40位小写SHA");
  const head = execute("git", ["rev-parse", "HEAD"]);
  const main = execute("git", ["merge-base", "--is-ancestor", commit, "origin/main"]);
  const clean = execute("git", ["status", "--porcelain"]);
  record(
    "源码",
    head.status === 0 &&
      head.stdout.trim() === commit &&
      main.status === 0 &&
      clean.status === 0 &&
      !clean.stdout.trim(),
    "只接受干净检出、HEAD等于目标且目标已在origin/main",
  );
  for (const entry of REVIEW_REQUIREMENTS.packages) {
    let status;
    try {
      status = row(text(root, `docs/plan/status/${entry.id}.md`), "状态")?.[1];
    } catch {
      /* 未拆出/缺文件即未满足 */
    }
    record(entry.id, status === "完成", `${entry.name}：${status ?? "缺状态"}`);
  }
  const landed = execute(process.execPath, [
    "infra/ci/landed.mjs",
    "--check",
    "--require",
    REVIEW_REQUIREMENTS.milestones.join(","),
  ]);
  record(
    "接口落地",
    landed.status === 0,
    "M0/M1/M2必须全清零；挂载清单须由同检出正式探活目标生成，缺失按空集失败",
  );
  const compat = execute("pnpm", ["contract:compat"]);
  record("在役兼容", compat.status === 0, "正式contract:compat必须成功，不另造比较器");
  record(
    "注销入口",
    deletionPageImplemented(text(root, "apps/weapp/src/pages.ts")),
    "设置页必须实际登记为已实现；实际流程仍需真机核对",
  );
  const owner = text(root, "docs/plan/owner-checklist.md");
  for (const id of REVIEW_REQUIREMENTS.ownerItems) {
    const item = row(owner, id);
    record(
      id,
      item?.[3] === "完成" && !!item?.[4] && !!item?.[5],
      "须业主清单状态完成且有事实与日期，部分完成不算完成",
    );
  }
  const platform =
    text(root, "docs/plan/platform-config.md").split("## 6. 提审核对表")[1]?.split("## 7.")[0] ??
    "";
  for (let i = 1; i <= REVIEW_REQUIREMENTS.platformRows; i++) {
    const item = row(platform, String(i));
    record(
      `平台核对${i}`,
      item?.[5] === "通过" && !!item?.[6] && !/待填|待核/.test(item[6]),
      "逐项真实核对后填通过及截图/日期；源码准备不代替外部事实",
    );
  }
  record("冻结", freeze === "true", "仓库STG_FREEZE必须显式true；节点仍独立重验");
  const privacy = privacyReport(root);
  record(
    "隐私源码",
    !privacy.errors.length,
    privacy.errors.join("；") || "实际调用及requiredPrivateInfos与指引一致",
  );
  const configErrors = trialConfigErrors({
    WEAPP_APPID: "wx0000000000000000",
    WEAPP_API_BASE_URL: baseUrl,
  });
  if (configErrors.length) {
    record("预发健康", false, "需要公开HTTPS根地址，不接受凭据/查询串/占位地址");
    record("送审开关", false, "缺少有效预发地址");
  } else {
    try {
      const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      const health = response.ok ? await response.json() : null;
      record(
        "预发健康",
        response.ok &&
          health?.status === "ok" &&
          health.version === `sha-${commit.slice(0, 12)}` &&
          health.db === "ok" &&
          health.redis === "ok" &&
          health.worker === "ok",
        "health须健康且版本为该提交sha-12；同源完整事实由节点上传器再次校验",
      );
    } catch {
      record("预发健康", false, "公开健康请求失败");
    }
    const errors = await checkReviewFlags(baseUrl, fetcher, `sha-${commit.slice(0, 12)}`);
    record(
      "送审开关",
      !errors.length,
      errors.join("；") || "开发/体验/正式类型下发与送审清单一致；真机平台策略另核",
    );
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [flag, commit, ...extra] = process.argv.slice(2);
    if (flag !== "--commit" || (extra.length && (extra.length !== 2 || extra[0] !== "--base-url")))
      throw Error("参数无效");
    const results = await reviewReadiness({
      commit,
      baseUrl: extra[1] ?? process.env.WEAPP_API_BASE_URL,
      freeze: process.env.STG_FREEZE,
    });
    for (const result of results)
      console.log(`${result.ok ? "通过" : "未满足"}：${result.name}；${result.detail}`);
    if (results.some((v) => !v.ok)) process.exitCode = 1;
  } catch {
    console.error("出包核对：参数、源码或本地命令不可用，拒绝出包");
    process.exitCode = 2;
  }
}
