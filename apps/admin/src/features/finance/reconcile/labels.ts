export const kindLabels = {
  paid_after_cancel: "取消后收到款",
  amount_mismatch: "金额不符",
  payer_mismatch: "付款人不符",
  duplicate_receipt: "重复收款",
  fulfillment_blocked: "履约受阻",
  bill_only: "仅账单有收款",
  platform_only: "仅平台有收款",
  status_mismatch: "状态不符",
  bank_unmatched: "对公收款未关联",
  refund_bill_only: "仅账单有退款",
  refund_platform_only: "仅平台有退款",
  refund_amount_mismatch: "退款金额不符",
  refund_over: "超额退款",
  entitlement_unrecovered: "权益未完整回收",
} as const;
export const resolutionLabels = {
  restore: "补单并履约",
  refund: "发起退款申请",
  retried: "重试履约",
  rebuild_order: "重建付款单",
  link_order: "关联付款单并入账",
  offline_return: "登记线下退回",
  record_channel_refund: "补记渠道退款",
  corrected: "登记数据更正结论",
  written_off: "核销差异",
  none: "未处理",
} as const;
export const exceptionStatus = {
  open: "待处理",
  resolving: "退款审批处理中",
  resolved: "已处理",
  auto_healed: "已自动恢复",
  ignored: "已忽略",
} as const;
export const dayStatus = {
  wait: "等待账单",
  ok: "对账一致",
  diff: "存在差异",
  fixed: "差异已处理",
} as const;
export const billStatus = {
  pending: "待下载",
  downloaded: "已下载",
  parsed: "已解析",
  empty: "当日无交易",
  failed: "获取失败",
} as const;
export const resolutionHelp = {
  restore: "将实时回查渠道；确认成功后补单并履约，失败或未知保持未确认。",
  refund: "只生成退款申请并进入审批，不会在本操作中直接打款。",
  retried: "重新执行原履约；仍受阻时差异保持待处理。",
  rebuild_order: "按可信收款和回传资料重建付款单并履约，资料或价目不符将拒绝。",
  link_order: "仅可关联服务端列出的、金额和主体均符合条件的对公待付款单。",
  offline_return: "登记已经发生的线下退回，须上传本人本次凭证并核对银行流水；本页不自动转账。",
  record_channel_refund: "先实时查询渠道退款，确认后补记实际结果，可能产生权益回收或红票待办。",
  corrected: "仅登记已完成的数据更正结论，不在本页修改账本或渠道事实。",
  written_off: "仅超级管理员可核销；只记处理结论，不伪造资金或权益已修复。",
} as const;
