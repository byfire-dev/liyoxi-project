// approval 的内部错误（W1-06）：代码缺陷，不是用户输入的问题。接口层按 500 INTERNAL 回，原始信息只进日志。
// 业务上的拒绝（不在审、发起人审批、无权、已有在审、前提已变）抛的是 AppError，带契约里的错误符号名。
export type ApprovalRefusal =
  | "registry" // 登记写错：键不是审批类型、大类对不上、单号前缀与去重键的有无不对
  | "unregistered" // 这个 kind 没有模块登记
  | "actor" // 操作人与入参对不上：员工操作没给员工上下文、商家来决定
  | "summary" // 处理器生成的摘要不合 ApprovalSummary
  | "execution" // recordExecuted 用在没有执行步的类型或还没通过的审批单上
  | "bypass"; // 没经本模块的函数、直接调 flow.transition 去迁移审批单

export class ApprovalError extends Error {
  readonly reason: ApprovalRefusal;

  constructor(reason: ApprovalRefusal, message: string) {
    super(`approval：${message}`);
    this.name = "ApprovalError";
    this.reason = reason;
  }
}
