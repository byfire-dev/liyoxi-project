/** 与录音转写驱动共用的纯输入规则；不校验授权、配置、取消或期限。 */
export function isAsrSubmitUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export function taskId(value: unknown): string | undefined {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === "string" &&
    /^(?:0|[1-9][0-9]{0,19})$/.test(text) &&
    BigInt(text) <= 18446744073709551615n
    ? text
    : undefined;
}

/** 查询只接受原字符串任务号；响应解析仍可使用 taskId 的安全整数分支。 */
export function isAsrQueryTaskId(value: unknown): value is string {
  return typeof value === "string" && taskId(value) !== undefined;
}
