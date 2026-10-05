// 商家端：广告 · ads（docs/api/m06-ad.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mAdList = merchantMeta({
  method: "get",
  path: "/m/ads",
  operationId: "m.ad.list",
  summary:
    "我的广告（?tab=all|producing|pending_confirm|revising|confirmed，缺省 all；type=opening|ending；isSelectable=true；sort=-updatedAt|-submittedAt）：封面、类型与时长、状态与商家端显示状态、等待原因、文案、宣传重点、剩余免费修改次数、使用中剧目数与首部剧名、当前版本与查看方式、预计完成时间、可执行动作",
  "x-capability": "ad.request",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mAdCreate = merchantMeta({
  method: "post",
  path: "/m/ads",
  operationId: "m.ad.create",
  summary:
    "提交广告制作需求并冻结积分：{type, durationSec, promoPointCodes[1-5], copy ≤50, remark ≤200, referenceStoreAssetIds ≤9, referenceFileIds ≤9（档案媒体）, expectChargePoints, agreementVersionId, isAgreementChecked}；响应 AdState",
  "x-capability": "ad.request",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

export const mAdQuote = merchantMeta({
  method: "post",
  path: "/m/ads/quote",
  operationId: "m.ad.quote",
  summary:
    "广告计价（纯计算）：单价、套餐折扣、应冻结积分、免费修改次数、套餐名、可用积分与提交后可用积分、开放类型与可选时长、门店闸门、blockers（{code, message}，code 取错误符号）、协议现行版本与是否需勾选",
  "x-capability": "ad.request",
  "x-clerk-view": "none",
  "x-idempotent": "none",
  "x-idempotent-reason": "试算，不写库、不缓存（A18、A20）",
});

export const mAdGet = merchantMeta({
  method: "get",
  path: "/m/ads/{adId}",
  operationId: "m.ad.get",
  summary:
    "广告详情：版本列表与分段标注（segments）、当前版本 playable（资产就绪时返回，sources 仅当版本查看方式含 weapp 且开关开时有值）、viewEvidence 与 confirmableVia、查看出口 alternatives、状态与说明、剩余免费次数与超次单价、修改截图上限、制作信息与参考素材（含档案分组 mediaGroup）、制作记录（商家可见的 8 类迁移）、关联订单的影响提示、相关工单 relatedServiceTickets",
  "x-capability": "ad.request",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mAdConfirm = merchantMeta({
  method: "post",
  path: "/m/ads/{adId}/confirm",
  operationId: "m.ad.confirm",
  summary:
    "确认使用广告版本 {versionNo, viewedVia, hasViewed}（viewedVia 必填，落 ad_version.confirm_viewed_via）",
  "x-capability": "ad.confirm",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

export const mAdDownloadUrls = merchantMeta({
  method: "post",
  path: "/m/ads/{adId}/download-urls",
  operationId: "m.ad.downloadUrls",
  summary:
    "签发当前版本广告视频文件的短时下载地址（ad_version.file_id，广告不加水印，A97）以保存到相册查看，请求体 {versionNo}，有效期 15 分钟；写访问审计（ad.version.album_download）；该版本的查看方式含 album 时可用；开关推送后被关闭、版本只有 weapp 时按样片同一兜底也可签发",
  "x-capability": "ad.request",
  "x-clerk-view": "none",
  "x-idempotent": "none",
  "x-idempotent-reason": "签发短时地址，结果不进幂等记录，避免回放过期地址（A18、A19）",
});

export const mAdRequestChange = merchantMeta({
  method: "post",
  path: "/m/ads/{adId}/request-change",
  operationId: "m.ad.requestChange",
  summary:
    "提出修改意见：{versionNo, segmentIndex | timeStartMs+timeEndMs | 都不传（整条广告）, note ≤200, screenshotFileIds（≤参数 ad.revision_screenshot_max，默认 1）, acceptChargePoints}；超出免费次数时按 1 条扣积分；响应 {ad: AdState, revision}",
  "x-capability": "ad.confirm",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

export const mAdSubmit = merchantMeta({
  method: "post",
  path: "/m/ads/{adId}/submit",
  operationId: "m.ad.submit",
  summary:
    "被退回补充素材后重新提交（不重复冻结，时限重新计算）：{copy?, remark?, addReferenceStoreAssetIds?, addReferenceFileIds?}，可改文案、备注并追加参考素材（按来源各与已有合计 ≤9），可为空对象；响应 AdState",
  "x-capability": "ad.request",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});
