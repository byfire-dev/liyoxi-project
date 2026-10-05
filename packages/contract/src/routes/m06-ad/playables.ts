// 商家端：广告 · playables（docs/api/m06-ad.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mPlayableGet = merchantMeta({
  method: "get",
  path: "/m/playables/{playableId}",
  operationId: "m.playable.get",
  summary:
    "换取播放地址（地址过期或播放报错时换新）：返回 Playable（kind、sources（广告 source 一档、样片水印版一档、预告片 sd/hd）、海报、时长、宽高、到期时间）；受 weapp.video.* 开关控制",
  "x-auth": "optional",
  "x-capability": "assert-in-handler",
  "x-clerk-view": "same",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
