import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { readBoundedBody } from "./bounded-body.js";
import { createMinioStorage, LOCAL_MINIO } from "./minio.js";

const ETAG = '"bounded-object"';
const REF = { bucket: "secure", key: "files/virtual/bounded.pdf" } as const;

async function withS3(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
  action: (storage: ReturnType<typeof createMinioStorage>, sockets: Set<Socket>) => Promise<void>,
) {
  const sockets = new Set<Socket>();
  const server = createServer(respond);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("未取得本地测试端口");
  const storage = createMinioStorage({
    ...LOCAL_MINIO,
    endpoint: `http://127.0.0.1:${address.port}`,
    accessKey: "fakepubliclocal",
    secretKey: "fakepubliclocal",
  });
  try {
    await action(storage, sockets);
  } finally {
    storage.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 1_000 });
  }
}

function head(response: ServerResponse, size = 4, etag: string | undefined = ETAG) {
  response.setHeader("Content-Length", String(size));
  if (etag) response.setHeader("ETag", etag);
  response.end();
}

describe("完整对象读取：对抗本地 S3 响应", () => {
  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "maxBytes=%s 不发起网络请求",
    async (maxBytes) => {
      const respond = vi.fn((_request: IncomingMessage, response: ServerResponse) =>
        head(response),
      );
      await withS3(respond, async (storage) => {
        expect(await storage.readObject({ ...REF, maxBytes })).toMatchObject({
          ok: false,
          reason: "rejected",
        });
        expect(respond).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    { size: 5, etag: ETAG },
    { size: 4, etag: "" },
    { size: 4, etag: '"changed"' },
  ])("不合格 HEAD 不发 GET：$size / $etag", async ({ size, etag }) => {
    const methods: string[] = [];
    await withS3(
      (request, response) => {
        methods.push(request.method ?? "");
        head(response, size, etag);
      },
      async (storage) => {
        expect(await storage.readObject({ ...REF, maxBytes: 4, ifMatchEtag: ETAG })).toMatchObject({
          ok: false,
          reason: "rejected",
        });
        expect(methods).toEqual(["HEAD"]);
      },
    );
  });

  it("HEAD 缺少大小声明时拒绝，不用 GET 猜测大小", async () => {
    const methods: string[] = [];
    await withS3(
      (request, response) => {
        methods.push(request.method ?? "");
        response.setHeader("ETag", ETAG);
        response.end();
      },
      async (storage) => {
        expect(await storage.readObject({ ...REF, maxBytes: 4 })).toMatchObject({
          ok: false,
          reason: "rejected",
        });
        expect(methods).toEqual(["HEAD"]);
      },
    );
  });

  it("未给调用 etag 时 GET 也绑定 HEAD；边界与返回缓冲区独立", async () => {
    const source = Buffer.from([1, 2, 3, 4]);
    const conditions: Array<string | undefined> = [];
    await withS3(
      (request, response) => {
        if (request.method === "HEAD") head(response);
        else {
          conditions.push(request.headers["if-match"]);
          response.setHeader("ETag", ETAG);
          response.end(source);
        }
      },
      async (storage) => {
        const result = await storage.readObject({ ...REF, maxBytes: 4 });
        expect(result).toEqual({ ok: true, value: new Uint8Array(source) });
        expect(conditions).toEqual([ETAG]);
        if (!result.ok) throw new Error("未读取到对象");
        result.value[0] = 9;
        expect(source[0]).toBe(1);
      },
    );
  });

  it("HEAD 后对象更换：IfMatch 被服务端拒绝", async () => {
    let condition: string | undefined;
    await withS3(
      (request, response) => {
        if (request.method === "HEAD") head(response);
        else {
          condition = request.headers["if-match"];
          response.writeHead(412, { "Content-Type": "application/xml" });
          response.end("<Error><Code>PreconditionFailed</Code></Error>");
        }
      },
      async (storage) => {
        expect(await storage.readObject({ ...REF, maxBytes: 4 })).toMatchObject({
          ok: false,
          reason: "rejected",
        });
        expect(condition).toBe(ETAG);
      },
    );
  });

  it.each(["etag", "size"])("GET %s 与 HEAD 不同立即销毁响应", async (mismatch) => {
    await withS3(
      (request, response) => {
        if (request.method === "HEAD") head(response);
        else {
          response.setHeader("ETag", mismatch === "etag" ? '"changed"' : ETAG);
          if (mismatch === "size") response.setHeader("Content-Length", "5");
          response.write(Buffer.from([1]));
        }
      },
      async (storage, sockets) => {
        expect(await storage.readObject({ ...REF, maxBytes: 4 })).toMatchObject({
          ok: false,
          reason: "rejected",
        });
        await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 1_000 });
      },
    );
  });

  it.each([4, 8])("HEAD 低报且 GET 流超界（maxBytes=%s）：关闭未结束响应", async (maxBytes) => {
    await withS3(
      (request, response) => {
        if (request.method === "HEAD") head(response);
        else {
          response.setHeader("ETag", ETAG);
          response.write(Buffer.from([1, 2, 3]));
          response.write(Buffer.from([4, 5]));
        }
      },
      async (storage, sockets) => {
        expect(await storage.readObject({ ...REF, maxBytes })).toMatchObject({
          ok: false,
          reason: "rejected",
          message: "对象实际大小超过读取上限或对象头声明",
        });
        await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 1_000 });
      },
    );
  });

  it("GET 短流拒绝，不能返回不足 HEAD 的字节", async () => {
    await withS3(
      (request, response) => {
        if (request.method === "HEAD") head(response);
        else {
          response.setHeader("ETag", ETAG);
          response.write(Buffer.from([1, 2]));
          response.end();
        }
      },
      async (storage) => {
        expect(await storage.readObject({ ...REF, maxBytes: 4 })).toMatchObject({
          ok: false,
          reason: "rejected",
          message: "对象实际大小与对象头不一致",
        });
      },
    );
  });

  it.each(["HEAD", "GET", "STREAM"])("%s 取消及时回收连接", async (phase) => {
    const controller = new AbortController();
    let reached!: () => void;
    const ready = new Promise<void>((resolve) => (reached = resolve));
    await withS3(
      (request, response) => {
        if (request.method === "HEAD") {
          if (phase === "HEAD") reached();
          else head(response);
        } else if (phase === "GET") reached();
        else {
          response.setHeader("ETag", ETAG);
          response.write(Buffer.from([1]));
          reached();
        }
      },
      async (storage, sockets) => {
        const pending = storage.readObject({ ...REF, maxBytes: 4, signal: controller.signal });
        await ready;
        // 流分支让已发出的第一个字节进入消费阶段，再中断未结束的响应。
        if (phase === "STREAM") await new Promise((resolve) => setTimeout(resolve, 30));
        const started = performance.now();
        controller.abort();
        expect(await pending).toMatchObject({
          ok: false,
          reason: "rejected",
          message: "对象读取已取消",
        });
        expect(performance.now() - started).toBeLessThan(1_000);
        await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 1_000 });
      },
    );
  });

  it("已取消不发 HEAD", async () => {
    const controller = new AbortController();
    controller.abort();
    const respond = vi.fn((_request: IncomingMessage, response: ServerResponse) => head(response));
    await withS3(respond, async (storage) => {
      expect(
        await storage.readObject({ ...REF, maxBytes: 4, signal: controller.signal }),
      ).toMatchObject({ ok: false, reason: "rejected", message: "对象读取已取消" });
      expect(respond).not.toHaveBeenCalled();
    });
  });
});

describe("有界流：销毁、取消与错误", () => {
  it("Node 流错误会销毁流，不带对象正文的异常消息", async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error("private-document-body"));
      },
    });
    expect(await readBoundedBody(stream, 4, 4)).toEqual({
      ok: false,
      reason: "unavailable",
      message: "对象响应流读取失败",
    });
    expect(stream.destroyed).toBe(true);
  });

  it("Web 流超限会 cancel 并释放 reader，不能接着消费", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
      },
      cancel,
    });
    expect(await readBoundedBody(stream, 4, 4)).toMatchObject({ ok: false, reason: "rejected" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("Web 流等待下一块时取消及时完成，不留下 reader/abort listener", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = readBoundedBody(stream, 4, 4, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({
      ok: false,
      reason: "rejected",
      message: "对象读取已取消",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
