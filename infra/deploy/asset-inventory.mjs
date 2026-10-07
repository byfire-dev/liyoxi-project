#!/usr/bin/env node
// 固定路径 helper：capture 只读镜像提取物与共享 assets，live 只请求本容器网络里的 gateway。
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkTargets } from "../ci/probe-during-deploy.mjs";

const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const APPS = ["admin", "portal"];
const PATH = /^[a-zA-Z0-9_-][a-zA-Z0-9/_.-]{0,240}$/;
const hash = (body) => createHash("sha256").update(body).digest("hex");
function safePath(path) {
  if (!PATH.test(path) || path.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("资源路径不合法");
  return path;
}
function bytes(path, max = 32 * 1024 * 1024) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
    throw new Error("资源类型或大小不合法");
  return readFileSync(path);
}
function entryPaths(index) {
  const references = [...index.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  if (references.some((path) => !path.startsWith("/assets/") && !path.startsWith("data:")))
    throw new Error("入口引用未受资源清单覆盖");
  const found = [...index.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((path) => path.startsWith("/assets/"))
    .map((path) => safePath(path.slice("/assets/".length)));
  if (!found.length) throw new Error("入口没有静态资源引用");
  return [...new Set(found)].sort();
}
function collect(directory, prefix = "") {
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("资源目录不接受符号链接");
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const path = safePath(prefix + name);
    const stat = lstatSync(join(directory, name));
    if (stat.isSymbolicLink()) throw new Error("资源不接受符号链接");
    if (stat.isDirectory()) files.push(...collect(join(directory, name), `${path}/`));
    else if (stat.isFile()) {
      const body = bytes(join(directory, name));
      files.push({ path, sha256: hash(body), bytes: body.length });
    } else throw new Error("资源不是普通文件");
    if (files.length > 4096) throw new Error("资源数量超过 4096");
  }
  return files;
}
function validate(value, tag) {
  if (
    !value ||
    Object.keys(value).sort().join("|") !== "apps|schemaVersion|version" ||
    value.schemaVersion !== 1 ||
    value.version !== tag ||
    !value.apps ||
    Object.keys(value.apps).sort().join("|") !== "admin|portal"
  )
    throw new Error("版本资源清单不合法");
  for (const app of APPS) {
    const row = value.apps[app];
    if (
      !row ||
      Object.keys(row).sort().join("|") !== "assets|build|entry|index" ||
      typeof row.index !== "string" ||
      Buffer.byteLength(row.index) > 256 * 1024 ||
      typeof row.build !== "string" ||
      Buffer.byteLength(row.build) > 4096 ||
      !Array.isArray(row.assets) ||
      !row.assets.length ||
      row.assets.length > 4096 ||
      !Array.isArray(row.entry)
    )
      throw new Error("应用资源清单不合法");
    const build = JSON.parse(row.build);
    if (
      build.app !== app ||
      build.build !== tag ||
      build.mode !== "production" ||
      !row.index.includes(`<meta name="lyx-build" content="${tag}"`)
    )
      throw new Error("镜像入口构建号不符");
    const paths = new Set();
    let size = 0;
    for (const asset of row.assets) {
      if (
        !asset ||
        Object.keys(asset).sort().join("|") !== "bytes|path|sha256" ||
        !/^[a-f0-9]{64}$/.test(asset.sha256) ||
        !Number.isSafeInteger(asset.bytes) ||
        asset.bytes < 0 ||
        asset.bytes > 32 * 1024 * 1024
      )
        throw new Error("文件资源清单不合法");
      safePath(asset.path);
      if (paths.has(asset.path)) throw new Error("资源路径重复");
      paths.add(asset.path);
      size += asset.bytes;
    }
    if (
      size > 128 * 1024 * 1024 ||
      JSON.stringify(entryPaths(row.index)) !== JSON.stringify(row.entry) ||
      row.entry.some((path) => !paths.has(path))
    )
      throw new Error("资源清单没有覆盖全部入口或超过大小限制");
  }
  return value;
}
export function capture(tag, image, shared, records) {
  if (!TAG.test(tag)) throw new Error("版本不合法");
  const inventory = { schemaVersion: 1, version: tag, apps: {} };
  for (const app of APPS) {
    const index = bytes(join(image, app, "index.html"), 256 * 1024).toString("utf8");
    const build = bytes(join(image, app, "build.json"), 4096).toString("utf8");
    const assets = collect(join(image, app, "assets"));
    inventory.apps[app] = { index, build, entry: entryPaths(index), assets };
    for (const asset of assets) {
      let path = shared;
      for (const part of [app, "assets", ...asset.path.split("/")]) {
        path = join(path, part);
        if (lstatSync(path).isSymbolicLink()) throw new Error("共享资源不接受符号链接");
      }
      const body = bytes(path);
      if (body.length !== asset.bytes || hash(body) !== asset.sha256)
        throw new Error(`共享资源缺失或内容不符：${app}/${asset.path}`);
    }
  }
  validate(inventory, tag);
  const json = `${JSON.stringify(inventory)}\n`;
  if (Buffer.byteLength(json) > 1024 * 1024) throw new Error("清单超过 1 MiB");
  mkdirSync(join(records, tag), { recursive: true });
  const path = join(records, tag, "inventory.json");
  if (existsSync(path) && readFileSync(path, "utf8") !== json)
    throw new Error("同版本清单不同，拒绝覆盖");
  writeFileSync(`${path}.tmp`, json, { mode: 0o644 });
  renameSync(`${path}.tmp`, path);
  return inventory;
}
export function load(tag, records) {
  if (!TAG.test(tag)) throw new Error("版本不合法");
  return validate(
    JSON.parse(bytes(join(records, tag, "inventory.json"), 1024 * 1024).toString("utf8")),
    tag,
  );
}
export function targets(inventory, hosts, base = "http://127.0.0.1:8080", entries = false) {
  return APPS.flatMap((app) => {
    const row = inventory.apps[app];
    return [
      ...(entries
        ? [
            { name: `${app}/index`, url: `${base}/`, host: hosts[app], sha256: hash(row.index) },
            {
              name: `${app}/build`,
              url: `${base}/build.json`,
              host: hosts[app],
              sha256: hash(row.build),
            },
          ]
        : []),
      ...row.assets.map((asset) => ({
        name: `${inventory.version}/${app}/${asset.path}`,
        url: `${base}/assets/${asset.path}`,
        host: hosts[app],
        sha256: asset.sha256,
      })),
    ];
  });
}
export async function main(
  args,
  paths = { image: "/facts/image", shared: "/facts/static", records: "/facts/records" },
) {
  const [mode, tag, previous] = args;
  if (!TAG.test(tag ?? "") || args.length > 3 || (previous !== undefined && !TAG.test(previous)))
    throw new Error("资源步骤参数不合法");
  if (mode === "capture" && args.length === 2) {
    capture(tag, paths.image, paths.shared, paths.records);
    console.log(`完整资源清单已核对：${tag}`);
  } else if (mode === "live") {
    const hosts = { admin: process.env.LYX_ADMIN_HOST, portal: process.env.LYX_PORTAL_HOST };
    if (!hosts.admin || !hosts.portal) throw new Error("资源核对缺少域名");
    const all = targets(load(tag, paths.records), hosts, paths.base, true);
    if (previous && previous !== tag)
      all.push(...targets(load(previous, paths.records), hosts, paths.base));
    const errors = await checkTargets(all);
    if (errors.length)
      throw new Error(`资源冒烟失败 ${errors.length} 项：${JSON.stringify(errors.slice(0, 20))}`);
    console.log(
      `当前入口及新旧全部资源通过：${tag}${previous ? ` / ${previous}` : ""}，${all.length} 项`,
    );
  } else throw new Error("资源步骤不合法");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
