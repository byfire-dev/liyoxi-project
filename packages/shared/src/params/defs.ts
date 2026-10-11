// 全部参数的定义（W0-18）。键与所属分组以契约的参数键清单为准（@liyoxi/contract/config/params）；
// 这里按那张清单的分组顺序，一个键一条。依据：14 分组 第 2.3、4.2 节；07 第 7 节（待回写的 7 个键）。
//
// 默认值的出处写在各组的注释里。文档写“不设”“无默认值”的，默认值是 null：未配置即不生效。
// 范围（min、max）文档多数没写：写了的照文档（注释里标出），其余按“挡住明显写错的值”取宽，
// 业务上要收紧时改这里的一行，库里超出新范围的值由自检（config.N8）报出来。
// 新增一个键：先在契约的清单里登记，再在这里加定义；少了定义，类型检查与启动自检都不过。

import { bool, enumOf, int, intList, json, slaPolicy, timeHm } from "./define.js";
import type { ParamDef } from "./define.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));
const isUnique = (list: readonly unknown[]): boolean => new Set(list).size === list.length;

/** 广告位：与契约的 PLACEMENT_SLOT 同值（纯常量抄一份只为校验；取值对不上时用例会红） */
export const PLACEMENT_SLOTS = ["opening", "ending", "corner", "mid_roll"] as const;
type PlacementSlot = (typeof PLACEMENT_SLOTS)[number];
const isSlot = (value: unknown): value is PlacementSlot =>
  (PLACEMENT_SLOTS as readonly unknown[]).includes(value);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHONE = /^1[0-9]{10}$/;
const CREDIT_CODE = /^[0-9A-Z]{18}$/;

/** 测试接收人：[{ staffId, phone?, wxOpenid? }]，一名员工一项（a09 第 3.23 节） */
export interface NotifyTestRecipient {
  staffId: string;
  phone?: string;
  wxOpenid?: string;
}
function checkTestRecipients(value: unknown): string | null {
  if (!Array.isArray(value)) return "要一个数组";
  if (value.length > 50) return "不超过 50 项";
  for (const item of value as unknown[]) {
    if (!isRecord(item) || !hasOnlyKeys(item, ["staffId", "phone", "wxOpenid"])) {
      return "每一项只能有 staffId、phone、wxOpenid";
    }
    if (typeof item.staffId !== "string" || !UUID.test(item.staffId)) return "staffId 要是 uuid";
    if (item.phone !== undefined && !(typeof item.phone === "string" && PHONE.test(item.phone))) {
      return "phone 要是 11 位手机号";
    }
    if (
      item.wxOpenid !== undefined &&
      !(typeof item.wxOpenid === "string" && /^[\w-]{1,64}$/.test(item.wxOpenid))
    ) {
      return "wxOpenid 写法不对";
    }
  }
  return isUnique((value as NotifyTestRecipient[]).map((item) => item.staffId))
    ? null
    : "同一名员工只能有一项";
}

/** 发票号码校验规则：按介质给出可接受的写法（正则），任一条匹配即可（08 分组 invoice_doc.invoice_no） */
export interface InvoiceNoRules {
  electronic: readonly string[];
  paper: readonly string[];
}
function checkInvoiceNoRules(value: unknown): string | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["electronic", "paper"])) {
    return "要 { electronic, paper }";
  }
  for (const medium of ["electronic", "paper"] as const) {
    const patterns = value[medium];
    if (!Array.isArray(patterns) || patterns.length === 0 || patterns.length > 5) {
      return `${medium} 要 1–5 条写法`;
    }
    for (const pattern of patterns as unknown[]) {
      if (typeof pattern !== "string" || !/^\^.{1,60}\$$/.test(pattern)) {
        return `${medium} 的每条写法要是以 ^ 开头、$ 结尾的正则`;
      }
      try {
        new RegExp(pattern);
      } catch {
        return `${medium} 里有不合法的正则`;
      }
    }
  }
  return null;
}

/** 授权方主体：全称与统一社会信用代码（D6 第 4.2.1 节 platform 组） */
export interface PlatformLegalEntity {
  name: string;
  creditCode: string;
}
function checkLegalEntity(value: unknown): string | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["name", "creditCode"])) {
    return "要 { name, creditCode }";
  }
  const { name, creditCode } = value;
  if (typeof name !== "string" || name.trim() === "" || [...name].length > 100) {
    return "name 要 1–100 个字";
  }
  return typeof creditCode === "string" && CREDIT_CODE.test(creditCode)
    ? null
    : "creditCode 要 18 位数字与大写字母";
}

