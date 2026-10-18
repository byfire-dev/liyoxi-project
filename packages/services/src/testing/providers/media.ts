// 假媒体处理：体检给预置的报告；转码、打包直接完成；视频审核直接放行
//（计划 第 7.3 节表后的留桩清单：体检替身；样片水印版由替身直接置 ready）。

import { ok, failed } from "../../providers/types.js";
import type {
  MediaJob,
  MediaProbeReport,
  MediaProvider,
  MediaRemoteJob,
  ObjectRef,
  ProviderMethodName,
} from "../../providers/types.js";
import { createFakeCore, systemClock } from "./base.js";
import type { FakeClock, FakeControl } from "./base.js";

type Method = ProviderMethodName<MediaProvider>;

export interface FakeMediaJob extends MediaJob {
  kind: "transcode" | "pack";
  userData: string;
  canceled?: boolean;
}

export interface FakeMedia extends MediaProvider, FakeControl<Method> {
  /** 体检报告的预置，键是 “桶/对象键”。没预置的给 defaultReport */
  readonly reports: Map<string, MediaProbeReport>;
  /** 没预置时给的报告：竖屏 9:16、H.264、带音轨。可以整个换掉 */
  defaultReport: MediaProbeReport;
  /** 提交过的转码与打包任务，都是直接完成 */
  readonly jobs: FakeMediaJob[];
}

const slot = (ref: ObjectRef) => `${ref.bucket}/${ref.key}`;

export function createFakeMedia(options: { clock?: FakeClock } = {}): FakeMedia {
  const core = createFakeCore<Method>(options.clock ?? systemClock);
  const reports = new Map<string, MediaProbeReport>();
  const jobs: FakeMediaJob[] = [];
  const audits = new Map<string, { dataId: string; src: ObjectRef }>();

  function submit(kind: FakeMediaJob["kind"], userData: string): MediaJob {
    const job: FakeMediaJob = {
      jobId: `fake-${kind}-${jobs.length + 1}`,
      state: "done",
      processed: true,
      kind,
      userData,
    };
    jobs.push(job);
    return { jobId: job.jobId, state: job.state, processed: job.processed };
  }

  const remote = (one: FakeMediaJob): MediaRemoteJob => ({
    jobId: one.jobId,
    state: one.canceled ? "canceled" : one.state === "done" ? "succeeded" : "submitted",
    userData: one.userData,
    processed: true,
    output: {},
  });
  const fake: FakeMedia = {
    status: "fake",
    configured: true,
    ...core.control,
    reports,
    defaultReport: {
      durationMs: 60_000,
      width: 1080,
      height: 1920,
      videoCodec: "h264",
      hasAudio: true,
      sizeBytes: 8_000_000,
    },
    jobs,

    probe: (input) =>
      core.run(
        "probe",
        input,
        () =>
          ok({
            processed: true,
            report: { ...(reports.get(slot(input.src)) ?? fake.defaultReport) },
          }),
        input.signal,
      ),
    transcode: (input) =>
      core.run("transcode", input, () => ok(submit("transcode", input.userData)), input.signal),
    pack: (input) =>
      core.run("pack", input, () => ok(submit("pack", input.userData)), input.signal),
    audit: (input) =>
      core.run("audit", input, () => ok({ verdict: "pass", processed: true }), input.signal),
    auditText: (input) =>
      core.run(
        "auditText",
        input,
        () => ok({ verdict: "pass", processed: true, labels: [] }),
        input.signal,
      ),
    auditVideo: (input) =>
      core.run(
        "auditVideo",
        input,
        () => {
          const jobId = `fake-audit-${audits.size + 1}`;
          audits.set(jobId, { dataId: input.userData, src: { ...input.src } });
          return ok({ jobId, dataId: input.userData, state: "submitted", processed: true });
        },
        input.signal,
      ),
    describeAudit: (input) =>
      core.run(
        "describeAudit",
        input,
        () => {
          const one = audits.get(input.jobId);
          return one && one.dataId === input.userData && slot(one.src) === slot(input.src)
            ? ok({
                jobId: input.jobId,
                dataId: one.dataId,
                state: "succeeded",
                processed: true,
                verdict: "pass",
                labels: [],
              })
            : failed("rejected", "没有该替身审核任务");
        },
        input.signal,
      ),
    describe: (input) =>
      core.run(
        "describe",
        input,
        () => {
          const one = jobs.find((job) => job.jobId === input.jobId);
          return one ? ok(remote(one)) : failed("rejected", "没有该替身任务");
        },
        input.signal,
      ),
    find: (input) =>
      core.run(
        "find",
        input,
        () => {
          const one = jobs.find((job) => job.userData === input.userData);
          return ok({ job: one ? remote(one) : null, complete: true });
        },
        input.signal,
      ),
    cancel: (input) =>
      core.run(
        "cancel",
        input,
        () => {
          const one = jobs.find((job) => job.jobId === input.jobId);
          if (one) one.canceled = true;
          return ok(undefined);
        },
        input.signal,
      ),
  };
  return fake;
}
