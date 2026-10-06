// 后台的防跨站检查（W1-01a；槽位 csrf，只给后台这一组；约定 C4；D4 第 6.5 节）。
// 非 GET 请求必须带 X-LYX-Admin: 1，且 Origin 与后台同源，否则 403 ORIGIN_REJECTED。登录前的公开接口同样要过。
// 表单发不出自定义头，跨源的 fetch 带自定义头要过预检，而后台不开 CORS。
// “与后台同源”（约定 C4、任务书 第 10 节第 4 项，不新增环境变量）：Origin 的协议、主机与端口与请求一致，
// 且这个 Host 按 host-guard 的判断属于后台（admin.<域名>）；local、test 下不认域名的地址（localhost）也算。
// 网关用 $http_host 保留浏览器请求里的端口；默认端口按实际请求协议归一化，协议取 client-ip 的可信代理判断。
import { AppError } from "@liyoxi/services";
import type { AppEnv } from "@liyoxi/services";

import type { RouteMiddlewareFactory } from "../../routing/types.js";
import { surfaceOf } from "../host-guard.js";

/** Origin 头里的 HTTP(S) 源；不是合法的源即 null */
function parseOrigin(origin: string | undefined): URL | null {
  if (origin === undefined) return null;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
      ? url
      : null;
  } catch {
    return null;
  }
}

/** 这次请求的 Origin 是不是后台自己的源 */
export function isAdminOrigin(
  origin: string | undefined,
  host: string | undefined,
  appEnv: AppEnv,
  protocol: "http" | "https",
): boolean {
  const from = parseOrigin(origin);
  if (from === null || host === undefined) return false;
  // URL 按实际协议归一化默认端口；不能用 Origin 自报的协议解释 Host。
  const expected = parseOrigin(`${protocol}://${host}`);
  if (expected === null || from.origin !== expected.origin) return false;
  const surface = surfaceOf(host);
  return surface === "admin" || (surface === null && (appEnv === "local" || appEnv === "test"));
}

export const adminCsrf: RouteMiddlewareFactory = (route, runtime) => {
  if (route.method === "get") return null;
  const appEnv = runtime.env.APP_ENV;
  return async (c, next) => {
    // 没有 Host 头（用例里直接调应用）就取请求地址里的
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (
      c.req.header("x-lyx-admin") !== "1" ||
      !isAdminOrigin(c.req.header("origin"), host, appEnv, c.var.requestProtocol)
    ) {
      throw new AppError("ORIGIN_REJECTED");
    }
    await next();
  };
};