function checkOpenSlots(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return "至少开放一种植入形式";
  if (!value.every(isSlot)) return `只能是 ${PLACEMENT_SLOTS.join("、")}`;
  return isUnique(value) ? null : "不能重复";
}

/** 广告时长选项（秒）：广告位 → 可选的时长（m06 的 AdQuote.typeOptions） */
export type AdDurationOptions = Partial<Record<PlacementSlot, readonly number[]>>;
function checkAdDurationOptions(value: unknown): string | null {
  if (!isRecord(value) || Object.keys(value).length === 0) return "至少给一种广告位的时长";
  for (const [slot, seconds] of Object.entries(value)) {
    if (!isSlot(slot)) return `广告位只能是 ${PLACEMENT_SLOTS.join("、")}`;
    if (!Array.isArray(seconds) || seconds.length === 0 || seconds.length > 6) {
      return `${slot} 要 1–6 个时长`;
    }
    if (!seconds.every((item) => isPositiveInt(item) && item <= 60)) {
      return `${slot} 的时长要是 1–60 秒的整数`;
    }
    if (!isUnique(seconds)) return `${slot} 的时长不能重复`;
  }
  return null;
}

/** 下架核查口径（14 分组 第 4.2 节）：逐条核查留证，或按比例抽查（万分比 1–10000） */
export type TakedownCheckMode = { mode: "evidence" } | { mode: "sampled"; sampleBp: number };
function checkTakedownMode(value: unknown): string | null {
  if (!isRecord(value)) return "要 { mode }";
  if (value.mode === "evidence") {
    return hasOnlyKeys(value, ["mode"]) ? null : "evidence 不带别的键";
  }
  if (value.mode !== "sampled") return "mode 只能是 evidence、sampled";
  if (!hasOnlyKeys(value, ["mode", "sampleBp"])) return "sampled 只带 sampleBp";
  return isPositiveInt(value.sampleBp) && value.sampleBp <= 10_000
    ? null
    : "sampleBp 要在 1–10000 之间";
}

/** 金额类参数的上限：一千万元，单位分 */
const FEN_MAX = 1_000_000_000;

