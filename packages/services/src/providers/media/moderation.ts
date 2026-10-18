import { failed, ok } from "../types.js";
import type { MediaProvider, MediaAuditJob, ContentVerdict, ObjectRef } from "../types.js";
import type { createCiHttp } from "./http.js";
import { ciChild, ciText, parseCiXml } from "./xml.js";
import type { CiXml } from "./xml.js";
import { xmlEscape } from "../storage/cos-signature.js";
const bad = () => failed("rejected", "CI审核入参或应答不合法");
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const data = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9]\d{0,8}$/.test(value);
const bucket = (value: string) => ["secure", "asset", "media", "pub"].includes(value);
const loneSurrogate = /[\uD800-\uDFFF]/u;
function hasRejectedControl(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127)
      return true;
  }
  return false;
}
const object = (ref: ObjectRef) =>
  ref &&
  bucket(ref.bucket) &&
  typeof ref.key === "string" &&
  ref.key.length > 0 &&
  Buffer.byteLength(ref.key) <= 1024 &&
  !/\p{Cc}/u.test(ref.key) &&
  !ref.key.startsWith("/") &&
  ref.key.split("/").every((part) => part && part !== "." && part !== "..");
const labels = new Set([
  "Normal",
  "Porn",
  "Ads",
  "Quality",
  "Politics",
  "Terrorism",
  "Abuse",
  "Illegal",
  "Teenager",
  "Meaningless",
  "Sexy",
  "Other",
]);
export function projectCiLabels(value: string | undefined): string[] {
  return value && labels.has(value) ? [value] : [];
}
function detail(body: string): CiXml {
  const root = parseCiXml(body),
    one = ciChild(root, "JobsDetail");
  if (root.name !== "Response" || !one) throw new TypeError("CI审核应答非法");
  return one;
}
function conclusion(one: CiXml): { verdict: Exclude<ContentVerdict, "pending">; labels: string[] } {
  const result = ciText(one, "Result"),
    label = ciText(one, "Label");
  if (!["0", "1", "2"].includes(result ?? "")) throw new TypeError("CI审核结论非法");
  return {
    verdict: result === "0" ? "pass" : result === "1" ? "block" : "review",
    labels: projectCiLabels(label),
  };
}
function parsed(
  one: CiXml,
  expected: { userData: string; src: ObjectRef; jobId?: string },
): MediaAuditJob {
  const jobId = ciText(one, "JobId"),
    state = ciText(one, "State");
  if (
    !jobId ||
    !id(jobId) ||
    (expected.jobId && jobId !== expected.jobId) ||
    ciText(one, "DataId") !== expected.userData ||
    ciText(one, "Object") !== expected.src.key
  )
    throw new TypeError("CI审核归属不匹配");
  const mapped =
    state === "Submitted"
      ? "submitted"
      : ["Snapshoting", "Auditing"].includes(state ?? "")
        ? "running"
        : state === "Success"
          ? "succeeded"
          : state === "Failed"
            ? "failed"
            : null;
  if (!mapped) throw new TypeError("CI审核状态非法");
  return {
    jobId,
    dataId: expected.userData,
    state: mapped,
    processed: true,
    ...(mapped === "succeeded" ? conclusion(one) : {}),
  };
}
/** Borrowed HTTP owns timeout/abort/close; this projection never retains raw provider content. */
export function createCiModeration(
  http: ReturnType<typeof createCiHttp>,
): Pick<MediaProvider, "auditText" | "auditVideo" | "describeAudit"> {
  return {
    async auditText(input) {
      if (
        !bucket(input.bucket) ||
        !data(input.userData) ||
        typeof input.text !== "string" ||
        !input.text ||
        [...input.text].length > 10000 ||
        Buffer.byteLength(input.text) > 40000 ||
        hasRejectedControl(input.text) ||
        loneSurrogate.test(input.text)
      )
        return bad();
      const response = await http.request({
        bucket: input.bucket,
        method: "POST",
        path: "/text/auditing",
        body: `<Request><Input><Content>${Buffer.from(input.text).toString("base64")}</Content><DataId>${xmlEscape(input.userData)}</DataId></Input></Request>`,
        signal: input.signal,
      });
      if (!response.ok) return response;
      try {
        const one = detail(response.value);
        if (ciText(one, "DataId") !== input.userData || ciText(one, "State") !== "Success")
          return bad();
        return ok({ processed: true, ...conclusion(one) });
      } catch {
        return bad();
      }
    },
    async auditVideo(input) {
      if (!object(input.src) || !data(input.userData)) return bad();
      const response = await http.request({
        bucket: input.src.bucket,
        method: "POST",
        path: "/video/auditing",
        body: `<Request><Input><Object>${xmlEscape(input.src.key)}</Object><DataId>${xmlEscape(input.userData)}</DataId></Input><Conf><Snapshot><Mode>Interval</Mode><TimeInterval>5</TimeInterval><Count>10000</Count></Snapshot><DetectContent>1</DetectContent></Conf></Request>`,
        signal: input.signal,
      });
      if (!response.ok) return response;
      try {
        const result = parsed(detail(response.value), input);
        // Even an immediate Success is confirmed by the subsequent exact query.
        return ok({
          jobId: result.jobId,
          dataId: result.dataId,
          state: "submitted",
          processed: true,
        });
      } catch {
        return failed("unavailable", "CI审核提交结果无法确认");
      }
    },
    async describeAudit(input) {
      if (!object(input.src) || !id(input.jobId) || !data(input.userData)) return bad();
      const response = await http.request({
        bucket: input.src.bucket,
        method: "GET",
        path: `/video/auditing/${input.jobId}`,
        signal: input.signal,
      });
      if (!response.ok) return response;
      try {
        return ok(parsed(detail(response.value), input));
      } catch {
        return bad();
      }
    },
  };
}
