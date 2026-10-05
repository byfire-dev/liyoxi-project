// 电脑端下载页 · ads（docs/api/p01-portal.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { portalMeta } from "../meta-only.js";

export const portalAdList = portalMeta({
  method: "get",
  path: "/portal/ads",
  operationId: "portal.ad.list",
  summary:
    "本门店待确认的广告列表（当前版本已推送、可在电脑上预览：查看方式含电脑端或属于开关兜底）；游标分页",
  "x-auth": "portal",
  "x-capability": "ad.view",
  "x-idempotent-reason": "GET，纯查询（A18）：不写库、不要求幂等键",
});

export const portalAdGet = portalMeta({
  method: "get",
  path: "/portal/ads/{adId}",
  operationId: "portal.ad.get",
  summary:
    "广告只读预览的元数据：最新已推送版本的版本号、时长、分段标注、海报，并提示回小程序确认或提出修改意见；不含播放地址",
  "x-auth": "portal",
  "x-capability": "ad.view",
  "x-idempotent-reason": "GET，纯查询（A18）：不写库、不要求幂等键",
});

export const portalAdPlaybackUrls = portalMeta({
  method: "post",
  path: "/portal/ads/{adId}/playback-urls",
  operationId: "portal.ad.playbackUrls",
  summary:
    "签发广告当前版本的播放地址（源文件，不加水印，A97；60 分钟）并留痕：每次写 audit_log 访问流，对象为广告版本",
  "x-auth": "portal",
  "x-capability": "ad.view",
  "x-idempotent": "none",
  "x-idempotent-reason":
    "签发短时地址（A18；C47、C60）：每次签发都是一次真实访问、都要留痕；结果不进幂等记录，避免回放已过期的地址",
});