/** 全部定义，按契约清单的分组顺序 */
export const PARAM_DEFS = [
  // ---- sla：时限策略。默认值照 14 分组 第 2.3 节 sla 一行（出处 D3 第 22.3 节）；审核类各 1 个工作日
  slaPolicy("sla.ticket.assign", "交付工单指派", {
    default: { amount: 120, unit: "work_minutes" },
  }),
  slaPolicy("sla.ticket.plan_confirm", "交付方案确认", {
    default: { amount: 1, unit: "work_days" },
  }),
  slaPolicy("sla.ticket.sample_making", "样片制作", { default: { amount: 1, unit: "work_days" } }),
  slaPolicy("sla.ticket.batch_compose", "批量合成", { default: { amount: 2, unit: "work_days" } }),
  slaPolicy("sla.ticket.delivering", "成片交付", {
    default: { amount: 1080, unit: "same_day_cutoff" },
    description: "same_day_cutoff 的数量是截止时刻距零点的分钟数，1080 即当日 18:00",
  }),
  slaPolicy("sla.delivery.target", "成片交付目标", { default: { amount: 6, unit: "work_days" } }),
  slaPolicy("sla.ad.first_version", "广告首版", { default: { amount: 2, unit: "work_days" } }),
  slaPolicy("sla.ad.revision", "广告修改", { default: { amount: 1, unit: "work_days" } }),
  // 可调 1–5 个工作日（D9 第 8 节，d9:569）
  slaPolicy("sla.review.qualification", "资质审核", {
    default: { amount: 1, unit: "work_days" },
    units: ["work_days"],
    min: 1,
    max: 5,
  }),
  slaPolicy("sla.review.channel_account", "账号核验", {
    default: { amount: 1, unit: "work_days" },
  }),
  slaPolicy("sla.review.launch_link", "链接核验", { default: { amount: 1, unit: "work_days" } }),
  slaPolicy("sla.review.store_asset", "素材审核", { default: { amount: 1, unit: "work_days" } }),
  slaPolicy("sla.review.refund_approve", "退款审批", { default: { amount: 1, unit: "work_days" } }),
  slaPolicy("sla.review.refund_execute", "退款执行", { default: { amount: 1, unit: "work_days" } }),
  slaPolicy("sla.review.transfer_proof", "对公凭证审核", {
    default: { amount: 1, unit: "work_days" },
  }),
  // 无默认值，未配置即不计时（14 分组 第 2.3 节）
  slaPolicy("sla.review.invoice_request", "开票处理", { default: null }),
  slaPolicy("sla.takedown.check", "下架核查", { default: { amount: 1, unit: "work_days" } }),
  slaPolicy("sla.service.first_response", "客服首次响应", {
    default: { amount: 30, unit: "work_minutes" },
  }),
  slaPolicy("sla.service.solution", "客服给出处理方案", {
    default: { amount: 24, unit: "natural_hours" },
  }),
  slaPolicy("sla.service.auto_resolve", "待确认的工单自动解决", {
    default: { amount: 3, unit: "natural_days" },
  }),
  slaPolicy("sla.manager.first_contact", "服务经理首次联系", {
    default: { amount: 1, unit: "work_days" },
  }),

  // ---- calendar：工作时段（D6 第 4.2.1 节）。起止的先后由 PARAM_PAIR_RULES 管
  timeHm("work.start", "上班时刻", { default: "09:00", snapshotOn: "create" }),
  timeHm("work.end", "下班时刻", { default: "18:00", snapshotOn: "create" }),

  // ---- remind：提醒（D6 第 4.2.1 节 remind 一行；D3 第 22.3 节）。每次扫描读当前值
  timeHm("remind.plan_expiry.time", "套餐到期提醒时刻", { default: "10:00" }),
  intList("remind.launch.days", "上线提醒节点（距约定上线日天数）", {
    default: [1, 0],
    unit: "天",
    min: 0,
    max: 30,
    minLength: 1,
    maxLength: 6,
    order: "desc",
  }),
  // 1–6 个、从大到小、每项 0–90（D6 第 4.2.1 节的 validate）
  intList("remind.offline.days", "下架提醒节点（距使用期止日天数）", {
    default: [30, 7, 1, 0],
    unit: "天",
    min: 0,
    max: 90,
    minLength: 1,
    maxLength: 6,
    order: "desc",
  }),
  int("remind.sample.after_days", "样片未处理提醒", { default: 2, unit: "天", min: 1, max: 30 }),
  // 范围 30–180（D8 第 4.2 节，d8:305）
  int("remind.copyright.days", "版权到期提醒提前量", {
    default: 90,
    unit: "天",
    min: 30,
    max: 180,
  }),
  int("remind.grace_hours", "提醒补发的宽限", { default: 12, unit: "小时", min: 0, max: 72 }),
  int("remind.cert_expiry.days", "证照到期提醒提前量", {
    default: 30,
    unit: "天",
    min: 1,
    max: 180,
  }),

  // ---- notify：发送时段与限频（D6 第 2.6、2.10、4.2.1 节）
  timeHm("notify.window.start", "发送时段开始", { default: "08:00" }),
  timeHm("notify.window.end", "发送时段结束", { default: "21:00" }),
  int("notify.sms.daily_cap", "同一手机号每日通知短信上限", {
    default: 6,
    unit: "条",
    min: 1,
    max: 50,
  }),
  int("notify.sms.keepalive_days", "短信模板保活间隔", { default: 5, unit: "天", min: 1, max: 30 }),
  int("notify.wx.quota_cap", "订阅消息额度估计上限", { default: 1, unit: "条", min: 1, max: 20 }),
  // D6 §2.9：拒绝后至少冷却七天；平台单次请求最多五个模板。
  int("notify.wx.ask_cooldown_days", "同一点位拒绝订阅后的本地冷却天数", {
    default: 7,
    unit: "天",
    min: 7,
    max: 30,
  }),
  int("notify.wx.max_per_ask", "每次授权请求的模板数上限", {
    default: 3,
    unit: "个",
    min: 1,
    max: 5,
  }),
  int("notify.wx.field_fail_streak", "订阅消息字段错误连续几条即停用槽位", {
    default: 5,
    unit: "条",
    min: 1,
    max: 50,
  }),
  // 07 第 7 节的待回写项：默认没有测试接收人
  json<"notify.test_recipients", readonly NotifyTestRecipient[]>(
    "notify.test_recipients",
    "测试发送的接收人",
    { default: [], check: checkTestRecipients, sensitivePaths: ["phone", "wxOpenid"] },
  ),
  // D6 §2.4 默认一千；范围是 W2-17 批准的防误值宽边界，按 user/entity 二元接收人计数。
  int("notify.fanout.batch", "规则公告每页主体接收人上限", {
    default: 1000,
    unit: "主体接收人",
    min: 1,
    max: 10000,
  }),

  // ---- general（D6 第 4.2.1 节 general 一行）
  // 1–30，默认 7（10 分组 package_link.valid_days）
  int("package.link_ttl_days", "成片下载授权有效天数", {
    default: 7,
    unit: "天",
    min: 1,
    max: 30,
    snapshotOn: "create",
  }),
  // 操作日志至少保留 3 年（PRD 第 7.12 节）
  int("audit.retention_years", "操作日志保留年数", { default: 3, unit: "年", min: 3, max: 10 }),
  int("trial.episodes", "试看集数（V1.1）", { default: 3, unit: "集", min: 1, max: 10 }),
  enumOf("inbox.scope", "消息中心的范围", {
    options: ["current_store", "all_stores"],
    default: "current_store",
  }),
  int("home.banner.max_active", "同时生效的 Banner 上限", {
    default: 5,
    unit: "张",
    min: 1,
    max: 10,
  }),

  // ---- billing：三个时限键（14 分组 第 2.3 节；M24）
  int("billing.payment.order_timeout_minutes", "微信支付待支付时限", {
    default: 30,
    unit: "分钟",
    min: 5,
    max: 120,
    snapshotOn: "create",
  }),
  int("billing.payment.transfer_valid_days", "对公转账待支付时限", {
    default: 7,
    unit: "天",
    min: 1,
    max: 30,
    snapshotOn: "create",
  }),
  int("billing.upgrade_quote_valid_hours", "升级报价有效时长", {
    default: 48,
    unit: "小时",
    min: 1,
    max: 168,
    snapshotOn: "create",
  }),

  // ---- payment、refund、invoice、recon（D2 第 7 节（b）的表）
  int("payment.bank_transfer.min_fen", "低于此金额不展示对公转账", {
    default: 0,
    unit: "分",
    min: 0,
    max: FEN_MAX,
  }),
  int("payment.wechat.advise_transfer_above_fen", "高于此金额默认选对公转账", {
    default: null,
    unit: "分",
    min: 1,
    max: FEN_MAX,
  }),
  int("refund.original_route_safety_hours", "原路退款距 365 天上限的安全余量", {
    default: 24,
    unit: "小时",
    min: 0,
    max: 720,
  }),
  int("refund.bill_wait_days", "成功退款等待账单行出现的天数", {
    default: 3,
    unit: "天",
    min: 1,
    max: 30,
  }),
  bool("refund.points.auto_approve_before_production", "开工前取消免审批", { default: false }),
  bool("refund.require_distinct_executor", "退款执行人不得是审批人", { default: false }),
  int("invoice.apply_within_days", "开票申请时限", {
    default: null,
    unit: "天",
    min: 1,
    max: 3650,
  }),
  // 电子 20 位数字；纸质 20 位数字或 8 位号码（08 分组 invoice_doc.invoice_no）
  json<"invoice.no_rules", InvoiceNoRules>("invoice.no_rules", "发票号码校验规则", {
    default: { electronic: ["^[0-9]{20}$"], paper: ["^[0-9]{20}$", "^[0-9]{8}$"] },
    check: checkInvoiceNoRules,
  }),
  timeHm("recon.first_run_time", "对账首次运行时刻", { default: "10:30" }),
  timeHm("recon.alarm_time", "对账未完成告警时刻", { default: "14:00" }),

  // ---- export、analytics（D6 第 5.1.3、5.4 节）
  int("export.max_rows", "导出行数上限", { default: 200_000, unit: "行", min: 1, max: 1_000_000 }),
  int("export.xlsx_max_rows", "xlsx 行数上限（超过改 csv）", {
    default: 50_000,
    unit: "行",
    min: 1,
    max: 200_000,
  }),
  int("export.max_concurrent_per_staff", "每名员工同时进行的导出任务数", {
    default: 3,
    unit: "个",
    min: 1,
    max: 10,
  }),
  // 桶规则 2 天兜底（D5），所以最长 48 小时
  int("export.retention_hours", "导出文件保留时长", {
    default: 24,
    unit: "小时",
    min: 1,
    max: 48,
    snapshotOn: "create",
  }),
  int("analytics.anon.daily_cap", "匿名埋点事件全站每日上限", {
    default: 200_000,
    unit: "条",
    min: 0,
    max: 10_000_000,
  }),
  int("analytics.retention_months", "埋点原始事件保留月数", {
    default: 25,
    unit: "月",
    min: 13,
    max: 60,
  }),

  // ---- platform（D6 第 4.2.1 节 platform 一行）。授权方主体要业主填，默认不设
  json<"platform.legal_entity", PlatformLegalEntity, null>(
    "platform.legal_entity",
    "授权方主体全称与统一社会信用代码",
    { default: null, check: checkLegalEntity },
  ),
  int("agreement.announce_min_days", "协议与规则变更的最短公告期", {
    default: 30,
    unit: "天",
    min: 1,
    max: 180,
  }),
  bool("docs.license.allow_stamp_only", "授权书允许只贴印章图样", { default: false }),

  // ---- identity、tenant、staff、approval（D4 附录 C 的表）
  int("auth.dormant_days", "休眠保护天数（0 即关闭）", {
    default: 180,
    unit: "天",
    min: 0,
    max: 3650,
  }),
  int("auth.identity_remove_min_age_days", "绑定满几天才能移除其他微信", {
    default: 7,
    unit: "天",
    min: 0,
    max: 90,
  }),
  int("tenant.default_store_limit", "未订阅主体的门店数上限", {
    default: 1,
    unit: "家",
    min: 1,
    max: 100,
  }),
  int("tenant.default_member_limit", "未订阅主体的成员数上限", {
    default: 3,
    unit: "人",
    min: 1,
    max: 100,
  }),
  int("invitation.ttl_hours", "邀请有效时长", {
    default: 24,
    unit: "小时",
    min: 1,
    max: 168,
    snapshotOn: "create",
  }),
  bool("invitation.require_phone", "邀请必须定向手机号", { default: false }),
  int("invitation.daily_cap", "每主体每日邀请数上限", {
    default: 20,
    unit: "个",
    min: 1,
    max: 200,
  }),
  int("admin.password_max_age_days", "后台口令最长使用天数（0 即不强制更换）", {
    default: 0,
    unit: "天",
    min: 0,
    max: 365,
  }),
  int("approval.remind_workdays", "审批未处理几个工作日后提醒", {
    default: 1,
    unit: "个工作日",
    min: 1,
    max: 10,
  }),
  int("approval.escalate_workdays", "审批未处理几个工作日后升级", {
    default: 2,
    unit: "个工作日",
    min: 1,
    max: 20,
  }),

  // ---- content（D8 第 4.4 节；07 第 7 节）
  enumOf("content.permit.platform_check", "下单时按平台缺许可号的处理", {
    options: ["block", "warn", "off"],
    default: "block",
  }),
  json<"content.placement.open_slots", readonly PlacementSlot[]>(
    "content.placement.open_slots",
    "开放的植入形式",
    { default: ["opening", "ending"], check: checkOpenSlots },
  ),
  bool("catalog.search.industry_fallback", "搜索无结果时按行业兜底推荐", { default: true }),

  // ---- media（D5 第 3.6、6.2 节；D7 第 4.11 节；07 第 7 节）
  int("media.assets.daily_file_cap", "门店每日模型处理文件上限", {
    default: 200,
    unit: "文件",
    min: 0,
    max: 200,
  }),
  int("media.model.daily_call_cap", "全局每日模型保守预留槽上限", {
    default: 0,
    unit: "槽",
    min: 0,
    max: 10_000,
  }),
  enumOf("files.purge.mode", "文件清除的运行模式", {
    options: ["list_only", "auto"],
    default: "list_only",
  }),
  int("files.purge.max_objects", "一次清除的对象数熔断阈值", {
    default: 500,
    unit: "个",
    min: 1,
    max: 100_000,
  }),
  // 50GB
  int("files.purge.max_bytes", "一次清除的字节数熔断阈值", {
    default: 53_687_091_200,
    unit: "字节",
    min: 1,
    max: 10_995_116_277_760,
  }),
  int("files.retention.portrait_auth_adopted_years", "被采用素材的肖像授权材料保留年数", {
    default: 3,
    unit: "年",
    min: 1,
    max: 30,
  }),
  // 真机验证前 100MB（D7 第 4.9 节）
  int("upload.weapp_video_max_mb", "小程序上传视频大小上限", {
    default: 100,
    unit: "MB",
    min: 1,
    max: 500,
  }),
  enumOf("download.weapp_save_mode", "小程序逐集保存的落盘方式", {
    options: ["temp", "user_dir"],
    default: "temp",
  }),

  // ---- order、ad（D3 第 22.3 节；07 第 7 节）
  int("order.start_delay_minutes", "开工延迟", {
    default: 0,
    unit: "分钟",
    min: 0,
    max: 1_440,
    snapshotOn: "create",
  }),
  int("order.rejected_stale_days", "驳回后待开工超期天数", {
    default: 7,
    unit: "天",
    min: 1,
    max: 90,
    snapshotOn: "create",
  }),
  int("ad.returned_stale_days", "广告待补充素材超期天数", {
    default: 7,
    unit: "天",
    min: 1,
    max: 90,
    snapshotOn: "create",
  }),
  json<"ad.duration_options", AdDurationOptions>("ad.duration_options", "广告时长选项（秒）", {
    default: { opening: [3, 5], ending: [5, 10] },
    check: checkAdDurationOptions,
  }),
  int("ad.revision_screenshot_max", "每轮修改意见的截图上限", {
    default: 1,
    unit: "张",
    min: 0,
    max: 9,
  }),

  // ---- delivery、publish、support、profile（D3 第 12.7、13.3、22.3 节；D5 第 9.4 节；07 第 7 节）
  bool("qc.episode.four_eyes", "逐集质检人必须不同于上传人", { default: false }),
  bool("launch.partial_goes_live", "部分集数通过即算已上线", { default: true }),
  slaPolicy("launch.verify_revoke_window", "撤销核验通过的时限", {
    default: { amount: 1, unit: "work_days" },
    snapshotOn: "read",
  }),
  // 默认按条数 10；“可改为按比例”文档没给值形态，先只做条数
  int("patrol.weekly_sample", "每周巡检抽样条数", { default: 10, unit: "条", min: 0, max: 500 }),
  json<"takedown.check_mode", TakedownCheckMode>("takedown.check_mode", "下架核查口径", {
    default: { mode: "evidence" },
    check: checkTakedownMode,
  }),
  int("service.reopen_window_days", "已解决工单可重新打开的天数（0 即关闭）", {
    default: 7,
    unit: "天",
    min: 0,
    max: 90,
  }),
  int("ocr.daily_limit_per_store", "每门店每日证照识别次数上限", {
    default: 20,
    unit: "次",
    min: 0,
    max: 200,
  }),
] as const satisfies readonly ParamDef<string, unknown, unknown>[];

/** 成对的规则：两个时刻参数一起看，起要早于止。保存与自检时用（D6 第 4.2.1 节“交叉校验”） */
export const PARAM_PAIR_RULES = [
  { start: "work.start", end: "work.end", label: "上班时刻要早于下班时刻" },
  { start: "notify.window.start", end: "notify.window.end", label: "发送时段的开始要早于结束" },
] as const;

/** 分组的显示名与页面上的顺序（后台参数页的 groups）。分组名以契约的清单为准 */
export const PARAM_GROUP_TITLES: Readonly<Record<string, string>> = {
  sla: "时限",
  calendar: "工作时间",
  remind: "提醒",
  notify: "通知",
  general: "通用",
  billing: "计费时限",
  payment: "支付",
  refund: "退款",
  invoice: "开票",
  recon: "对账",
  export: "导出",
  analytics: "埋点",
  platform: "平台",
  identity: "账号",
  tenant: "主体与成员",
  staff: "员工",
  approval: "审批",
  content: "内容",
  media: "文件与媒体",
  order: "订购",
  ad: "广告",
  delivery: "交付",
  publish: "发布",
  support: "客服",
  profile: "门店档案",
};
