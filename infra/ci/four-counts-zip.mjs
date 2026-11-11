// zip_package 是 media_job 承载的任务种类，不是第二条 BullMQ 通道。
// 只认当前固定生产路径的连接片段；重构时须重新核对，不向 services 全目录放宽队列规则。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const evidence = {
  "apps/worker/src/index.ts": [
    'import { createWorkerRuntime, QUEUE_CONCURRENCY } from "./runtime.js";',
    "services = buildWorkerServices({",
    "runtime = createWorkerRuntime({ services, channel, lease, logger });",
    "runtime.start();",
  ],
  "apps/worker/src/runtime.ts": [
    "export function createWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {",
    "const { services, channel, lease, logger, monotonic } = options;",
    "await handle(data);",
    `media_job: channel.consume<{ jobId: string }>(
      "media_job", QUEUE_CONCURRENCY.media_job,
      queued<{ jobId: string }>("media_job", (ref) => services.promoteFile(ref)),
    ),`,
  ],
  "packages/services/src/ops/worker.ts": [
    'import { createMedia } from "../media/index.js";',
    "export function buildWorkerServices(options: WorkerServicesOptions): WorkerServices {",
    "const media = createMedia({ zipProvider: providers.media,",
    "promoteFile: (ref) => media.promote(ref),",
  ],
  "packages/services/src/media/index.ts": ['export { createMedia } from "./runtime.js";'],
  "packages/services/src/media/runtime.ts": [
    'import { createZipHandler } from "./zip-handler.js";',
    'import { createMediaJobs } from "./jobs/runner.js";',
    "export function createMedia(options: MediaDeps) {",
    "const baseHandlers = [ createZipHandler(deps),",
    `const handlers = baseHandlers.map((original) => {
      const asset = assetHandlers.find((item) => item.kind === original.kind);
      return asset ? combineAssetHandler(original, asset) : original;
    });`,
    `const jobs = createMediaJobs({
      tx: options.tx, clock: options.clock, channel: options.channel,
      ownerId: options.jobOwnerId ?? uuidv7(), handlers,`,
    "promote: jobs.run,",
  ],
  "packages/services/src/media/jobs/runner.ts": [
    "export function createMediaJobs(options: MediaJobsOptions) {",
    "const handlers = new Map(options.handlers.map((one) => [one.kind, one]));",
    // 绑定 claim 中紧邻的预算校验；expire 中另有同名 lookup，不能代替认领连接。
    `const handler = handlers.get(job.kind as MediaJobKind);
      const budget = jobBudget(job.kind);`,
    "return { job: claimed, beforeState: job.state, handler,",
    "ready = await claim(jobId);",
    "if (ready) await execute(ready, controller);",
    "outcome = await claimed.handler.execute(claimed.job, claimed.context, controller.signal);",
    `async function run({ jobId }: { jobId: string }) {
      const execution = await start(jobId);
      await execution?.completion;
    }`,
    "return { run, scan, shutdown, pause, resume, expire, wake, handlers, convergence };",
  ],
  "packages/services/src/media/zip-handler.ts": [
    'import { createRemoteMediaHandler } from "./jobs/remote.js";',
    "export function createZipHandler(deps: BoundMediaDeps): MediaJobHandler {",
    "const provider = deps.zipProvider;",
    `const definition = {
      kind: "zip_package" as const,
      validInput: (value: unknown) => ZipInputSchema.safeParse(value).success,
      validOutput: (value: unknown) => OutputSchema.safeParse(value).success,
      current, finish,`,
    `const base = createRemoteMediaHandler({
      provider, now: () => deps.clock.now(), definition,`,
    "return { ...base,",
  ],
};

/** 有限词法识别；每个证据另须从物理行首开始，不依赖穷举正则起始上下文。 */
function tokens(source) {
  const result = [];
  let offset = 0;
  const quoted = (quote) => {
    const start = offset++;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === "\\") offset += 1;
      else if (char === quote) return source.slice(start + 1, offset - 1);
      else if (char === "\n" || char === "\r") return null;
    }
    return null;
  };
  const template = () => {
    offset += 1;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === "\\") offset += 1;
      else if (char === "`") return true;
      else if (char === "$" && source[offset] === "{") {
        offset += 1;
        if (!scan(true)) return false;
      }
    }
    return false;
  };
  const regexp = () => {
    offset += 1;
    let bracket = false;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === "\\") offset += 1;
      else if (char === "[") bracket = true;
      else if (char === "]") bracket = false;
      else if (char === "/" && !bracket) {
        while (/[a-z]/i.test(source[offset] ?? "")) offset += 1;
        return true;
      } else if (char === "\n" || char === "\r") return false;
    }
    return false;
  };
  function scan(interpolation = false) {
    let depth = 0;
    let previous;
    let beforePrevious;
    while (offset < source.length) {
      const char = source[offset];
      if (/\s/.test(char)) {
        offset += 1;
        continue;
      }
      if (source.startsWith("//", offset)) {
        const end = source.indexOf("\n", offset + 2);
        offset = end < 0 ? source.length : end + 1;
        continue;
      }
      if (source.startsWith("/*", offset)) {
        const end = source.indexOf("*/", offset + 2);
        if (end < 0) return false;
        offset = end + 2;
        continue;
      }
      const start = offset;
      let token;
      if (char === '"' || char === "'") {
        const value = quoted(char);
        if (value === null) return false;
        token = `string:${value}`;
      } else if (char === "`") {
        if (!template()) return false;
        token = "template";
      } else if (
        char === "/" &&
        (previous === undefined ||
          ["=", "(", "[", ",", ":", "!", "?", "return"].includes(previous) ||
          (beforePrevious === "=" && previous === ">"))
      ) {
        if (!regexp()) return false;
        token = "regexp";
      } else {
        const word = source.slice(offset).match(/^[\w$]+/);
        token = word?.[0] ?? char;
        offset += token.length;
        if (token === "{") depth += 1;
        if (token === "}") {
          if (interpolation && depth === 0) return true;
          depth -= 1;
        }
      }
      beforePrevious = previous;
      previous = token;
      if (!interpolation) {
        result.push({
          value: token,
          start,
          lineStart: /^\s*$/.test(source.slice(source.lastIndexOf("\n", start - 1) + 1, start)),
        });
      }
    }
    return !interpolation;
  }
  return scan() ? result : null;
}

function contains(source, fragment) {
  const expected = tokens(fragment);
  // 所有登记片段都从独立语句/属性行开始。合法正则正文不能跨物理行，
  // 即使其起始上下文未被上面的有限分词识别，正文前仍有 /，不能充当行首证据。
  return (
    expected !== null &&
    source.some(
      (token, start) =>
        token.lineStart &&
        expected.every((part, index) => source[start + index]?.value === part.value),
    )
  );
}

/** 非精确条目返回 null，由原规则处理；精确条目缺任何连接直接失败，不回退到名字命中。 */
export function zipPackageHandlerPresent(item, root) {
  if (
    item.category !== "队列" ||
    item.module !== "media" ||
    item.name !== "zip_package" ||
    item.milestone !== "M6"
  )
    return null;
  return Object.entries(evidence).every(([path, fragments]) => {
    let source;
    try {
      source = tokens(readFileSync(join(root, path), "utf8"));
    } catch {
      return false;
    }
    return source !== null && fragments.every((fragment) => contains(source, fragment));
  });
}
