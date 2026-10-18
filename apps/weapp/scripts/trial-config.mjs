import { randomUUID } from "node:crypto";

/** 体验版不得使用游客 AppID、占位域名或带凭证的接口地址。 */
export function trialConfigErrors(env) {
  const errors = [];
  if (!/^wx[a-f0-9]{16}$/.test(env.WEAPP_APPID ?? ""))
    errors.push("WEAPP_APPID：需要真实小程序 AppID");
  try {
    const url = new URL(env.WEAPP_API_BASE_URL ?? "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      url.hostname.endsWith(".") ||
      !url.hostname.includes(".") ||
      /(^|\.)(localhost|local|invalid|test|example|example\.com|example\.org|example\.net)$/.test(
        url.hostname,
      ) ||
      /^[\d.]+$/.test(url.hostname) ||
      url.hostname.startsWith("[")
    )
      throw Error();
  } catch {
    errors.push("WEAPP_API_BASE_URL：需要真实 HTTPS 域名根地址，不含 /api/v1、凭证或查询参数");
  }
  if (env.WEAPP_GALLERY === "1") errors.push("WEAPP_GALLERY：体验版不包含组件陈列页");
  return errors;
}

/** 只读公开接口；不静默登录、不创建账号、不输出响应体。 */
export async function probeTrialApi(baseUrl, fetcher = fetch, version = "0.1.0") {
  const checks = [
    ["引导接口", "/m/bootstrap", (data) => typeof data?.serverTime === "string"],
    [
      "登录协议",
      "/m/agreements?scene=login&limit=50",
      (data) => {
        if (!Array.isArray(data?.items)) return false;
        const items = data.items.filter((item) => item?.currentVersion != null);
        return (
          !data.hasMore &&
          items.length >= 1 &&
          items.length <= 2 &&
          new Set(items.map((item) => item.agreementKey)).size === items.length &&
          items.every(
            (item) =>
              typeof item.agreementKey === "string" &&
              typeof item.currentVersion?.agreementVersionId === "string",
          )
        );
      },
    ],
  ];
  const results = [];
  for (const [name, path, valid] of checks) {
    try {
      const response = await fetcher(`${baseUrl.replace(/\/+$/, "")}/api/v1${path}`, {
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
        headers: {
          "X-Client-Version": version,
          "X-Client-Platform": "devtools",
          "X-Env-Version": "trial",
          "X-Request-Id": randomUUID(),
        },
      });
      const body = response.ok ? await response.json() : null;
      results.push({ name, ok: response.ok && valid(body?.data) });
    } catch {
      results.push({ name, ok: false });
    }
  }
  return results;
}
