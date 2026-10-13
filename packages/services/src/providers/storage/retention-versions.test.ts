import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import type * as AwsSdk from "@aws-sdk/client-s3";
import { createCosStorage } from "./cos.js";
import type { CosConfig } from "./cos.js";
import { createMinioStorage } from "./minio.js";

const aws = vi.hoisted(() => ({
  send: vi.fn<
    (command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<Record<string, unknown>>
  >(),
}));
vi.mock("@aws-sdk/client-s3", async (original) => {
  const actual = await original<typeof AwsSdk>();
  return {
    ...actual,
    S3Client: class {
      send = aws.send;
      destroy() {}
    },
  };
});
const config: CosConfig = {
  region: "ap-beijing",
  worker: { secretId: "retentionfake", secretKey: "retentionfakekey" },
  buckets: {
    secure: "test-secure-1250000000",
    asset: "test-asset-1250000000",
    media: "test-media-1250000000",
    pub: "test-pub-1250000000",
  },
};
const ref = { bucket: "asset" as const, key: "retained/file.png" };
const closed: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(closed.splice(0).map((driver) => driver.close()));
  aws.send.mockReset();
});
type Call = { url: URL; method: string; signal: AbortSignal | null | undefined };
function cos(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      signal: init?.signal,
    };
    calls.push(call);
    return reply(call);
  };
  const driver = createCosStorage(config, {
    now: () => new Date("2026-01-05T04:00:00Z"),
    fetchImpl,
  });
  closed.push(driver);
  return { driver, calls };
}
const xml = (body: string, status = 200) => new Response(body, { status });
const enabled = (state = "Enabled") =>
  xml(`<VersioningConfiguration><Status>${state}</Status></VersioningConfiguration>`);
const entry = (id: string, key = ref.key, marker = false) =>
  `<${marker ? "DeleteMarker" : "Version"}><Key>${key}</Key><VersionId>${id}</VersionId></${marker ? "DeleteMarker" : "Version"}>`;
const list = (body: string, ending = "<IsTruncated>false</IsTruncated>") =>
  xml(`<ListVersionsResult>${body}${ending}</ListVersionsResult>`);

