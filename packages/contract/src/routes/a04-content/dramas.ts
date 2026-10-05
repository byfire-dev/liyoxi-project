// 后台：短剧库与积分价 · dramas（docs/api/a04-content.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminDramaList = adminMeta({
  method: "get",
  path: "/admin/dramas",
  operationId: "admin.drama.list",
  summary:
    "短剧列表：剧名、状态、题材、热度、类别、适配行业、“仅看 N 天内授权到期”；每页 12；积分价列含模板价",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminDramaCreate = adminMeta({
  method: "post",
  path: "/admin/dramas",
  operationId: "admin.drama.create",
  summary: "新建短剧草稿（同事务建空的版权行）",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminDramaSummary = adminMeta({
  method: "get",
  path: "/admin/dramas/summary",
  operationId: "admin.drama.summary",
  summary: "页首计数：已上架、草稿、已下架、授权期 90 天内结束且已停止订购",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminDramaGet = adminMeta({
  method: "get",
  path: "/admin/dramas/{dramaId}",
  operationId: "admin.drama.get",
  summary: "短剧详情（5 个页签数据、右栏积分价与上架校验摘要）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminDramaActivityList = adminMeta({
  method: "get",
  path: "/admin/dramas/{dramaId}/activities",
  operationId: "admin.drama.activity.list",
  summary: "剧目操作日志（右栏）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminDramaBasicUpdate = adminMeta({
  method: "patch",
  path: "/admin/dramas/{dramaId}/basic",
  operationId: "admin.drama.basic.update",
  summary:
    "保存“基础信息”页签（剧名、封面、集数、单集时长、题材、标签、出品方、主演、简介、微短剧类别、是否 AI 制作），带 lockVersion；已上架时重跑校验、商城同步更新",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminDramaCommercialUpdate = adminMeta({
  method: "patch",
  path: "/admin/dramas/{dramaId}/commercial",
  operationId: "admin.drama.commercial.update",
  summary:
    "保存“商业信息”页签（热度等级、人工加权、适配行业、目标观众、允许的植入形式、试看集数 V1.1），带 lockVersion",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminDramaConfirmPermitRecheck = adminMeta({
  method: "post",
  path: "/admin/dramas/{dramaId}/confirm-permit-recheck",
  operationId: "admin.drama.confirmPermitRecheck",
  summary: "替换原片后确认许可信息仍适用（清除待重新核验标记）",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminDramaCopyrightReplace = adminMeta({
  method: "put",
  path: "/admin/dramas/{dramaId}/copyright",
  operationId: "admin.drama.copyright.replace",
  summary: "草稿期保存版权信息（来源、平台与地域、四项权利、有效期、权属证明）",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminDramaDelist = adminMeta({
  method: "post",
  path: "/admin/dramas/{dramaId}/delist",
  operationId: "admin.drama.delist",
  summary: "下架（必选原因，说明 ≤200 字；上线中成片使用期不受影响）",
  "x-permission": "drama.shelf",
  "x-idempotent": "required",
});

export const adminDramaDramaCopyrightRevisionCreate = adminMeta({
  method: "post",
  path: "/admin/dramas/{dramaId}/drama-copyright-revisions",
  operationId: "admin.drama.dramaCopyrightRevision.create",
  summary: "上架后的版权变更（续期、缩短、范围变更、更正），须二次确认与依据文件",
  "x-permission": "drama.copyright.revise",
  "x-idempotent": "required",
});

export const adminDramaDramaEpisodeList = adminMeta({
  method: "get",
  path: "/admin/dramas/{dramaId}/drama-episodes",
  operationId: "admin.drama.dramaEpisode.list",
  summary: "剧集列表：标题、时长、当前原片文件与大小、原片状态（缺失、处理中、已就绪），分页",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminDramaDramaPermitList = adminMeta({
  method: "get",
  path: "/admin/dramas/{dramaId}/drama-permits",
  operationId: "admin.drama.dramaPermit.list",
  summary: "许可信息行（按平台；许可证号、批准文件号、节目编号、扫描件）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminDramaDramaPermitCreate = adminMeta({
  method: "post",
  path: "/admin/dramas/{dramaId}/drama-permits",
  operationId: "admin.drama.dramaPermit.create",
  summary: "新增许可行（含许可文件扫描件 fileId）",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminDramaDramaPriceRevisionCreate = adminMeta({
  method: "post",
  path: "/admin/dramas/{dramaId}/drama-price-revisions",
  operationId: "admin.drama.dramaPriceRevision.create",
  summary:
    "单剧调价：新积分价、生效时间（立即或指定日 00:00）、原因 + 备注；选剧单读取时显示“积分价已变动”（V1.0 不推送）",
  "x-permission": "billing.price.edit",
  "x-idempotent": "required",
});

export const adminDramaListingChecksGet = adminMeta({
  method: "get",
  path: "/admin/dramas/{dramaId}/listing-checks",
  operationId: "admin.drama.listingChecks.get",
  summary: "上架校验结果（N / M 项通过，逐项阻断或提示，带“去补充”定位）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminDramaMediaReadinessGet = adminMeta({
  method: "get",
  path: "/admin/dramas/{dramaId}/media-readiness",
  operationId: "admin.drama.mediaReadiness.get",
  summary: "预告片、海报、原片就绪情况（供上架校验与剧集页签）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminDramaCastReplace = adminMeta({
  method: "put",
  path: "/admin/dramas/{dramaId}/cast",
  operationId: "admin.drama.cast.replace",
  summary: "保存角色介绍（最多 8 个，整表替换，顺序即商家端展示顺序）",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminDramaShelve = adminMeta({
  method: "post",
  path: "/admin/dramas/{dramaId}/shelve",
  operationId: "admin.drama.shelve",
  summary:
    "上架或重新上架（服务端重跑校验；按当前状态选迁移 drama.list 或 drama.relist；首次上架写版权 initial 修订、登记授权到期定时器）",
  "x-permission": "drama.shelf",
  "x-idempotent": "required",
});

export const adminDramaTrailerReplace = adminMeta({
  method: "put",
  path: "/admin/dramas/{dramaId}/trailer",
  operationId: "admin.drama.trailer.replace",
  summary: "设置预告片（fileId；服务端探测时长与画幅，触发两档转码）",
  "x-permission": "drama.media.manage",
  "x-idempotent": "required",
});
