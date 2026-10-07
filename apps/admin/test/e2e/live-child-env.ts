/** 测试子进程只继承调用方原白名单，不带服务配置或密钥。 */
export function liveChildEnv(
  keys: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [...keys, "NPM_CONFIG_ENGINE_STRICT"].flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key]]],
    ),
  );
}

/** 仅识别固定非秘密错误符号；不输出子进程原始 stderr 或连接配置。 */
export function liveChildFailure(label: string, stderr: unknown): Error {
  const text =
    typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString() : "";
  const known = [
    "ERR_PNPM_UNSUPPORTED_ENGINE",
    "W119B 窄桥拒绝或文件入库未完成",
    "W120 本轮媒体事实或归属不一致",
  ].find((message) => text.includes(message));
  return new Error(`${label}：${known ?? "子进程未正常完成"}`);
}
