#!/usr/bin/env node
// 换名检查：仓库里出现参考工程的旧技术名即失败（D7 第 2.5 节；ADR-002）。
//
// 用法：node infra/ci/check-rename.mjs      在仓库根目录跑；根脚本是 pnpm check:rename
// 口径：
//   1. 扫 git 已跟踪的文件，外加未跟踪但没被忽略的文件；只排除 docs/、design/（依据文档要引用旧名）。
//   2. 文件内容或路径里出现旧名（不分大小写）而后面不是新名的尾巴，即失败，并指出文件与行。
//   3. 出现旧的小程序目录即失败；小程序目录叫 apps/weapp。
//   4. 完整性哈希（sha512-… 之类）是随机串，不算文本；二进制文件不扫内容。
// 退出码：0 通过；1 有违规；2 用法或环境错误。
// 本脚本不引依赖。旧名在这里用拼接写出，免得本文件自己被判中。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const OLD_NAME = ["li", "yo"].join("");
const NEW_TAIL = "xi";
const OLD_WEAPP_DIR = "apps/mobile";
const EXCLUDED_PREFIXES = ["docs/", "design/"];

const oldNamePattern = () => new RegExp(`${OLD_NAME}(?!${NEW_TAIL})`, "gi");
const INTEGRITY_HASH = /sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}/g;

const root = process.cwd();

function listFiles() {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    return [...new Set(out.split("\0").filter(Boolean))].sort();
  } catch (error) {
    console.error(`换名检查：列不出文件，当前目录须是 git 仓库的根目录。${error.message}`);
    process.exit(2);
  }
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

const violations = [];
let scanned = 0;

for (const file of listFiles()) {
  if (EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;

  if (file.startsWith(`${OLD_WEAPP_DIR}/`)) {
    violations.push(`${file}: 小程序目录应为 apps/weapp，不叫 ${OLD_WEAPP_DIR}`);
  }
  if (oldNamePattern().test(file)) {
    violations.push(`${file}: 路径里有旧名`);
  }

  const absolute = join(root, file);
  // 已跟踪但工作区里删掉的文件、子模块目录、符号链接指向的目录：跳过内容
  if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
  const buffer = readFileSync(absolute);
  if (isBinary(buffer)) continue;
  scanned += 1;

  const lines = buffer.toString("utf8").split("\n");
  lines.forEach((rawLine, index) => {
    const line = rawLine.replace(INTEGRITY_HASH, (hash) => " ".repeat(hash.length));
    for (const match of line.matchAll(oldNamePattern())) {
      const excerpt = rawLine.trim().slice(0, 120);
      violations.push(`${file}:${index + 1}:${match.index + 1}: 出现旧名 → ${excerpt}`);
    }
  });
}

// 目录在但里面的文件都被忽略时，上面扫不到，这里再看一眼磁盘
if (existsSync(join(root, OLD_WEAPP_DIR)) && !violations.some((v) => v.startsWith(OLD_WEAPP_DIR))) {
  violations.push(`${OLD_WEAPP_DIR}/: 小程序目录应为 apps/weapp，不叫 ${OLD_WEAPP_DIR}`);
}

if (violations.length > 0) {
  console.error(
    `换名检查未通过，共 ${violations.length} 处（新名是 ${OLD_NAME}${NEW_TAIL}，前缀 lyx）：`,
  );
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`换名检查通过：扫了 ${scanned} 个文件，没有旧名，没有 ${OLD_WEAPP_DIR} 目录。`);
