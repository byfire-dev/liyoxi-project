import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTaroMultipartPorts } from "./taro";
import type { CloudRequest } from "./multipart";

interface ReadOptions {
  filePath: string;
  position: number;
  length: number;
  encoding?: string;
  success(result: { data: string | ArrayBuffer }): void;
  fail(result: { errMsg: string }): void;
}
interface NativeResponse {
  statusCode: number;
  data: unknown;
  header: Record<string, unknown>;
}
const native = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn(), business: vi.fn() }));
vi.mock("@tarojs/taro", () => ({
  default: {
    getFileSystemManager: () => ({ readFile: native.read }),
    request: native.request,
  },
}));
vi.mock("../runtime", () => ({
  request: native.business,
  newIdempotencyKey: () => "file_complete:test",
}));
vi.mock("../account-runtime", () => ({ account: { snapshot: () => ({ me: null }) } }));
vi.mock("../platform.taro", () => ({ storage: { get: () => null, set() {}, remove() {} } }));
vi.mock("../../stores/context", () => ({
  useContextStore: { getState: () => ({ currentStoreId: null }), subscribe: () => () => {} },
}));
vi.mock("../../stores/session", () => ({
  useSessionStore: { getState: () => ({ accessToken: null }), subscribe: () => () => {} },
}));
vi.mock("../../stores/bootstrap", () => ({
  useBootstrapStore: { getState: () => ({ data: { uploadLimits: {} } }) },
}));

const request = (data?: string | ArrayBuffer): CloudRequest => ({
  url: "https://test-media-1250000000.cos.ap-beijing.myqcloud.com/incoming/file/clip.mp4?partNumber=1&uploadId=original",
  method: "PUT",
  headers: {
    Authorization: "q-signature=fictional",
    "content-md5": "fictional-base64",
    "x-cos-security-token": "fictional-sts",
  },
  ...(data === undefined ? {} : { data }),
});
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  native.read.mockReset();
  native.request.mockReset();
  native.business.mockReset();
});

