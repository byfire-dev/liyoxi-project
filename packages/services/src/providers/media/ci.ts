import { createHmac } from "node:crypto";
import { divRoundHalfUp } from "@liyoxi/shared/pricing";
import { failed, ok } from "../types.js";
import type { MediaProvider, MediaRemoteJob, ObjectRef, StorageBucket } from "../types.js";
import { cosEncode, cosAuthorization, xmlEscape } from "../storage/cos-signature.js";
import { createCiHttp } from "./http.js";
import type { CiConfig } from "./http.js";
import { parseCiXml, ciChild, ciText } from "./xml.js";
import type { CiXml } from "./xml.js";
export type { CiConfig } from "./http.js";
const bad = () => failed("rejected", "CI入参或应答形状不合法");
const key = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 1024 &&
  !/\p{Cc}/u.test(value) &&
  !value.startsWith("/") &&
  !value.split("/").some((part) => part === ".." || part === "." || !part);
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const data = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9]\d{0,8}$/.test(value);
const object = (ref: ObjectRef) =>
  ref && ["secure", "asset", "media", "pub"].includes(ref.bucket) && key(ref.key);
const path = (value: string) => `/${value.split("/").map(cosEncode).join("/")}`;
const states: Record<string, MediaRemoteJob["state"]> = {
  Submitted: "submitted",
  Running: "running",
  Pause: "submitted",
  Success: "succeeded",
  Failed: "failed",
  Cancel: "canceled",
};
function parsedJob(node: CiXml): MediaRemoteJob {
  const jobId = ciText(node, "JobId"),
    state = ciText(node, "State");
  const operation = ciChild(node, "Operation");
  const rawUserData = operation ? ciText(operation, "UserData") : undefined;
  const userData = data(rawUserData) ? rawUserData : undefined;
  if (!id(jobId) || !state || !Object.hasOwn(states, state)) throw new TypeError("CI任务结果非法");
  const output: { width?: number; height?: number; durationMs?: number; sizeBytes?: string } = {};
  const info = operation ? ciChild(operation, "MediaInfo") : undefined;
  const format = info ? ciChild(info, "Format") : undefined;
  const stream = info ? ciChild(info, "Stream") : undefined;
  const video = stream?.children.find((one) => one.name === "Video");
  for (const name of ["Width", "Height"] as const) {
    const raw = video ? ciText(video, name) : undefined;
    if (raw !== undefined) {
      const number = Number(raw);
      if (!/^\d{1,8}$/.test(raw) || !Number.isSafeInteger(number) || number <= 0)
        throw new TypeError("CI技术结果非法");
      output[name === "Width" ? "width" : "height"] = number;
    }
  }
  const duration = format ? ciText(format, "Duration") : undefined;
  if (duration !== undefined) {
    if (!/^\d{1,9}(?:\.\d{1,6})?$/.test(duration)) throw new TypeError("CI技术结果非法");
    const [whole, fraction = ""] = duration.split(".");
    const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
    output.durationMs = divRoundHalfUp([micros], [1000]);
  }
  const size = format ? ciText(format, "Size") : undefined;
  if (size !== undefined) {
    if (!/^\d{1,20}$/.test(size)) throw new TypeError("CI技术结果非法");
    output.sizeBytes = BigInt(size).toString();
  }
  return {
    jobId,
    state: states[state]!,
    processed: true,
    ...(userData ? { userData } : {}),
    output,
  };
}
function jobs(body: string) {
  const root = parseCiXml(body);
  if (root.name !== "Response") throw new TypeError("CI应答非法");
  return { root, jobs: root.children.filter((one) => one.name === "JobsDetail").map(parsedJob) };
}

