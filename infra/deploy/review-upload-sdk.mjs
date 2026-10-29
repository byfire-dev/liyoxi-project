// 只由已经验完同源事实的提审消费者调用；原开发版上传器的机器人1守卫保持不变。
import { createRequire } from "node:module";
import { lstatSync } from "node:fs";

export async function uploadReview(options, env = process.env) {
  if (
    env.LYX_WEAPP_UPLOAD_ENABLED !== "true" ||
    env.STG_FREEZE !== "true" ||
    !/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(options.version) ||
    !/^wx[a-f0-9]{16}$/.test(options.appid) ||
    options.project !== "/artifacts/project" ||
    options.key !== "/run/secrets/weapp-upload-private-key"
  )
    throw Error("提审上传参数不合法");
  if (!lstatSync(options.project).isDirectory() || !lstatSync(options.key).isFile())
    throw Error("项目与密钥文件不可用");
  const require = createRequire("/app/package.json");
  const ci = require("miniprogram-ci");
  if (
    require("miniprogram-ci/package.json").version !== "2.1.31" ||
    typeof ci.Project !== "function" ||
    typeof ci.upload !== "function"
  )
    throw Error("SDK 不符合固定版本与能力");
  // SDK只运行于独立一次性进程，不让请求、签名或密钥进入控制台。
  console.log = console.info = console.warn = console.error = () => {};
  const project = new ci.Project({
    appid: options.appid,
    type: "miniProgram",
    projectPath: options.project,
    privateKeyPath: options.key,
    ignores: ["node_modules/**/*"],
  });
  await ci.upload({
    project,
    version: options.version,
    desc: "预发提审构建",
    robot: 2,
    setting: { es6: true, minify: true },
    onProgressUpdate: () => {},
  });
}