describe("Taro原生multipart读写端口", () => {
  it("readFile精确左闭右开范围、不指定encoding，二进制完整交给调用方", async () => {
    const buffer = new Uint8Array([0, 128, 255, 1]).buffer;
    native.read.mockImplementation((options: ReadOptions) => options.success({ data: buffer }));
    expect(await createTaroMultipartPorts().read("wxfile://tmp/video", 256 * 1024, 4)).toEqual(
      new Uint8Array(buffer),
    );
    const options = native.read.mock.calls[0]![0] as ReadOptions;
    expect(options).toMatchObject({ filePath: "wxfile://tmp/video", position: 262144, length: 4 });
    expect(Object.hasOwn(options, "encoding")).toBe(false);
    expect(native.business).not.toHaveBeenCalled();
  });

  it.each([
    { offset: -1, length: 4 },
    { offset: 0.5, length: 4 },
    { offset: NaN, length: 4 },
    { offset: 0, length: 0 },
    { offset: 0, length: -1 },
    { offset: 0, length: 1.5 },
    { offset: 0, length: Infinity },
    { offset: Number.MAX_SAFE_INTEGER + 1, length: 4 },
  ])("非法范围 $offset/$length 不触碰原生文件", async ({ offset, length }) => {
    await expect(
      createTaroMultipartPorts().read("wxfile://tmp/video", offset, length),
    ).rejects.toThrow("范围");
    expect(native.read).not.toHaveBeenCalled();
  });

  it.each(["string", "short", "long", "fail"] as const)(
    "%s读取拒绝，不补零、不截断、不转编码",
    async (mode) => {
      native.read.mockImplementation((options: ReadOptions) => {
        if (mode === "fail") options.fail({ errMsg: "permission denied" });
        else
          options.success({
            data: mode === "string" ? "binary" : new Uint8Array(mode === "short" ? 3 : 5).buffer,
          });
      });
      await expect(createTaroMultipartPorts().read("wxfile://tmp/video", 8, 4)).rejects.toThrow();
      expect(native.request).not.toHaveBeenCalled();
    },
  );

  it("read迟到成功仍等待真实回调，不提前报告字节或启动网络", async () => {
    let captured!: ReadOptions;
    native.read.mockImplementation((options: ReadOptions) => {
      captured = options;
    });
    let settled = false;
    const pending = createTaroMultipartPorts()
      .read("wxfile://tmp/video", 8, 2)
      .then((value) => {
        settled = true;
        return value;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(native.request).not.toHaveBeenCalled();
    captured.success({ data: new Uint8Array([7, 9]).buffer });
    expect(await pending).toEqual(new Uint8Array([7, 9]));
    expect(settled).toBe(true);
  });

  it.each(["PUT", "POST", "GET"] as const)(
    "%s用原生request原样二进制/XML，固定text响应和300秒期限",
    async (method) => {
      const abort = vi.fn();
      native.request.mockReturnValue(
        Object.assign(
          Promise.resolve({
            statusCode: 200,
            data: "<Result>ok</Result>",
            header: { ETag: '"abcdef"' },
          }),
          { abort },
        ),
      );
      const exact = new Uint8Array([0, 128, 255]).buffer;
      const input = {
        ...request(
          method === "PUT"
            ? exact
            : method === "POST"
              ? "<CompleteMultipartUpload></CompleteMultipartUpload>"
              : undefined,
        ),
        method,
      };
      const task = createTaroMultipartPorts().send(input);
      expect(await task.done).toEqual({
        statusCode: 200,
        data: "<Result>ok</Result>",
        headers: { ETag: '"abcdef"' },
      });
      const options = native.request.mock.calls[0]![0];
      expect(options).toEqual({
        url: input.url,
        method,
        header: input.headers,
        data: input.data,
        dataType: "text",
        responseType: "text",
        timeout: 300000,
      });
      if (method === "PUT") expect(options.data).toBe(exact);
      expect(options.header).not.toHaveProperty("X-Store-Id");
      expect(Object.values(options.header)).not.toContain("Bearer");
      expect(native.business).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
    },
  );

  it("abort直达同一个原生RequestTask，done等待实际中止拒绝", async () => {
    const gate = deferred<NativeResponse>(),
      failure = new Error("native abort");
    const abort = vi.fn(() => gate.reject(failure));
    native.request.mockReturnValue(Object.assign(gate.promise, { abort }));
    const task = createTaroMultipartPorts().send(request(new Uint8Array([1]).buffer));
    const failed = expect(task.done).rejects.toBe(failure);
    task.abort();
    await failed;
    expect(abort).toHaveBeenCalledOnce();
    expect(native.request).toHaveBeenCalledOnce();
    expect(native.business).not.toHaveBeenCalled();
  });

  it.each(["json", "arraybuffer", "numeric_header", "object_header"] as const)(
    "%s响应严格拒绝，不把原生自动JSON误作COS XML",
    async (mode) => {
      const data =
        mode === "json"
          ? { result: "ok" }
          : mode === "arraybuffer"
            ? new ArrayBuffer(1)
            : "<Result></Result>";
      const header =
        mode === "numeric_header"
          ? { ETag: 123 }
          : mode === "object_header"
            ? { ETag: { value: "tag" } }
            : {};
      native.request.mockReturnValue(
        Object.assign(Promise.resolve({ statusCode: 200, data, header }), { abort: vi.fn() }),
      );
      await expect(createTaroMultipartPorts().send(request()).done).rejects.toThrow("响应");
    },
  );

  it("HTTP错误原文与status留给COS协议层，网络拒绝保留原错误", async () => {
    const errorXml = "<Error><Code>NoSuchUpload</Code></Error>";
    native.request.mockReturnValueOnce(
      Object.assign(Promise.resolve({ statusCode: 404, data: errorXml, header: {} }), {
        abort: vi.fn(),
      }),
    );
    expect(await createTaroMultipartPorts().send({ ...request(), method: "GET" }).done).toEqual({
      statusCode: 404,
      data: errorXml,
      headers: {},
    });
    const failure = new Error("network timeout");
    native.request.mockReturnValueOnce(Object.assign(Promise.reject(failure), { abort: vi.fn() }));
    await expect(createTaroMultipartPorts().send(request()).done).rejects.toBe(failure);
  });
});
