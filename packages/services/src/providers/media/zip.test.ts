import { afterEach, describe, expect, it, vi } from "vitest";
import { createCiMedia } from "./ci.js";
import type { CiConfig } from "./ci.js";
import { ciChild, ciText, parseCiXml } from "./xml.js";
import { createLocalMedia, unconfiguredMedia } from "../unconfigured.js";

const now = () => new Date("2026-10-08T00:00:00.000Z");
const userData = "019acdef-0000-7000-8000-000000000000:2";
const src = { bucket: "media", key: "pkg/output &.zip" } as const;
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
const location =
  "<Region>ap-beijing</Region><Bucket>test-media-1250000000</Bucket><Object>pkg/output &amp;.zip</Object>";
const compress = `<FileCompressResult>${location}<CompressFileCount>2</CompressFileCount></FileCompressResult>`;
const job = (result = compress, state = "Success", tag = "FileCompress") =>
  `<Response><JobsDetail><JobId>fzip</JobId><Tag>${tag}</Tag><State>${state}</State><Operation><Output>${location}</Output>${result}<UserData>${userData}</UserData><UserInfo>private-ignored</UserInfo></Operation></JobsDetail></Response>`;
const contents = (name = "第一集.mp4", size = "5368709120") =>
  `<Contents><Key>${name}</Key><UncompressedSize>${size}</UncompressedSize><LastModified>ignored</LastModified></Contents>`;
const directory = `<Response><FileNumber>2</FileNumber>${contents()}${contents("发布清单.txt", "20")}<IsTruncated>false</IsTruncated></Response>`;
const owned: Array<() => Promise<void>> = [];
function driver(fetchImpl: typeof fetch, region = config.region) {
  const result = createCiMedia({ ...config, region }, { now, fetchImpl });
  owned.push(result.close);
  return result;
}
afterEach(async () => {
  await Promise.all(owned.splice(0).map((close) => close()));
  vi.useRealTimers();
});

