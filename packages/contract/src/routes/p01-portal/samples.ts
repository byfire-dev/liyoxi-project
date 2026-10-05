// 电脑端下载页 · samples（docs/api/p01-portal.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { portalMeta } from "../meta-only.js";

export const portalSamplePlaybackUrls = portalMeta({
  method: "post",
  path: "/portal/samples/{sampleId}/playback-urls",
  operationId: "portal.sample.playbackUrls",
  summary:
    "签发样片水印版播放地址（60 分钟）并留痕：每次写 audit_log 访问流（target_type = sample），首次访问同事务回写 sample.first_viewed_at",
  "x-auth": "portal",
  "x-capability": "sample.view",
  "x-idempotent": "none",
  "x-idempotent-reason":
    "签发短时地址（A18；C47、C60）：每次签发都是一次真实访问、都要留痕；结果不进幂等记录，避免回放已过期的地址",
});
