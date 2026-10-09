import { afterEach, describe, expect, it, vi } from "vitest";
import { createCiMedia } from "./ci.js";
import type { CiConfig } from "./ci.js";
const data = "019acdef-0000-7000-8000-000000000000:1";
const src = { bucket: "asset" as const, key: "assets/fictional.mp4" };
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
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closes.splice(0).map((close) => close()));
});
function driver(send: typeof fetch) {
  const d = createCiMedia(config, { now: () => new Date("2026-10-09T00:00:00Z"), fetchImpl: send });
  closes.push(d.close);
  return d.provider;
}
function reply(state = "Success", result = "2", overrides = "") {
  return `<Response><JobsDetail><JobId>audit-id</JobId><DataId>${data}</DataId><State>${state}</State><Object>${src.key}</Object>${result === "" ? "" : `<Result>${result}</Result>`}<Label>Porn</Label><Content>private phone 13800138000</Content><UserInfo><Token>secret</Token></UserInfo>${overrides}</JobsDetail></Response>`;
}
describe("CI moderation native routes", () => {
  it.each(["Porn", "Quality"])("image conclusion keeps only the known %s label", async (label) => {
    const p = driver(
      async () =>
        new Response(
          `<RecognitionResult><Result>1</Result><Label>${label}</Label><Text>13800138000</Text><SubLabel>private-raw-content</SubLabel></RecognitionResult>`,
        ),
    );
    const result = await p.audit({ src, scenes: ["profile"], userData: data });
    expect(result).toEqual({
      ok: true,
      value: { verdict: "block", processed: true, labels: [label] },
    });
    expect(JSON.stringify(result)).not.toContain("13800138000");
    expect(JSON.stringify(result)).not.toContain("private-raw-content");
  });
  it("video submission uses fixed object/DataId and never claims synchronous pass", async () => {
    const send = vi.fn(async (url, init) => {
      expect(String(url)).toBe(
        "https://test-asset-1250000000.ci.ap-beijing.myqcloud.com/video/auditing",
      );
      expect(init?.redirect).toBe("error");
      expect(init?.body).toContain(`<Object>${src.key}</Object><DataId>${data}</DataId>`);
      expect(init?.body).toContain(
        "<Snapshot><Mode>Interval</Mode><TimeInterval>5</TimeInterval><Count>10000</Count></Snapshot><DetectContent>1</DetectContent>",
      );
      expect(init?.body).not.toContain("<Url>");
      return new Response(reply("Submitted", ""));
    });
    expect(await driver(send).auditVideo({ src, userData: data })).toEqual({
      ok: true,
      value: { jobId: "audit-id", dataId: data, state: "submitted", processed: true },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("query matches job/DataId/object and returns only bounded conclusion", async () => {
    const p = driver(async (url) => {
      expect(String(url)).toContain("/video/auditing/audit-id");
      return new Response(reply());
    });
    expect(await p.describeAudit({ src, jobId: "audit-id", userData: data })).toEqual({
      ok: true,
      value: {
        jobId: "audit-id",
        dataId: data,
        state: "succeeded",
        processed: true,
        verdict: "review",
        labels: ["Porn"],
      },
    });
    for (const body of [
      reply().replace(data, `${data}0`),
      reply().replace(src.key, "foreign.mp4"),
      reply().replace("audit-id", "foreign-id"),
      reply("Success", "9"),
      reply("Success", "", "<Result>0</Result><Result>1</Result>"),
    ]) {
      const bad = driver(async () => new Response(body));
      expect(await bad.describeAudit({ src, jobId: "audit-id", userData: data })).toMatchObject({
        ok: false,
      });
    }
  });
  it("text is sent as bounded real UTF8 base64 and no raw content comes back", async () => {
    const text = "虚构测试正文&敏感词";
    const p = driver(async (url, init) => {
      expect(String(url)).toContain("/text/auditing");
      expect(init?.body).toContain(`<Content>${Buffer.from(text).toString("base64")}</Content>`);
      return new Response(reply("Success", "1"));
    });
    const result = await p.auditText({ bucket: "asset", text, userData: data });
    expect(result).toEqual({
      ok: true,
      value: { verdict: "block", processed: true, labels: ["Porn"] },
    });
    expect(JSON.stringify(result)).not.toContain("13800138000");
  });
  it("invalid text/routes and unrecognized states fail before accepting a conclusion", async () => {
    const send = vi.fn(async () => new Response(reply("Unknown", "0"))),
      p = driver(send);
    for (const text of ["", "字".repeat(10001), "\u0000", "\ud800"])
      expect(await p.auditText({ bucket: "asset", text, userData: data })).toMatchObject({
        ok: false,
      });
    expect(send).not.toHaveBeenCalled();
    expect(
      await p.auditVideo({ src: { ...src, key: "../escape.mp4" }, userData: data }),
    ).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
    expect(await p.describeAudit({ src, jobId: "audit-id", userData: data })).toMatchObject({
      ok: false,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
