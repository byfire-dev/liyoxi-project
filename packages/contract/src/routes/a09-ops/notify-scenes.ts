// 后台：内容运营与通知配置 · notify-scenes（docs/api/a09-ops.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminNotifySceneList = adminMeta({
  method: "get",
  path: "/admin/notify-scenes",
  operationId: "admin.notifyScene.list",
  summary:
    "消息模板页的订阅消息页签（17 个）与通知设置页的其他场景：触发时机文案、接收人、近 7 天发送与成功率、开关、示例预览；短信页签走 admin.smsTemplate.list",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminNotifySceneSummary = adminMeta({
  method: "get",
  path: "/admin/notify-scenes/summary",
  operationId: "admin.notifyScene.summary",
  summary: "场景页签计数：订阅消息、其他场景（短信页签计数走 admin.smsTemplate.summary）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminNotifySceneUpdate = adminMeta({
  method: "patch",
  path: "/admin/notify-scenes/{sceneKey}",
  operationId: "admin.notifyScene.update",
  summary: "修改场景的外部通道开关与“补发短信”开关（带 lockVersion）",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminNotifySceneDisable = adminMeta({
  method: "post",
  path: "/admin/notify-scenes/{sceneKey}/disable",
  operationId: "admin.notifyScene.disable",
  summary: "关闭场景总开关（须填原因）",
  "x-permission": "sys.super_admin",
  "x-idempotent": "required",
});

export const adminNotifySceneEnable = adminMeta({
  method: "post",
  path: "/admin/notify-scenes/{sceneKey}/enable",
  operationId: "admin.notifyScene.enable",
  summary: "打开场景总开关",
  "x-permission": "sys.super_admin",
  "x-idempotent": "required",
});

export const adminNotifySceneTestSend = adminMeta({
  method: "post",
  path: "/admin/notify-scenes/{sceneKey}/test-send",
  operationId: "admin.notifyScene.testSend",
  summary:
    "测试发送：订阅消息或该场景的补发短信，发到当前员工在参数 notify.test_recipients 里登记的 openid 或手机号（直发，每员工 5 次 / 分钟）",
  "x-permission": null,
  "x-idempotent": "required",
});
