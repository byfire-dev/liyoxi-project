import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const base = process.env.PROBE_BASE_URL || "http://127.0.0.1:4310";
const url = new URL(base);
if (
  !["http:", "https:"].includes(url.protocol) ||
  url.username ||
  url.password ||
  url.search ||
  url.hash
)
  throw new Error("PROBE_BASE_URL_INVALID");
rmSync(path.join(root, "dist"), { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [
    "--import",
    path.join(root, "scripts/no-env.mjs"),
    path.join(root, "node_modules/@tarojs/cli/bin/taro"),
    "build",
    "--type",
    "weapp",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
      TARO_ENV: "weapp",
      PROBE_BASE_URL: base,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${JSON.stringify(path.join(root, "scripts/no-env.mjs"))}`,
    },
  },
);
if (result.status !== 0 || result.error) process.exit(result.status || 1);
writeFileSync(
  path.join(root, "dist/project.config.json"),
  JSON.stringify(
    {
      appid: process.env.PROBE_APPID || "touristappid",
      projectname: "liyoxi-weapp-probe",
      miniprogramRoot: "./",
      compileType: "miniprogram",
      libVersion: "3.8.0",
      setting: { urlCheck: true, es6: true, minified: true, uploadWithSourceMap: false },
    },
    null,
    2,
  ),
);
