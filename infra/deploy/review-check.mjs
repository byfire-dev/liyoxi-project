#!/usr/bin/env node
// 只读公开引导与源码；不登录、不写开关、不读取环境文件或平台配置。
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { FLAGS } from "../../packages/contract/src/config/flags.ts";
import { trialConfigErrors } from "../../apps/weapp/scripts/trial-config.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (root, path) => readFileSync(join(root, path), "utf8");
const POLICY = JSON.parse(read(ROOT, "infra/deploy/review-flags.json"));
const PRIVACY = [
  ["getPhoneNumber"],
  ["chooseMedia", "chooseImage", "chooseVideo"],
  ["chooseMedia", "chooseImage", "chooseVideo", "scanCode"],
  ["getRecorderManager"],
  ["saveVideoToPhotosAlbum", "saveImageToPhotosAlbum"],
  ["setClipboardData", "getClipboardData"],
  ["chooseMessageFile"],
  ["chooseLocation", "getLocation"],
];
const known = new Set(PRIVACY.flat());

export function reviewFlagErrors(flags, policy = POLICY) {
  const errors = [];
  for (const [key, value] of Object.entries(policy)) {
    const def = FLAGS.find((item) => item.key === key);
    if (!def || def.exposedTo !== "client") errors.push(`${key}：不是已登记客户端开关`);
    else if (JSON.stringify(value) === JSON.stringify(def.defaultValue))
      errors.push(`${key}：与默认相同，不应重复登记`);
    else if (def.valueType === "bool" && typeof value !== "boolean")
      errors.push(`${key}：值类型不符`);
  }
  for (const def of FLAGS.filter((item) => item.exposedTo === "client")) {
    const expected = Object.hasOwn(policy, def.key) ? policy[def.key] : def.defaultValue;
    if (JSON.stringify(flags?.[def.key]) !== JSON.stringify(expected))
      errors.push(`${def.key}：下发值与送审清单不同或缺失`);
  }
  return errors;
}

/** AST只取实际调用及手机号按钮；注释/字符串不冒充调用，未识别的动态调用拒绝。 */
export function privacyReport(root = ROOT) {
  const calls = new Set(),
    errors = [];
  function scan(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        const source = ts.createSourceFile(
          file,
          readFileSync(file, "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        const namespaces = new Set(),
          named = new Map();
        for (const node of source.statements) {
          if (!ts.isImportDeclaration(node) || node.moduleSpecifier.text !== "@tarojs/taro")
            continue;
          if (node.importClause?.name) namespaces.add(node.importClause.name.text);
          const bindings = node.importClause?.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
          if (bindings && ts.isNamedImports(bindings))
            for (const item of bindings.elements)
              named.set(item.name.text, (item.propertyName ?? item.name).text);
        }
        function visit(node) {
          if (ts.isCallExpression(node)) {
            const expr = node.expression;
            let api;
            if (ts.isIdentifier(expr)) api = named.get(expr.text);
            else if (
              ts.isPropertyAccessExpression(expr) &&
              namespaces.has(expr.expression.getText(source))
            )
              api = expr.name.text;
            else if (
              ts.isElementAccessExpression(expr) &&
              namespaces.has(expr.expression.getText(source))
            )
              errors.push("隐私扫描：存在无法静态核对的Taro动态调用");
            if (known.has(api)) calls.add(api);
          }
          if (
            ts.isJsxAttribute(node) &&
            node.name.getText(source) === "openType" &&
            node.initializer
          ) {
            const value = ts.isStringLiteral(node.initializer)
              ? node.initializer.text
              : node.initializer.getText(source);
            if (value === "getPhoneNumber") calls.add(value);
            else if (value.includes("getPhoneNumber"))
              errors.push("隐私扫描：手机号按钮不是静态字面量");
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  scan(join(root, "apps/weapp/src"));
  const config = ts.createSourceFile(
    "app.config.ts",
    read(root, "apps/weapp/src/app.config.ts"),
    ts.ScriptTarget.Latest,
    true,
  );
  let required = [],
    configCount = 0;
  function configVisit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(config).replace(/["']/g, "") === "requiredPrivateInfos"
    ) {
      configCount++;
      if (
        !ts.isArrayLiteralExpression(node.initializer) ||
        node.initializer.elements.some((v) => !ts.isStringLiteral(v))
      )
        errors.push("requiredPrivateInfos不是静态字符串数组");
      else required = node.initializer.elements.map((v) => v.text).sort();
    }
    ts.forEachChild(node, configVisit);
  }
  configVisit(config);
  if (configCount > 1) errors.push("requiredPrivateInfos重复");
  const docs =
    read(root, "docs/plan/platform-config.md").split("#### 2.1.1")[1]?.split("### 2.2")[0] ?? "";
  for (let index = 0; index < PRIVACY.length; index++) {
    const cell =
      docs
        .split("\n")
        .find((line) => line.startsWith(`| ${index + 1} |`))
        ?.split("|")[3] ?? "";
    const documented = [...cell.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]).sort();
    const actual = PRIVACY[index].filter((api) => calls.has(api)).sort();
    if (JSON.stringify(actual) !== JSON.stringify(documented))
      errors.push(`隐私指引第${index + 1}项与实际调用不一致`);
  }
  const marker = /requiredPrivateInfos：`(\[[^`]*\])`/.exec(docs);
  if (!marker || JSON.stringify(required) !== marker[1])
    errors.push("requiredPrivateInfos与指引不一致");
  return { calls: [...calls].sort(), requiredPrivateInfos: required, errors };
}

export async function checkReviewFlags(baseUrl, fetcher = fetch, version = "0.1.0") {
  const errors = trialConfigErrors({
    WEAPP_APPID: "wx0000000000000000",
    WEAPP_API_BASE_URL: baseUrl,
  });
  if (
    errors.length ||
    !/^(?:sha-[a-f0-9]{12}|(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5}))$/.test(version)
  )
    throw Error("送审核对：需要合法HTTPS根地址及实际客户端版本号");
  for (const envVersion of ["develop", "trial", "release"]) {
    try {
      const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/api/v1/m/bootstrap`, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "X-Request-Id": randomUUID(),
          "X-Client-Platform": "devtools",
          "X-Client-Version": version,
          "X-Env-Version": envVersion,
        },
      });
      const data = response.ok ? (await response.json())?.data : null;
      if (!data || !Array.isArray(data.degraded) || data.degraded.includes("flags"))
        errors.push(`${envVersion}：引导开关不可用或降级`);
      else errors.push(...reviewFlagErrors(data.flags).map((error) => `${envVersion}：${error}`));
    } catch {
      errors.push(`${envVersion}：引导请求失败`);
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let errors;
    if (args.length === 1 && args[0] === "--privacy") {
      const report = privacyReport();
      console.log(JSON.stringify(report));
      errors = report.errors;
    } else if (
      (args.length === 2 || args.length === 4) &&
      args[0] === "--base-url" &&
      (args.length === 2 || args[2] === "--version")
    )
      errors = await checkReviewFlags(args[1], fetch, args[3]);
    else
      throw Error(
        "用法：review-check.mjs --privacy | --base-url <HTTPS根地址> [--version X.Y.Z或sha-12]",
      );
    for (const error of errors) console.error(error);
    if (errors.length) process.exitCode = 1;
    else console.log("只读核对通过；不代表微信后台或真实审核已通过");
  } catch {
    console.error("送审核对：参数、源码或响应不可用");
    process.exitCode = 2;
  }
}
