// 客户端 IP 的取法（任务书 W0-22b 第 7 节第 5 条；D4 第 9.5 节）。
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiBindings, ApiEnv } from "../context.js";

import { clientIp, createClientIpResolver, normalizeIp } from "./client-ip.js";
import type { TrustedProxySettings } from "./client-ip.js";

describe("客户端 IP", () => {
  const oneHop = createClientIpResolver();

  it("对端不在可信网段：取对端，转发头一概不看", () => {
    expect(oneHop("203.0.113.7", "1.2.3.4")).toBe("203.0.113.7");
    expect(oneHop("203.0.113.7", undefined)).toBe("203.0.113.7");
  });

  it("对端在可信网段：从右数第 N 个；伪造在左侧的值不起作用", () => {
    expect(oneHop("10.0.0.5", "198.51.100.9")).toBe("198.51.100.9");
    expect(oneHop("127.0.0.1", "6.6.6.6, 198.51.100.9")).toBe("198.51.100.9");
    expect(oneHop("::ffff:172.17.0.1", " 6.6.6.6 ,198.51.100.9 ")).toBe("198.51.100.9");
    const twoHops = createClientIpResolver({ hops: 2, cidrs: ["10.0.0.0/8"] });
    expect(twoHops("10.0.0.5", "6.6.6.6, 198.51.100.9, 10.0.0.9")).toBe("198.51.100.9");
  });

  it("转发链不够长、那一格不是 IP：取对端", () => {
    const twoHops = createClientIpResolver({ hops: 2, cidrs: ["10.0.0.0/8"] });
    expect(twoHops("10.0.0.5", "198.51.100.9")).toBe("10.0.0.5");
    expect(oneHop("10.0.0.5", "")).toBe("10.0.0.5");
    expect(oneHop("10.0.0.5", "unknown")).toBe("10.0.0.5");
  });

  it("跳数为 0：不看转发头；拿不到对端：null", () => {
    const direct = createClientIpResolver({ hops: 0, cidrs: ["10.0.0.0/8"] });
    expect(direct("10.0.0.5", "198.51.100.9")).toBe("10.0.0.5");
    expect(oneHop(undefined, "198.51.100.9")).toBeNull();
    expect(oneHop("not-an-ip", "198.51.100.9")).toBeNull();
  });

  it("IPv6：可信网段、IPv4 映射地址、大小写都认得", () => {
    expect(oneHop("::1", "2001:DB8::1")).toBe("2001:db8::1");
    expect(oneHop("fd00::5", "198.51.100.9")).toBe("198.51.100.9");
    expect(oneHop("2001:db8::5", "198.51.100.9")).toBe("2001:db8::5");
    expect(normalizeIp("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(normalizeIp("[2001:db8::1]")).toBe("2001:db8::1");
  });

  it("配置写错即抛错", () => {
    expect(() => createClientIpResolver({ hops: -1, cidrs: [] })).toThrow(RangeError);
    expect(() => createClientIpResolver({ hops: 1, cidrs: ["10.0.0.0/33"] })).toThrow(RangeError);
    expect(() => createClientIpResolver({ hops: 1, cidrs: ["lb.internal"] })).toThrow(RangeError);
    // 单个地址也可以
    expect(
      createClientIpResolver({ hops: 1, cidrs: ["192.0.2.10"] })("192.0.2.10", "5.5.5.5"),
    ).toBe("5.5.5.5");
  });
});

describe("请求协议与客户端 IP 共用可信代理边界", () => {
  async function protocolOf(
    url: string,
    bindings: ApiBindings,
    forwarded?: string,
    settings: TrustedProxySettings = { hops: 1, cidrs: ["10.0.0.0/8"] },
  ) {
    const app = new Hono<ApiEnv>();
    app.use("*", clientIp(settings));
    app.get("/", (c) => c.json({ protocol: c.var.requestProtocol }));
    const response = await app.request(
      url,
      {
        headers: forwarded === undefined ? {} : { "x-forwarded-proto": forwarded },
      },
      bindings,
    );
    return (await response.json()) as { protocol: string };
  }

  it("实际连接优先：直连 TLS 是 https，HTTP 的 absolute-form URL 不能伪装 TLS；无套接字时取 URL", async () => {
    expect(
      await protocolOf("http://localhost/", {
        incoming: { socket: { remoteAddress: "203.0.113.7", encrypted: true } },
      }),
    ).toEqual({ protocol: "https" });
    expect(
      await protocolOf("https://localhost/", {
        incoming: { socket: { remoteAddress: "203.0.113.7" } },
      }),
    ).toEqual({ protocol: "http" });
    expect(await protocolOf("https://localhost/", {}, "http")).toEqual({ protocol: "https" });
  });

  it("仅可信对端的单值 http/https 能改变协议，IPv4 映射地址沿用原可信网段判断", async () => {
    const trusted = { incoming: { socket: { remoteAddress: "::ffff:10.0.0.8" } } };
    expect(await protocolOf("http://localhost/", trusted, "https")).toEqual({ protocol: "https" });
    expect(await protocolOf("http://localhost/", trusted, "http")).toEqual({ protocol: "http" });
    expect(
      await protocolOf(
        "http://localhost/",
        { incoming: { socket: { remoteAddress: "203.0.113.7" } } },
        "https",
      ),
    ).toEqual({ protocol: "http" });
  });

  it("跳数0、多个协议与非法协议都不采纳转发头", async () => {
    const trusted = { incoming: { socket: { remoteAddress: "10.0.0.8" } } };
    expect(
      await protocolOf("http://localhost/", trusted, "https", { hops: 0, cidrs: ["10.0.0.0/8"] }),
    ).toEqual({ protocol: "http" });
    for (const value of ["https, http", "HTTPS", "ftp", ""]) {
      expect(await protocolOf("http://localhost/", trusted, value)).toEqual({ protocol: "http" });
    }
  });
});