describe("FileCompress提交和白名单结果", () => {
  it("完整KeyConfig保留清单与中文名称，查询核验目标且不透原始信息", async () => {
    let sent = "";
    const provider = driver(async (url, init) => {
      if (init?.method === "POST") {
        expect(String(url)).toBe("https://test-media-1250000000.ci.ap-beijing.myqcloud.com/jobs");
        sent = String(init.body);
        return new Response(job("", "Submitted"));
      }
      expect(String(url)).toBe(
        "https://test-media-1250000000.ci.ap-beijing.myqcloud.com/file_jobs/fzip",
      );
      return new Response(job());
    }).provider;
    expect(
      await provider.pack({
        bucket: "media",
        dstKey: src.key,
        userData,
        items: [
          { key: "files/e&1.mp4", name: "第一集.mp4" },
          { key: "pkg/list.txt", name: "发布清单.txt" },
        ],
      }),
    ).toMatchObject({ ok: true, value: { jobId: "fzip", state: "submitted", processed: true } });
    const operation = ciChild(parseCiXml(sent), "Operation")!,
      recipe = ciChild(operation, "FileCompressConfig")!;
    expect(
      recipe.children
        .filter((one) => one.name === "KeyConfig")
        .map((one) => [ciText(one, "Key"), ciText(one, "Rename")]),
    ).toEqual([
      ["files/e&1.mp4", "第一集.mp4"],
      ["pkg/list.txt", "发布清单.txt"],
    ]);
    expect(ciText(recipe, "Format")).toBe("zip");
    expect(ciText(recipe, "IgnoreError")).toBe("false");
    expect(ciText(recipe, "Flatten")).toBe("0");
    expect(ciChild(recipe, "Prefix")).toBeUndefined();
    expect(ciChild(recipe, "UrlList")).toBeUndefined();
    expect(ciText(operation, "UserData")).toBe(userData);
    expect(await provider.describe!({ jobId: "fzip", family: "file" })).toEqual({
      ok: true,
      value: {
        jobId: "fzip",
        state: "succeeded",
        processed: true,
        userData,
        output: { zip: { dst: src, fileCount: 2, errorCount: 0 } },
      },
    });
  });

  it.each([
    job(""),
    job().replace("<Output>" + location + "</Output>", ""),
    job().replaceAll("ap-beijing", "ap-shanghai"),
    job().replaceAll("test-media-1250000000", "test-pub-1250000000"),
    job(compress.replace("pkg/output &amp;.zip", "pkg/other.zip")),
    job(compress.replace("pkg/output &amp;.zip", "../outside.zip")),
    job(compress.replace("<CompressFileCount>2</CompressFileCount>", "")),
    job(
      compress.replace(
        "<CompressFileCount>2</CompressFileCount>",
        "<CompressFileCount>0</CompressFileCount>",
      ),
    ),
    job(
      compress.replace(
        "<CompressFileCount>2</CompressFileCount>",
        "<CompressFileCount>1001</CompressFileCount>",
      ),
    ),
    job(
      compress.replace(
        "</FileCompressResult>",
        "<CompressFileCount>2</CompressFileCount></FileCompressResult>",
      ),
    ),
    job(
      compress.replace(
        "</FileCompressResult>",
        "<ErrorDetail><ErrorCount>1</ErrorCount><ErrorFile>private.mp4</ErrorFile></ErrorDetail></FileCompressResult>",
      ),
    ),
    job(
      compress.replace(
        "</FileCompressResult>",
        "<ErrorDetail><ErrorCount>0</ErrorCount><ErrorFile/></ErrorDetail></FileCompressResult>",
      ),
    ),
    job(compress, "Success", "Transcode"),
    job("", "Success", "Transcode"),
  ])("成功状态缺少有效完整压缩证明即拒绝 %#", async (body) => {
    const result = await driver(async () => new Response(body)).provider.describe!({
      jobId: "fzip",
      family: "file",
    });
    expect(result).toMatchObject({ ok: false, reason: "rejected" });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each(["Submitted", "Running", "Failed", "Cancel"])(
    "未成功%s不要求结果节点且不生成ZIP事实",
    async (state) => {
      const result = await driver(async () => new Response(job("", state))).provider.describe!({
        jobId: "fzip",
        family: "file",
      });
      expect(result).toMatchObject({ ok: true, value: { output: {} } });
    },
  );

  it("未知提交仍unavailable；归属错误或不安全成员名零提交", async () => {
    const send = vi.fn(async () => new Response(job(""))),
      provider = driver(send).provider,
      input = {
        bucket: "media" as const,
        dstKey: src.key,
        userData,
        items: [{ key: "files/e.mp4", name: "第一集.mp4" }],
      };
    expect(await provider.pack(input)).toMatchObject({ ok: false, reason: "unavailable" });
    send.mockClear();
    for (const name of [
      "../episode.mp4",
      "C:\\episode.mp4",
      "/absolute.mp4",
      "folder/",
      "bad\u0000.mp4",
    ])
      expect(
        await provider.pack({ ...input, items: [{ key: "files/e.mp4", name }] }),
      ).toMatchObject({ ok: false, reason: "rejected" });
    expect(await provider.pack({ ...input, bucket: "pub" })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(
      await provider.pack({ ...input, items: [...input.items, ...input.items] }),
    ).toMatchObject({ ok: false, reason: "rejected" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("ZIP目录预览的有界协议", () => {
  it("固定COS对象、编码和独立签名向量，5GiB成员只返回目录元数据", async () => {
    const provider = driver(async (url, init) => {
      expect(String(url)).toBe(
        "https://test-media-1250000000.cos.ap-beijing.myqcloud.com/pkg/output%20%26.zip?ci-process=zippreview",
      );
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      // Independently calculated with Python hashlib/hmac and public fake credentials.
      expect(headers.get("authorization")).toBe(
        "q-sign-algorithm=sha1&q-ak=public-fake-id&q-sign-time=1791417600;1791418200&q-key-time=1791417600;1791418200&q-header-list=host&q-url-param-list=ci-process&q-signature=08045bb9923e79acc774187a999d018ca5d58864",
      );
      expect(headers.has("if-match")).toBe(false);
      return new Response(directory);
    }).provider;
    expect(await provider.previewZip!({ src })).toEqual({
      ok: true,
      value: {
        fileCount: 2,
        truncated: false,
        entries: [
          { name: "第一集.mp4", sizeBytes: "5368709120" },
          { name: "发布清单.txt", sizeBytes: "20" },
        ],
      },
    });
  });

  it.each([
    directory.replace("<IsTruncated>false</IsTruncated>", ""),
    directory.replace("<IsTruncated>false", "<IsTruncated>true"),
    directory.replace("<FileNumber>2", "<FileNumber>1"),
    directory.replace("<FileNumber>2", "<FileNumber>1000"),
    directory.replace("发布清单.txt", "第一集.mp4"),
    directory.replace("第一集.mp4", "../第一集.mp4"),
    directory.replace("第一集.mp4", "C:\\第一集.mp4"),
    directory.replace("第一集.mp4", "folder/"),
    directory.replace("<UncompressedSize>20", "<UncompressedSize>-1"),
    directory.replace("<UncompressedSize>20", "<UncompressedSize>1.5"),
    directory.replace("<UncompressedSize>20", "<UncompressedSize>18446744073709551616"),
    directory.replace("<UncompressedSize>20</UncompressedSize>", ""),
    directory.replace(
      "<FileNumber>2</FileNumber>",
      "<FileNumber>2</FileNumber><FileNumber>2</FileNumber>",
    ),
    "<!DOCTYPE Response><Response/>",
  ])("截断/缺失/重复/越界目录拒绝 %#", async (body) => {
    expect(
      await driver(async () => new Response(body)).provider.previewZip!({ src }),
    ).toMatchObject({ ok: false, reason: "rejected" });
  });

  it("不支持地域、跨桶和越界对象不外呼，未配置/本地不伪造成功", async () => {
    const send = vi.fn(async () => new Response(directory));
    expect(await driver(send, "ap-tokyo").provider.previewZip!({ src })).toMatchObject({
      ok: false,
      reason: "unsupported",
    });
    const provider = driver(send).provider;
    for (const invalid of [
      { ...src, bucket: "pub" as const },
      { ...src, key: "../outside.zip" },
      { ...src, key: "https://other.invalid/a.zip" },
    ])
      expect(await provider.previewZip!({ src: invalid })).toMatchObject({
        ok: false,
        reason: "rejected",
      });
    expect(send).not.toHaveBeenCalled();
    expect(await unconfiguredMedia.previewZip!({ src })).toMatchObject({
      ok: false,
      reason: "unconfigured",
    });
    expect(await createLocalMedia().previewZip!({ src })).toMatchObject({
      ok: false,
      reason: "unsupported",
    });
  });

  it("实际body超过2MiB即取消；不信虚报Content-Length", async () => {
    let canceled = false;
    const provider = driver(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
            },
            cancel() {
              canceled = true;
            },
          }),
          { headers: { "content-length": "1" } },
        ),
    ).provider;
    expect(await provider.previewZip!({ src })).toMatchObject({ ok: false, reason: "rejected" });
    expect(canceled).toBe(true);
  });

  it.each(["caller", "close", "timeout"])("%s取消预览body并等待清理", async (kind) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let reading = false,
      canceled = false;
    const one = driver(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              reading = true;
            },
            cancel() {
              canceled = true;
            },
          }),
        ),
    );
    const controller = new AbortController(),
      pending = one.provider.previewZip!({ src, signal: controller.signal });
    await vi.waitFor(() => expect(reading).toBe(true));
    if (kind === "caller") controller.abort();
    else if (kind === "close") await one.close();
    else await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ ok: false, reason: "unavailable" });
    expect(canceled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
