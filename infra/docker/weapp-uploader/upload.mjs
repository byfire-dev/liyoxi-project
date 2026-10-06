#!/usr/bin/env node
// 独立一次性上传器：不取制品、不取密钥；这些由未来的节点上传步骤负责。
import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

export async function main(args, env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      check: { type: "boolean" },
      upload: { type: "boolean" },
      project: { type: "string" },
      appid: { type: "string" },
      "private-key": { type: "string" },
      version: { type: "string" },
      robot: { type: "string" },
    },
  });
  const require = createRequire(import.meta.url);
  const ci = require("miniprogram-ci");
  if (
    require("miniprogram-ci/package.json").version !== "2.1.31" ||
    typeof ci.Project !== "function" ||
    typeof ci.upload !== "function"
  )
    throw new Error("SDK 不符合固定版本与能力");
  if (values.check && Object.keys(values).length === 1) {
    console.log("miniprogram-ci 2.1.31 已加载；上传未执行");
    return;
  }
  if (
    values.check ||
    !values.upload ||
    env.LYX_WEAPP_UPLOAD_ENABLED !== "true" ||
    !/^wx[a-f0-9]{16}$/.test(values.appid ?? "") ||
    !/^sha-[a-f0-9]{12}$/.test(values.version ?? "") ||
    values.robot !== "1" ||
    !values.project ||
    !values["private-key"]
  )
    throw new Error("上传须显式启用并提供合法预发参数");
  const projectPath = resolve(values.project);
  const privateKeyPath = resolve(values["private-key"]);
  if (!statSync(projectPath).isDirectory() || !statSync(privateKeyPath).isFile())
    throw new Error("项目与密钥文件不可用");
  const project = new ci.Project({
    appid: values.appid,
    type: "miniProgram",
    projectPath,
    privateKeyPath,
    ignores: ["node_modules/**/*"],
  });
  // SDK 的日志可能包含请求数据；只交付成功/失败，不透传它的日志或异常。
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  await ci.upload({
    project,
    version: values.version,
    desc: "预发构建",
    robot: 1,
    setting: { es6: true, minify: true },
    onProgressUpdate: () => {},
  });
  process.stdout.write("预发上传完成\n");
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("小程序上传器：参数、SDK 或上传失败\n");
    process.exitCode = 2;
  });
}