export function createCiMedia(
  config: CiConfig,
  options: { now: () => Date; fetchImpl?: typeof fetch },
) {
  const origin = new URL(config.callback.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    !/^[a-z]+(?:-[a-z0-9]+){1,4}$/.test(config.region) ||
    ["secure", "asset", "media", "pub"].some(
      (bucket) =>
        !/^[a-z0-9][a-z0-9-]{1,50}-[0-9]{5,20}$/.test(
          config.buckets[bucket as StorageBucket] ?? "",
        ),
    ) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(config.worker.secretId) ||
    !/^[\x21-\x7e]{1,256}$/.test(config.worker.secretKey) ||
    Buffer.byteLength(config.callback.key) < 32 ||
    Buffer.byteLength(config.callback.key) > 256
  )
    throw new TypeError("CI配置不合格");
  const http = createCiHttp(config, options);
  const callback = (userData: string) => {
    const jobId = userData.split(":")[0]!;
    const sig = createHmac("sha256", config.callback.key).update(jobId).digest("base64url");
    return `<CallBack>${xmlEscape(`${origin.origin}/api/v1/hooks/ci/media-jobs/${jobId}?sig=${sig}`)}</CallBack><CallBackFormat>JSON</CallBackFormat>`;
  };
  async function submit(
    bucket: StorageBucket,
    body: string,
    userData: string,
    signal?: AbortSignal,
  ) {
    const response = await http.request({
      bucket,
      method: "POST",
      path: "/jobs",
      body: `<Request>${body}${callback(userData)}</Request>`,
      signal,
    });
    if (!response.ok) return response;
    try {
      const result = jobs(response.value).jobs;
      if (result.length !== 1) return failed("unavailable", "CI已响应但提交结果无法确认");
      return ok({
        jobId: result[0]!.jobId,
        state: result[0]!.state === "succeeded" ? ("done" as const) : ("submitted" as const),
        processed: true,
      });
    } catch {
      return failed("unavailable", "CI已响应但提交结果无法确认");
    }
  }
  const provider: MediaProvider = {
    status: "ci",
    configured: true,
    async probe() {
      return failed("unsupported", "体检处理器由对应媒体包接入，不以未处理结果冒充体检");
    },
    async transcode(input) {
      if (
        !object(input.src) ||
        !object(input.dst) ||
        input.src.bucket !== "media" ||
        input.dst.bucket !== "media" ||
        !id(input.template) ||
        !data(input.userData)
      )
        return bad();
      const watermarks = input.watermarks ?? [];
      if (!Array.isArray(watermarks) || watermarks.length > 3) return bad();
      if (watermarks.some((mark) => !mark || typeof mark !== "object" || Array.isArray(mark)))
        return bad();
      // Template parameters take priority over inline nodes in CI: never claim ignored inline marks were applied.
      if (
        watermarks.some((mark) => "templateId" in mark) &&
        watermarks.some((mark) => !("templateId" in mark))
      )
        return bad();
      const watermarkXml: string[] = [];
      for (const mark of watermarks) {
        if (
          mark &&
          Object.hasOwn(mark, "templateId") &&
          "templateId" in mark &&
          id(mark.templateId) &&
          Object.keys(mark).length === 1
        )
          watermarkXml.push(
            `<WatermarkTemplateId>${xmlEscape(mark.templateId)}</WatermarkTemplateId>`,
          );
        else if (
          mark &&
          "image" in mark &&
          Object.keys(mark).length === 3 &&
          object(mark.image) &&
          Object.keys(mark.image).length === 2 &&
          mark.image.bucket === input.src.bucket &&
          /^ci-out\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/watermark-[a-f0-9]{64}\.png$/.test(
            mark.image.key,
          ) &&
          mark.position === "Center" &&
          Number.isInteger(mark.transparency) &&
          mark.transparency >= 1 &&
          mark.transparency <= 100
        ) {
          const host = `${config.buckets[input.src.bucket]}.cos.${config.region}.myqcloud.com`,
            pathname = path(mark.image.key);
          const start = Math.floor(options.now().getTime() / 1000),
            auth = cosAuthorization({
              key: config.worker,
              method: "GET",
              pathname,
              headers: { host },
              start,
              end: start + 900,
            });
          // Only this fixed COS origin gets an ephemeral signature. The URL is never a persisted job field.
          const url = `https://${host}${pathname}?${new URLSearchParams(auth).toString()}`;
          watermarkXml.push(
            `<Watermark><Type>Image</Type><Pos>Center</Pos><LocMode>Absolute</LocMode><Image><Url>${xmlEscape(url)}</Url><Mode>Original</Mode><Transparency>${mark.transparency}</Transparency></Image></Watermark>`,
          );
        } else if (
          mark &&
          "text" in mark &&
          typeof mark.text === "string" &&
          mark.text.length <= 64 &&
          ["Center", "TopRight"].includes(mark.position) &&
          Number.isInteger(mark.fontSize) &&
          mark.fontSize >= 5 &&
          mark.fontSize <= 100 &&
          Number.isInteger(mark.transparency) &&
          mark.transparency >= 1 &&
          mark.transparency <= 100 &&
          Object.keys(mark).length === 4
        ) {
          // Official Text.Text grammar, not the template Name grammar. Formal sample punctuation remains unchanged upstream.
          if (!/^[\p{Script=Han}A-Za-z0-9_*-]+$/u.test(mark.text))
            return failed(
              "unsupported",
              "正式水印文字不在当前CI原生Text字符范围，需授权图片模板能力",
            );
          watermarkXml.push(
            `<Watermark><Type>Text</Type><Pos>${mark.position}</Pos><LocMode>Absolute</LocMode><Text><FontType>simhei.ttf</FontType><FontSize>${mark.fontSize}</FontSize><FontColor>0xFFFFFF</FontColor><Text>${xmlEscape(mark.text)}</Text><Transparency>${mark.transparency}</Transparency></Text></Watermark>`,
          );
        } else return bad();
      }
      return submit(
        input.src.bucket,
        `<Tag>Transcode</Tag><Input><Object>${xmlEscape(input.src.key)}</Object></Input><Operation><TemplateId>${xmlEscape(input.template)}</TemplateId>${watermarkXml.join("")}<Output><Region>${xmlEscape(config.region)}</Region><Bucket>${xmlEscape(config.buckets[input.dst.bucket])}</Bucket><Object>${xmlEscape(input.dst.key)}</Object></Output><UserData>${input.userData}</UserData></Operation>`,
        input.userData,
        input.signal,
      );
    },
    async pack(input) {
      if (
        input.bucket !== "media" ||
        !data(input.userData) ||
        !key(input.dstKey) ||
        input.items.length < 1 ||
        input.items.length > 1000 ||
        !input.items.every((one) => key(one.key) && key(one.name)) ||
        new Set(input.items.map((one) => one.name)).size !== input.items.length
      )
        return bad();
      const items = input.items
        .map(
          (one) =>
            `<KeyConfig><Key>${xmlEscape(one.key)}</Key><Rename>${xmlEscape(one.name)}</Rename></KeyConfig>`,
        )
        .join("");
      return submit(
        input.bucket,
        `<Tag>FileCompress</Tag><Operation><FileCompressConfig><Format>zip</Format><Flatten>0</Flatten><IgnoreError>false</IgnoreError>${items}</FileCompressConfig><Output><Region>${xmlEscape(config.region)}</Region><Bucket>${xmlEscape(config.buckets[input.bucket])}</Bucket><Object>${xmlEscape(input.dstKey)}</Object></Output><UserData>${input.userData}</UserData></Operation>`,
        input.userData,
        input.signal,
      );
    },
    async audit(input) {
      if (
        !object(input.src) ||
        !data(input.userData) ||
        input.scenes.length !== 1 ||
        input.scenes[0] !== "profile"
      )
        return failed("unsupported", "本驱动当前仅接同步图片审核，视频由后续处理器接入");
      const response = await http.request({
        bucket: input.src.bucket,
        cos: true,
        method: "GET",
        path: path(input.src.key),
        query: { "ci-process": "sensitive-content-recognition", async: "0" },
        signal: input.signal,
      });
      if (!response.ok) return response;
      try {
        const root = parseCiXml(response.value),
          result = ciText(root, "Result");
        if (root.name !== "RecognitionResult" || !["0", "1", "2"].includes(result ?? ""))
          return bad();
        return ok({
          verdict:
            result === "0"
              ? ("pass" as const)
              : result === "1"
                ? ("block" as const)
                : ("review" as const),
          processed: true,
        });
      } catch {
        return bad();
      }
    },
    async describe(input) {
      if (!id(input.jobId) || !["media", "file"].includes(input.family)) return bad();
      const response = await http.request({
        bucket: "media",
        method: "GET",
        path: `/${input.family === "file" ? "file_jobs" : "jobs"}/${input.jobId}`,
        signal: input.signal,
      });
      if (!response.ok) return response;
      try {
        const result = jobs(response.value).jobs;
        return result.length === 1 && result[0]!.jobId === input.jobId ? ok(result[0]!) : bad();
      } catch {
        return bad();
      }
    },
    async find(input) {
      if (
        !data(input.userData) ||
        !["Transcode", "FileCompress"].includes(input.tag) ||
        input.family !== (input.tag === "FileCompress" ? "file" : "media") ||
        !Number.isFinite(input.createdAfter.getTime()) ||
        !Number.isFinite(input.createdBefore.getTime()) ||
        input.createdAfter > input.createdBefore ||
        input.createdBefore.getTime() - input.createdAfter.getTime() > 2 * 60 * 60_000 ||
        (input.src && (!object(input.src) || input.src.bucket !== "media"))
      )
        return bad();
      const seen = new Set<string>();
      const found = new Map<string, MediaRemoteJob>();
      let nextToken: string | undefined;
      for (let page = 0; page < 4; page++) {
        const query: Record<string, string> = {
          tag: input.tag,
          queueType: input.family === "file" ? "FileProcess" : "Transcoding",
          states: "All",
          size: "100",
          startCreationTime: input.createdAfter.toISOString(),
          endCreationTime: input.createdBefore.toISOString(),
        };
        if (input.src) query.inputObject = input.src.key;
        if (nextToken) query.nextToken = nextToken;
        const response = await http.request({
          bucket: "media",
          method: "GET",
          path: "/jobs",
          query,
          signal: input.signal,
        });
        if (!response.ok) return response;
        try {
          const result = jobs(response.value);
          if (result.jobs.length > 100) return bad();
          for (const one of result.jobs)
            if (one.userData === input.userData) found.set(one.jobId, one);
          if (found.size > 1) return failed("rejected", "同一提交事实存在多个外部任务，禁止重提");
          nextToken = ciText(result.root, "NextToken");
          if (!nextToken) return ok({ job: [...found.values()][0] ?? null, complete: true });
          if (!/^[A-Za-z0-9_+=/-]{1,1024}$/.test(nextToken) || seen.has(nextToken))
            return ok({ job: [...found.values()][0] ?? null, complete: false });
          seen.add(nextToken);
        } catch {
          return bad();
        }
      }
      return ok({ job: [...found.values()][0] ?? null, complete: false });
    },
    async cancel(input) {
      if (!id(input.jobId) || !["media", "file"].includes(input.family)) return bad();
      if (input.family === "file")
        return failed("unsupported", "文件处理取消路线未获官方确认，不能假借媒体取消");
      const response = await http.request({
        bucket: "media",
        method: "PUT",
        path: `/jobs/${input.jobId}`,
        query: { cancel: "" },
        signal: input.signal,
      });
      return response.ok && response.value.length === 0
        ? ok(undefined)
        : response.ok
          ? bad()
          : response;
    },
  };
  return { provider, close: http.close };
}
