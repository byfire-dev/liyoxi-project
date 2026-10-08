import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWechatClient,
  HTTP_TIMEOUT_MS,
  JSON_RESPONSE_BYTES,
  QR_RESPONSE_BYTES,
} from "./client.js";

const clients: ReturnType<typeof createWechatClient>[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
const make = (fetchImpl: typeof fetch, timeoutMs = HTTP_TIMEOUT_MS) => {
  const client = createWechatClient({ fetchImpl, timeoutMs });
  clients.push(client);
  return client;
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

describe("微信私有固定origin和有界客户端", () => {
  it("初始化零外呼、URLSearchParams保留秘密字符、stable只POST JSON", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ access_token: "test-token", expires_in: 345 }));
    const client = make(f);
    expect(f).not.toHaveBeenCalled();
    expect(
      await client.request({
        path: "/cgi-bin/stable_token",
        body: {
          appid: "wx-test",
          secret: "x&+?",
          grant_type: "client_credential",
          force_refresh: false,
        },
      }),
    ).toMatchObject({ ok: true });
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe("https://api.weixin.qq.com/cgi-bin/stable_token");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(JSON.parse(String(init?.body))).toMatchObject({ secret: "x&+?", force_refresh: false });
    await client.request({
      path: "/sns/jscode2session",
      query: { secret: "x&+?", js_code: "code#1" },
    });
    expect(new URL(String(f.mock.calls[1]![0])).searchParams.get("secret")).toBe("x&+?");
    expect(f.mock.calls[1]![1]?.method).toBe("GET");
  });
  it("未知路径/超限请求在任何fetch前拒绝", async () => {
    const f = vi.fn<typeof fetch>();
    const client = make(f);
    expect(
      await client.request({ path: "https://evil.invalid" as "/cgi-bin/stable_token" }),
    ).toMatchObject({ ok: false, reason: "rejected" });
    expect(
      await client.request({ path: "/wxa/msg_sec_check", body: { content: "字".repeat(30_000) } }),
    ).toMatchObject({ ok: false, reason: "rejected" });
    expect(f).not.toHaveBeenCalled();
  });
  it.each([302, 429, 500])("HTTP%s受控失败不暴露原错误", async (status) => {
    const result = await make(
      async () =>
        new Response("SECRET OPENID PHONE", {
          status,
          headers: { location: "https://evil.invalid/?secret=SECRET" },
        }),
    ).request({ path: "/cgi-bin/stable_token" });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|OPENID|PHONE|evil/);
  });
  it("200业务拒绝仅保留安全数字码，不漏errmsg", async () => {
    const result = await make(async () => json({ errcode: 40029, errmsg: "SECRET PHONE" })).request(
      { path: "/sns/jscode2session" },
    );
    expect(result).toMatchObject({ ok: false, reason: "rejected", code: 40029 });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PHONE/);
  });
  it("JSON畸形/unknown数字型不被误报成功", async () => {
    for (const body of ["[]", "{bad", '{"errcode":"0"}', '{"errcode":null}'])
      expect(
        await make(async () => new Response(body)).request({ path: "/cgi-bin/stable_token" }),
      ).toMatchObject({ ok: false, reason: "unavailable" });
    expect(
      await make(async () => json({ errcode: 999999, errmsg: "SECRET" })).request({
        path: "/cgi-bin/stable_token",
      }),
    ).toEqual({
      ok: false,
      reason: "unavailable",
      message: "微信HTTP请求未完成",
      status: 200,
      code: 999999,
    });
  });
  it("二维码真实magic和200JSON错误分开", async () => {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    expect(
      await make(
        async () => new Response(png, { headers: { "content-type": "text/html" } }),
      ).request({ path: "/wxa/getwxacodeunlimit" }),
    ).toMatchObject({ ok: true, value: { contentType: "image/png", bytes: png } });
    expect(
      await make(async () => json({ errcode: 41030, errmsg: "SECRET" })).request({
        path: "/wxa/getwxacodeunlimit",
      }),
    ).toMatchObject({ ok: false, code: 41030 });
    expect(
      await make(async () => new Response("<html>bad</html>")).request({
        path: "/wxa/getwxacodeunlimit",
      }),
    ).toMatchObject({ ok: false, reason: "unavailable" });
  });
  it("Content-Length与真实chunk双预算、取消reader", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(JSON_RESPONSE_BYTES + 1));
      },
      cancel,
    });
    expect(
      await make(async () => new Response(stream, { headers: { "content-length": "1" } })).request({
        path: "/cgi-bin/stable_token",
      }),
    ).toMatchObject({ ok: false, reason: "unavailable" });
    expect(cancel).toHaveBeenCalledTimes(1);
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { headers: { "content-length": String(QR_RESPONSE_BYTES + 1) } }),
      );
    expect(await make(f).request({ path: "/wxa/getwxacodeunlimit" })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });
  it("已取消请求零fetch，忽略abort的late fetch仍取消body", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const unused = vi.fn<typeof fetch>();
    expect(
      await make(unused).request({ path: "/cgi-bin/stable_token", signal: stopped.signal }),
    ).toMatchObject({ ok: false });
    expect(unused).not.toHaveBeenCalled();
    let resolve!: (value: Response) => void;
    const cancel = vi.fn();
    const client = make(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const pending = client.request({ path: "/cgi-bin/stable_token" });
    await client.close();
    expect(await pending).toMatchObject({ ok: false, reason: "unavailable" });
    resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });
  it("不合作的cancel不使close永远等待", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const client = make(async () => new Response(new ReadableStream<Uint8Array>({ cancel })));
    const pending = client.request({ path: "/cgi-bin/stable_token" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.close();
    expect(await pending).toMatchObject({ ok: false, reason: "unavailable" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

async function socketCase(
  action: (response: ServerResponse, request: IncomingMessage) => void,
  run: (client: ReturnType<typeof createWechatClient>, seen: () => number) => Promise<void>,
) {
  let closed = 0;
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => action(response, request));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      closed++;
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OWN_SOCKET_ADDRESS");
  const wrapper: typeof fetch = (url, init) => {
    expect(new URL(String(url)).origin).toBe("https://api.weixin.qq.com");
    return fetch(`http://127.0.0.1:${address.port}${new URL(String(url)).pathname}`, init);
  };
  const client = make(wrapper, 100);
  try {
    await run(client, () => closed);
  } finally {
    await client.close();
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("真实own loopback socket生命周期", () => {
  it("真实redirect不跟随到catcher", async () => {
    let catcher = 0;
    await socketCase(
      (response, request) => {
        if (request.url === "/redirected") {
          catcher++;
          response.end("SECRET");
        } else {
          response.writeHead(302, { location: "/redirected" });
          response.end("SECRET");
        }
      },
      async (client) => {
        expect(await client.request({ path: "/cgi-bin/stable_token" })).toMatchObject({
          ok: false,
          reason: "unavailable",
        });
        expect(catcher).toBe(0);
      },
    );
  });
  it("真实chunked大body超过JSON工程上限拒绝", async () => {
    await socketCase(
      (response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write("x".repeat(JSON_RESPONSE_BYTES));
        response.end("x");
      },
      async (client) => {
        expect(await client.request({ path: "/cgi-bin/stable_token" })).toMatchObject({
          ok: false,
          reason: "unavailable",
        });
      },
    );
  });
  it("慢header实际timeout关闭socket", async () => {
    await socketCase(
      () => {},
      async (client, seen) => {
        expect(await client.request({ path: "/cgi-bin/stable_token" })).toMatchObject({
          ok: false,
          reason: "unavailable",
        });
        await vi.waitFor(() => expect(seen()).toBeGreaterThan(0));
      },
    );
  });
  it("header后慢body实际timeout关闭socket", async () => {
    await socketCase(
      (response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"access_token":');
      },
      async (client, seen) => {
        expect(await client.request({ path: "/cgi-bin/stable_token" })).toMatchObject({
          ok: false,
          reason: "unavailable",
        });
        await vi.waitFor(() => expect(seen()).toBeGreaterThan(0));
      },
    );
  });
  it("close中止真实body并拒绝后续调用", async () => {
    await socketCase(
      (response) => {
        response.writeHead(200);
        response.write("{");
      },
      async (client, seen) => {
        const pending = client.request({ path: "/cgi-bin/stable_token" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await client.close();
        expect(await pending).toMatchObject({ ok: false, reason: "unavailable" });
        await vi.waitFor(() => expect(seen()).toBeGreaterThan(0));
        expect(await client.request({ path: "/cgi-bin/stable_token" })).toMatchObject({
          ok: false,
          reason: "unavailable",
        });
      },
    );
  });
  it("mid-body真实socket reset失败", async () => {
    await socketCase(
      (response) => {
        response.writeHead(200);
        response.write("{");
        response.socket?.destroy();
      },
      async (client) => {
        expect(await client.request({ path: "/cgi-bin/stable_token" })).toMatchObject({
          ok: false,
          reason: "unavailable",
        });
      },
    );
  });
});
