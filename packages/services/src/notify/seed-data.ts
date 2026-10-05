// notify 的种子数据（W0-21）：12 个订阅消息槽位、9 个短信模板、各场景的通道绑定。
// 场景的键、受众、显示名不在这里：取契约的 NOTIFY_SCENES。出处：13 分组 第 2.1–2.3 节；D6 第 2.2、2.9.1、2.10 节。
import type {
  EnumValue,
  MerchantSceneKey,
  NOTIFY_SCENE_SEND_WINDOW,
  NOTIFY_SCENE_SMS_POLICY,
  SMS_TEMPLATE_KIND,
} from "@liyoxi/contract";

/**
 * 订阅消息槽位：键与标题。初始都是 unconfigured，字段定义为空数组：
 * 字段要与微信后台逐字一致，类目确定、从公共模板库选定模板后随模板 ID 一起写。
 * 标题取 D6 第 2.9.1 节的“模板取向”，同一次授权里不能重名，所以各不相同。
 */
export const WX_TEMPLATE_SLOT_SEEDS = [
  { slotKey: "pay_result", title: "付款结果" },
  { slotKey: "order_result", title: "订购结果" },
  { slotKey: "refund_result", title: "退款通知" },
  { slotKey: "invoice_result", title: "开票结果" },
  { slotKey: "service_progress", title: "服务进度" },
  { slotKey: "todo_remind", title: "待办提醒" },
  { slotKey: "review_result", title: "审核结果" },
  { slotKey: "svc_expiry", title: "服务到期提醒" },
  { slotKey: "quota_change", title: "积分变动" },
  { slotKey: "ticket_reply", title: "工单处理" },
  { slotKey: "member_change", title: "成员变动" },
  { slotKey: "asset_feedback", title: "素材采用结果" },
] as const;
export type WxTemplateSlotKey = (typeof WX_TEMPLATE_SLOT_SEEDS)[number]["slotKey"];

/**
 * 短信模板：键与类型。初始都是 unconfigured，变量定义为空数组：
 * 模板编号、签名与变量顺序等报备通过后由初始化脚本写（计划：M2）。
 */
export const SMS_TEMPLATE_SEEDS: readonly {
  readonly templateKey: string;
  readonly kind: EnumValue<typeof SMS_TEMPLATE_KIND>;
}[] = [
  { templateKey: "verify_code", kind: "verify" },
  { templateKey: "review_result", kind: "notice" },
  { templateKey: "sample_pending", kind: "notice" },
  { templateKey: "launch_remind", kind: "notice" },
  { templateKey: "plan_expiring", kind: "notice" },
  { templateKey: "offline_remind", kind: "notice" },
  { templateKey: "generic_todo", kind: "notice" },
  { templateKey: "account_notice", kind: "notice" },
  { templateKey: "ops_alert", kind: "notice" },
];

/** 一个场景的通道绑定（notify_scene 里注册表给不出的那几列） */
export interface SceneBinding {
  readonly wxTemplateSlotKey: WxTemplateSlotKey | null;
  readonly sendWindow: EnumValue<typeof NOTIFY_SCENE_SEND_WINDOW>;
  readonly smsPolicy: EnumValue<typeof NOTIFY_SCENE_SMS_POLICY>;
  readonly smsTemplateKey: string | null;
  /** 只有这些节点允许短信；空 = 全部节点 */
  readonly smsNodes: readonly string[] | null;
  /** 合并窗口（秒） */
  readonly collapseWindowSec: number;
}

/** 没有单独写的场景：只发站内，立即发 */
export const DEFAULT_SCENE_BINDING: SceneBinding = {
  wxTemplateSlotKey: null,
  sendWindow: "immediate",
  smsPolicy: "never",
  smsTemplateKey: null,
  smsNodes: null,
  collapseWindowSec: 0,
};

function bound(
  slot: WxTemplateSlotKey,
  sendWindow: SceneBinding["sendWindow"],
  sms: { fallback?: boolean; template?: string; nodes?: readonly string[] } = {},
  collapseWindowSec = 0,
): SceneBinding {
  return {
    wxTemplateSlotKey: slot,
    sendWindow,
    smsPolicy: sms.fallback === true ? "fallback" : "never",
    // 带订阅槽位的商家场景一律填短信模板，没有专用模板的用 generic_todo：后台的“补发短信”开关只改策略
    smsTemplateKey: sms.template ?? "generic_todo",
    smsNodes: sms.nodes ?? null,
    collapseWindowSec,
  };
}

/**
 * 带外部通道的商家场景（13 分组 第 2.1 节“播种”与“短信的播种口径”；发送时段与默认策略取 D6 第 2.2.1 节）。
 * 没列在这里的场景（m.rule_change_notice、接口阶段补登的 31 个、全部员工场景）用 DEFAULT_SCENE_BINDING。
 * 转交付经理的开关（manager_escalation_enabled）文档没有逐场景给默认值，都按列默认 false。
 */
export const SCENE_BINDINGS: Partial<Readonly<Record<MerchantSceneKey, SceneBinding>>> = {
  "m.pay_success": bound("pay_result", "immediate"),
  "m.order_submitted": bound("order_result", "immediate"),
  "m.plan_pending": bound("service_progress", "window"),
  "m.ad_pending": bound("service_progress", "window", {
    fallback: true,
    template: "sample_pending",
    nodes: ["R1", "M"],
  }),
  "m.sample_pending": bound("service_progress", "window", {
    fallback: true,
    template: "sample_pending",
    nodes: ["R1", "M"],
  }),
  "m.delivered": bound("service_progress", "window", { fallback: true }),
  "m.launch_remind": bound("todo_remind", "scheduled", {
    fallback: true,
    template: "launch_remind",
  }),
  "m.verify_result": bound("review_result", "window", { fallback: true }),
  "m.plan_expiring": bound("svc_expiry", "scheduled", {
    fallback: true,
    template: "plan_expiring",
    nodes: ["T-1"],
  }),
  "m.offline_remind": bound("todo_remind", "scheduled", {
    fallback: true,
    template: "offline_remind",
    nodes: ["T-1"],
  }),
  "m.ticket_reply": bound("ticket_reply", "immediate"),
  "m.invoice_issued": bound("invoice_result", "window"),
  // 积分变动合并 600 秒（D6 第 2.5 节限频表的例子）
  "m.points_changed": bound("quota_change", "window", {}, 600),
  "m.review_result": bound("review_result", "immediate", {
    fallback: true,
    template: "review_result",
  }),
  "m.member_changed": bound("member_change", "immediate"),
  "m.asset_feedback": bound("asset_feedback", "window"),
  "m.refund_result": bound("refund_result", "immediate"),
  // 补登里唯一的例外：账号安全通知总是发短信，订阅槽位本批为空
  "m.account_security": {
    ...DEFAULT_SCENE_BINDING,
    smsPolicy: "always",
    smsTemplateKey: "account_notice",
  },
};

/** 取一个场景的通道绑定 */
export function sceneBindingOf(sceneKey: string): SceneBinding {
  return (
    (SCENE_BINDINGS as Readonly<Record<string, SceneBinding | undefined>>)[sceneKey] ??
    DEFAULT_SCENE_BINDING
  );
}
