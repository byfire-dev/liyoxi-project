// 诊断只输出来源与无查询/片段的资源摘要。小程序不依赖浏览器 URL 全局对象。
export function coverImageIdentity(source: string) {
  const resource = source.split(/[?#]/)[0] ?? "";
  const remote = /^(https?):\/\/([^/]*)(.*)$/i.exec(resource);
  let origin = "local";
  let path = resource;
  if (remote) {
    const host = (remote[2] ?? "").split("@").pop() ?? "";
    origin = /^(?:[a-z\d.-]+|\[[a-f\d:.]+\])(?::\d+)?$/i.test(host)
      ? `${remote[1]?.toLowerCase()}://${host.toLowerCase()}`
      : "unknown";
    path = remote[3] ?? "";
  }
  let hash = 2166136261;
  const identity = `${origin}${path}`;
  for (let i = 0; i < identity.length; i++)
    hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
  return { origin, resourceHash: (hash >>> 0).toString(16).padStart(8, "0") };
}

const nativeErrors = [
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_REFUSED",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_TIMED_OUT",
  "ERR_NETWORK_CHANGED",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_CERT_DATE_INVALID",
  "ERR_CERT_AUTHORITY_INVALID",
  "ERR_SSL_PROTOCOL_ERROR",
] as const;

/** 不回传原始文本：只提取固定的错误原因，URL、签名、凭据及未知自由文本均丢弃。 */
function safeErrorMessage(message: unknown) {
  if (typeof message !== "string") return "image:fail";
  const native = nativeErrors.find((code) => message.includes(code));
  if (native) return `image:fail ${native}`;
  const text = message.toLowerCase();
  if (/not in (?:the )?domain list|domain not configured/.test(text))
    return "image:fail domain not configured";
  if (/timeout|timed out/.test(text)) return "image:fail timeout";
  if (/ssl|tls|certificate/.test(text)) return "image:fail TLS";
  if (/network|connection/.test(text)) return "image:fail network";
  const status =
    /\b(?:http|status(?:code)?)\s*[:=]?\s*(401|403|404|408|410|429|500|502|503|504)\b/i.exec(
      message,
    );
  return status ? `image:fail HTTP ${status[1]}` : "image:fail";
}

export function coverImageFailure(source: string, errMsg: unknown) {
  return { ...coverImageIdentity(source), errMsg: safeErrorMessage(errMsg) };
}
