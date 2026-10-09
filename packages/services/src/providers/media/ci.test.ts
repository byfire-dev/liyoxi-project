import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCiMedia } from "./ci.js";
import type { CiConfig } from "./ci.js";
import { ciChild, ciText, parseCiXml } from "./xml.js";
const now = () => new Date("2026-10-08T00:00:00.000Z");
const userData = "019acdef-0000-7000-8000-000000000000:1";
const config: CiConfig = {
  region: "ap-beijing",
  buckets: {
    secure: "test-secure-1250000000",
    asset: "test-asset-1250000000",
    media: "test-media-1250000000",
    pub: "test-pub-1250000000",
  },
  worker: { secretId: "public-fake-id", secretKey: "public-fake-key" },
  callback: {
    origin: "https://callback.example.invalid",
    key: "public-fake-callback-key-32bytes-only",
  },
};
const detail = (state = "Submitted", data = userData, id = "jfixture") =>
  `<JobsDetail><JobId>${id}</JobId><State>${state}</State><Operation><UserData>${data}</UserData></Operation></JobsDetail>`;
const response = (body = detail(), token = "") =>
  `<Response>${body}${token ? `<NextToken>${token}</NextToken>` : ""}</Response>`;
const owned: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((close) => close()));
  vi.useRealTimers();
});
function driver(fetchImpl: typeof fetch) {
  const result = createCiMedia(config, { now, fetchImpl });
  owned.push(result.close);
  return result.provider;
}
const transcode = {
  src: { bucket: "media" as const, key: "input/a&b.mp4" },
  dst: { bucket: "media" as const, key: "output/target.mp4" },
  template: "public-template",
  userData,
};
describe("腾讯数据万象原生HTTP协议", () => {
  it("原生Image仅签固定同桶PNG，15分钟独立GET向量与完整XML节点", async () => {
    let sent = "";
    const provider = driver(async (_url, init) => {
      sent = String(init?.body);
      return new Response(response());
    });
    const key = `ci-out/019acdef-0000-7000-8000-000000000000/watermark-${"f".repeat(64)}.png`;
    expect(
      await provider.transcode({
        ...transcode,
        watermarks: [{ image: { bucket: "media", key }, position: "Center", transparency: 100 }],
      }),
    ).toHaveProperty("ok", true);
    const operation = ciChild(parseCiXml(sent), "Operation")!,
      mark = ciChild(operation, "Watermark")!,
      image = ciChild(mark, "Image")!,
      url = new URL(ciText(image, "Url")!);
    expect(url.origin).toBe("https://test-media-1250000000.cos.ap-beijing.myqcloud.com");
    expect(url.pathname).toBe(`/${key}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "q-sign-algorithm": "sha1",
      "q-ak": config.worker.secretId,
      "q-sign-time": "1791417600;1791418500",
      "q-key-time": "1791417600;1791418500",
      "q-header-list": "host",
      "q-url-param-list": "",
      "q-signature": "ff09b8f89aefba7f5def21ea93bbf15ad71556f2",
    });
    expect(ciText(mark, "Type")).toBe("Image");
    expect(ciText(mark, "Pos")).toBe("Center");
    expect(ciText(mark, "LocMode")).toBe("Absolute");
    expect(ciText(image, "Mode")).toBe("Original");
    expect(ciText(image, "Transparency")).toBe("100");
    expect(sent).not.toContain(config.worker.secretKey);
  });
  it("正式动态中文及AI空格不偷改Text，受控unsupported且零外呼", async () => {
    const send = vi.fn(async () => new Response(response())),
      provider = driver(send);
    for (const text of ["样片 · 仅供「测试门店」确认 · 10-09", "AI 生成"]) {
      expect(
        await provider.transcode({
          ...transcode,
          watermarks: [{ text, position: "Center", fontSize: 28, transparency: 100 }],
        }),
      ).toMatchObject({ ok: false, reason: "unsupported" });
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("Image拒绝跨桶/非固定key/额外URL、混合模板及超过3个节点", async () => {
    const send = vi.fn(async () => new Response(response())),
      provider = driver(send);
    const mark = {
      image: {
        bucket: "media" as const,
        key: `ci-out/019acdef-0000-7000-8000-000000000000/watermark-${"f".repeat(64)}.png`,
      },
      position: "Center" as const,
      transparency: 100,
    };
    const invalid: unknown[] = [
      [{ ...mark, image: { ...mark.image, bucket: "pub" } }],
      [{ ...mark, image: { ...mark.image, key: "https://example.invalid/sensitive.png" } }],
      [
        {
          ...mark,
          image: { ...mark.image, key: `ci-out/${"-".repeat(36)}/watermark-${"f".repeat(64)}.png` },
        },
      ],
      [{ ...mark, image: { ...mark.image, url: "https://example.invalid/" } }],
      [{ ...mark, url: "https://example.invalid/" }],
      [mark, { templateId: "fixed-template" }],
      [mark, mark, mark, mark],
      [null],
      [{ ...mark, transparency: 0 }],
    ];
    for (const watermarks of invalid)
      expect(
        await provider.transcode({ ...transcode, watermarks } as Parameters<
          typeof provider.transcode
        >[0]),
      ).toMatchObject({ ok: false, reason: "rejected" });
    expect(send).not.toHaveBeenCalled();
  });
  it("固定CI主机/查询路线/COSv5独立预期向量，经真实本机HTTP收到同签名", async () => {
    const received: string[] = [];
    const server = createServer((request, reply) => {
      received.push(request.headers.authorization ?? "");
      reply.writeHead(200, { "Content-Type": "application/xml" });
      reply.end(response());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    owned.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(
        "https://test-media-1250000000.ci.ap-beijing.myqcloud.com/jobs/jfixture",
      );
      expect(init?.redirect).toBe("error");
      return fetch(`http://127.0.0.1:${port}/fixture`, init);
    };
    expect(await driver(fetchImpl).describe!({ jobId: "jfixture", family: "media" })).toMatchObject(
      { ok: true, value: { jobId: "jfixture", state: "submitted", processed: true } },
    );
    // Python stdlib hashlib/hmac, independently evaluated official COSv5 formula; does not call production signer.
    expect(received).toEqual([
      "q-sign-algorithm=sha1&q-ak=public-fake-id&q-sign-time=1791417600;1791418200&q-key-time=1791417600;1791418200&q-header-list=host&q-url-param-list=&q-signature=a1fe51b4ad75a7025e6e2c67625f7342de826ba3",
    ]);
  });
  it("technical duration uses exact micros and shared rounding, no binary float drift", async () => {
    for (const [duration, milliseconds] of [
      ["1.000499", 1000],
      ["1.000500", 1001],
      ["999999999.999999", 1000000000000],
    ] as const) {
      const body = `<Response><JobsDetail><JobId>jfixture</JobId><State>Success</State><Operation><UserData>${userData}</UserData><MediaInfo><Format><Duration>${duration}</Duration><Size>18446744073709551615</Size></Format><Stream><Video><Width>1920</Width><Height>1080</Height></Video></Stream></MediaInfo></Operation></JobsDetail></Response>`;
      const provider = driver(async () => new Response(body));
      expect(await provider.describe!({ jobId: "jfixture", family: "media" })).toMatchObject({
        ok: true,
        value: {
          output: {
            durationMs: milliseconds,
            width: 1920,
            height: 1080,
            sizeBytes: "18446744073709551615",
          },
        },
      });
    }
  });
  it("提交XML转义、预定输出与UserData/签名callback；不存原始结果", async () => {
    let sent = "";
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toBe("https://test-media-1250000000.ci.ap-beijing.myqcloud.com/jobs");
      expect(init?.method).toBe("POST");
      sent = String(init?.body);
      return new Response(response());
    };
    expect(await driver(fetchImpl).transcode(transcode)).toMatchObject({
      ok: true,
      value: { processed: true, state: "submitted" },
    });
    expect(sent).toContain("input/a&amp;b.mp4");
    expect(sent).toContain(`<UserData>${userData}</UserData>`);
    expect(sent).toMatch(
      /\/api\/v1\/hooks\/ci\/media-jobs\/019acdef-0000-7000-8000-000000000000\?sig=[A-Za-z0-9_-]{43}/,
    );
    expect(sent).toContain("<CallBackFormat>JSON</CallBackFormat>");
    expect(sent).not.toContain(config.worker.secretKey);
  });
  it("文件打包用REST Rename/Flatten，文件查询走file_jobs，未经确认取消受控unsupported", async () => {
    const calls: string[] = [];
    let body = "";
    const provider = driver(async (url, init) => {
      calls.push(String(url));
      if (init?.body) body = String(init.body);
      return new Response(response());
    });
    expect(
      await provider.pack({
        bucket: "media",
        items: [{ key: "test/E01.mp4", name: "第一集.mp4" }],
        dstKey: "test/a.zip",
        userData,
      }),
    ).toHaveProperty("ok", true);
    expect(body).toContain("<Rename>第一集.mp4</Rename>");
    expect(body).toContain("<Flatten>0</Flatten>");
    expect(body).not.toContain("ReName");
    expect(await provider.describe!({ jobId: "jfixture", family: "file" })).toHaveProperty(
      "ok",
      true,
    );
    expect(calls[1]).toContain("/file_jobs/jfixture");
    expect(await provider.cancel!({ jobId: "jfixture", family: "file" })).toMatchObject({
      ok: false,
      reason: "unsupported",
    });
    expect(calls).toHaveLength(2);
  });
  it("按UserData逐页本地筛选而非造平台过滤参数；不同userdata不泄漏", async () => {
    const urls: string[] = [];
    const provider = driver(async (url) => {
      urls.push(String(url));
      return new Response(
        urls.length === 1
          ? response(detail("Success", "other-platform-sensitive-data", "junrelated"), "page2")
          : response(detail("Success")),
      );
    });
    const result = await provider.find!({
      family: "media",
      tag: "Transcode",
      userData,
      src: transcode.src,
      createdAfter: now(),
      createdBefore: new Date(now().getTime() + 1000),
    });
    expect(result).toMatchObject({
      ok: true,
      value: { complete: true, job: { jobId: "jfixture", userData } },
    });
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      const query = new URL(url).searchParams;
      expect(query.has("userData")).toBe(false);
      expect(query.get("states")).toBe("All");
      expect(query.get("size")).toBe("100");
    }
    expect(new URL(urls[1]!).searchParams.get("nextToken")).toBe("page2");
    expect(JSON.stringify(result)).not.toContain("other-platform-sensitive-data");
  });
  it("分页4页/循环token/多外部号不构造none完整证据", async () => {
    let calls = 0;
    const provider = driver(async () => new Response(response("", "page" + ++calls)));
    expect(
      await provider.find!({
        family: "file",
        tag: "FileCompress",
        userData,
        createdAfter: now(),
        createdBefore: new Date(now().getTime() + 1000),
      }),
    ).toMatchObject({ ok: true, value: { complete: false, job: null } });
    expect(calls).toBe(4);
    const duplicate = driver(
      async () => new Response(response(detail() + detail("Submitted", userData, "jsecond"))),
    );
    expect(
      await duplicate.find!({
        family: "media",
        tag: "Transcode",
        userData,
        createdAfter: now(),
        createdBefore: new Date(now().getTime() + 1000),
      }),
    ).toMatchObject({ ok: false, reason: "rejected" });
  });
  it.each([
    "<!DOCTYPE Response [<!ENTITY a SYSTEM 'file:///private'>]><Response>&a;</Response>",
    "<Response><JobsDetail><JobId>a</JobId><JobId>b</JobId><State>Success</State></JobsDetail></Response>",
    "<Response><JobsDetail><JobId>x</JobId><State>constructor</State></JobsDetail></Response>",
    "<Response><JobsDetail>",
  ])("坏XML/重复/未登记state受控拒绝 %#", async (body) => {
    expect(
      await driver(async () => new Response(body)).describe!({
        jobId: "jfixture",
        family: "media",
      }),
    ).toMatchObject({ ok: false, reason: "rejected" });
    expect(() =>
      parseCiXml("<Response>" + "<X>".repeat(33) + "</X>".repeat(33) + "</Response>"),
    ).toThrow();
  });
  it("200提交坏应答是受理未知；限流/5xx/重定向不自动重试", async () => {
    let calls = 0;
    const malformed = driver(async () => {
      calls++;
      return new Response("<broken>");
    });
    expect(await malformed.transcode(transcode)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(calls).toBe(1);
    for (const status of [302, 429, 503]) {
      let count = 0;
      const one = driver(async () => {
        count++;
        return new Response("", {
          status,
          headers: { Location: "https://secret.example.invalid" },
        });
      });
      expect(await one.transcode(transcode)).toHaveProperty("ok", false);
      expect(count).toBe(1);
    }
  });
  it("实际字节超限/虚假Content-Length会取消读取，不整段无界读取", async () => {
    let canceled = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel() {
        canceled++;
      },
    });
    const provider = driver(
      async () => new Response(stream, { headers: { "Content-Length": "1" } }),
    );
    expect(await provider.describe!({ jobId: "jfixture", family: "media" })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(canceled).toBe(1);
  });
  it("关闭和caller abort取消自己body/等待清理；构造无外呼，关闭后失败", async () => {
    let calls = 0,
      canceled = 0,
      read = false;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            read = true;
          },
          cancel() {
            canceled++;
          },
        }),
      );
    };
    const one = createCiMedia(config, { now, fetchImpl });
    expect(calls).toBe(0);
    const controller = new AbortController(),
      pending = one.provider.describe!({
        jobId: "jfixture",
        family: "media",
        signal: controller.signal,
      });
    await vi.waitFor(() => expect(read).toBe(true));
    controller.abort();
    expect(await pending).toHaveProperty("ok", false);
    expect(canceled).toBe(1);
    await one.close();
    expect(await one.provider.describe!({ jobId: "jfixture", family: "media" })).toHaveProperty(
      "ok",
      false,
    );
    expect(calls).toBe(1);
  });
  it("10秒请求期限取消在途body；media原生cancel仅一个PUT空应答", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let read = false,
      canceled = false;
    const provider = driver(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              read = true;
            },
            cancel() {
              canceled = true;
            },
          }),
        ),
    );
    const pending = provider.describe!({ jobId: "jfixture", family: "media" });
    await vi.waitFor(() => expect(read).toBe(true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ ok: false, reason: "unavailable" });
    expect(canceled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    let calls = 0;
    const canceler = driver(async (url, init) => {
      calls++;
      expect(String(url)).toBe(
        "https://test-media-1250000000.ci.ap-beijing.myqcloud.com/jobs/jfixture?cancel=",
      );
      expect(init?.method).toBe("PUT");
      return new Response("");
    });
    expect(await canceler.cancel!({ jobId: "jfixture", family: "media" })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(calls).toBe(1);
  });
  it("同步图片审核只映射Result；四桶固定COS origin，不透OCR/裸正文", async () => {
    const urls: string[] = [];
    const provider = driver(async (url) => {
      urls.push(String(url));
      return new Response(
        "<RecognitionResult><Result>1</Result><OCRResults><Text>fictional-sensitive</Text></OCRResults></RecognitionResult>",
      );
    });
    for (const bucket of ["secure", "asset", "media", "pub"] as const) {
      const result = await provider.audit({
        src: { bucket, key: "photo/a.png" },
        scenes: ["profile"],
        userData,
      });
      expect(result).toEqual({ ok: true, value: { verdict: "block", processed: true } });
      expect(urls.at(-1)).toContain(
        `${config.buckets[bucket]}.cos.ap-beijing.myqcloud.com/photo/a.png?`,
      );
      expect(JSON.stringify(result)).not.toContain("fictional-sensitive");
    }
  });
});
