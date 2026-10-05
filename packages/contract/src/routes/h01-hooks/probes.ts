// 外部回调与探活 · probes（docs/api/h01-hooks.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { registryOnly } from "../builders.js";

export const hooksHealthGet = registryOnly({
  registryKey: "hooks.health.get",
  path: "/health",
  summary:
    "公开聚合健康（外部拨测，A42 保留）：status（ok / degraded）、version、time、db、redis、worker、probeAgeSec、flow；degraded 回 503，只回聚合值",
});

export const hooksHealthzGet = registryOnly({
  registryKey: "hooks.healthz.get",
  path: "/healthz",
  summary: "存活检查：进程活着即 200，不查依赖；只回聚合状态",
});

export const hooksInternalHealthFinanceGet = registryOnly({
  registryKey: "hooks.internalHealth.finance.get",
  path: "/internal/health/finance",
  summary:
    "资金与计费存活指标（未入账超时、worker 心跳、定时器延迟、微信支付收件积压、证书剩余天数，以及计费的推进滞后、每日校验、违规、估值、履约受阻），仅内网，供云监控或独立探针每分钟拉取；degraded 回 503",
});

export const hooksInternalHealthFlowGet = registryOnly({
  registryKey: "hooks.internalHealth.flow.get",
  path: "/internal/health/flow",
  summary:
    "流程明细指标（最老未展开出站事件、最老待处理投递、投递死信数、定时器滞后、失败定时器数、关键类定时器连续失败数、卡住工单数），仅内网，供云监控或独立探针每分钟拉取；超过 P1 进 breaches、degraded 回 503，只超过 P2 进 warnings",
});

export const hooksReadyzGet = registryOnly({
  registryKey: "hooks.readyz.get",
  path: "/readyz",
  summary:
    "就绪检查：只反映进程已完成启动且未在排空，排空或收到 SIGTERM 后立即 503；不查数据库与 Redis；只回聚合状态",
});