describe("W3-06真实存储驱动的保留版本协议", () => {
  it("COS Suspended仍遍历历史与marker，跨页完整后只删精确key；缺分页完成标志零删除", async () => {
    const e = cos(({ url, method }) => {
      if (url.searchParams.has("versioning")) return enabled("Suspended");
      if (url.searchParams.has("versions"))
        return url.searchParams.has("key-marker")
          ? list(entry("version-last") + entry("neighbor-last", ref.key + ".other"))
          : list(
              entry("marker", ref.key, true) +
                entry("version-first") +
                entry("neighbor", ref.key + ".other"),
              `<IsTruncated>true</IsTruncated><NextKeyMarker>${ref.key}</NextKeyMarker><NextVersionIdMarker>version-first</NextVersionIdMarker>`,
            );
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (method === "HEAD") return new Response(null, { status: 404 });
      throw new Error("未登记协议请求");
    });
    expect(await e.driver.eraseVersions({ ...ref, signal: new AbortController().signal })).toEqual({
      ok: true,
      value: undefined,
    });
    const deletes = e.calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.url.searchParams.get("versionId"))).toEqual([
      "marker",
      "version-first",
      "version-last",
    ]);
    expect(deletes.every((call) => call.url.pathname === `/${ref.key}`)).toBe(true);
    const pages = e.calls.filter((call) => call.url.searchParams.has("versions"));
    expect(pages).toHaveLength(2);
    expect(pages[1]!.url.searchParams.get("key-marker")).toBe(ref.key);
    expect(pages[1]!.url.searchParams.get("version-id-marker")).toBe("version-first");
    const incomplete = cos(({ url }) =>
      url.searchParams.has("versioning") ? enabled() : list(entry("do-not-delete"), ""),
    );
    expect(
      await incomplete.driver.eraseVersions({ ...ref, signal: new AbortController().signal }),
    ).toMatchObject({ ok: false, reason: "unavailable" });
    expect(
      incomplete.calls.some((call) => call.method === "DELETE" || call.method === "HEAD"),
    ).toBe(false);
  });

  it("COS恢复只移除目标marker，HEAD失败不报成功；在途AbortSignal中断版本读取且不删对象", async () => {
    const e = cos(({ url, method }) => {
      if (url.searchParams.has("versioning")) return enabled();
      if (url.searchParams.has("versions"))
        return list(
          entry("older-content") +
            entry("latest-marker", ref.key, true) +
            entry("neighbor-marker", ref.key + "-neighbor", true),
        );
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (method === "HEAD") return new Response(null, { status: 500 });
      throw new Error("未登记协议请求");
    });
    expect(
      await e.driver.restoreVersions({ ...ref, signal: new AbortController().signal }),
    ).toMatchObject({ ok: false, reason: "unavailable" });
    expect(
      e.calls
        .filter((call) => call.method === "DELETE")
        .map((call) => call.url.searchParams.get("versionId")),
    ).toEqual(["latest-marker"]);
    expect(e.calls.at(-1)?.method).toBe("HEAD");
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let transportSignal: AbortSignal | null | undefined;
    const aborted = cos(({ url, signal }) => {
      if (url.searchParams.has("versioning")) return enabled();
      transportSignal = signal;
      started();
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("fake request aborted")), {
          once: true,
        });
      });
    });
    const controller = new AbortController(),
      pending = aborted.driver.restoreVersions({ ...ref, signal: controller.signal });
    await entered;
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, reason: "unavailable" });
    expect(transportSignal?.aborted).toBe(true);
    expect(aborted.calls.some((call) => call.method === "DELETE")).toBe(false);
    const count = aborted.calls.length;
    expect(await aborted.driver.eraseVersions({ ...ref, signal: controller.signal })).toMatchObject(
      { ok: false },
    );
    expect(aborted.calls).toHaveLength(count);
  });

  it("MinIO缺IsTruncated不能完成；显式结束后只删精确key版本/marker，透传取消且不做隐式建桶", async () => {
    const driver = createMinioStorage({
      endpoint: "http://storage.example.invalid",
      region: "us-east-1",
      accessKey: "fixture",
      secretKey: "fixture",
      buckets: {
        secure: "fixture-secure",
        asset: "fixture-asset",
        media: "fixture-media",
        pub: "fixture-pub",
      },
    });
    closed.push(driver);
    const signal = new AbortController().signal;
    aws.send.mockImplementation(async (command) => {
      if (command instanceof ListObjectVersionsCommand)
        return { Versions: [{ Key: ref.key, VersionId: "must-stay" }] };
      throw new Error("缺分页标志不得继续调用存储");
    });
    expect(await driver.eraseVersions({ ...ref, signal })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(aws.send).toHaveBeenCalledTimes(1);
    expect(aws.send.mock.calls[0]![0]).toBeInstanceOf(ListObjectVersionsCommand);
    expect(aws.send.mock.calls[0]![1]?.abortSignal).toBe(signal);
    aws.send.mockReset();
    aws.send.mockImplementation(async (command) => {
      if (command instanceof ListObjectVersionsCommand)
        return {
          IsTruncated: false,
          Versions: [
            { Key: ref.key, VersionId: "own-version" },
            { Key: ref.key + ".neighbor", VersionId: "neighbor-version" },
          ],
          DeleteMarkers: [
            { Key: ref.key, VersionId: "own-marker" },
            { Key: ref.key + ".neighbor", VersionId: "neighbor-marker" },
          ],
        };
      if (command instanceof DeleteObjectCommand) return {};
      if (command instanceof HeadObjectCommand) throw { $metadata: { httpStatusCode: 404 } };
      throw new Error("不应调用建桶或其他存储操作");
    });
    expect(await driver.eraseVersions({ ...ref, signal })).toEqual({ ok: true, value: undefined });
    const deletes = aws.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof DeleteObjectCommand);
    expect(deletes.map((command) => command.input)).toEqual([
      { Bucket: "fixture-asset", Key: ref.key, VersionId: "own-version" },
      { Bucket: "fixture-asset", Key: ref.key, VersionId: "own-marker" },
    ]);
    expect(aws.send.mock.calls.every(([, options]) => options?.abortSignal === signal)).toBe(true);
    const count = aws.send.mock.calls.length,
      controller = new AbortController();
    controller.abort();
    expect(await driver.eraseVersions({ ...ref, signal: controller.signal })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(aws.send).toHaveBeenCalledTimes(count);
  });
});
