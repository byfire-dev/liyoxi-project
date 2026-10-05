// flow 的内部错误（W0-16）：都是代码缺陷，不是用户输入的问题，接口层按 500 处理。
// 业务上的拒绝（当前状态下不能发生、守卫不满足）不走这里：那是 AppError("STATE_NOT_ALLOWED") 或守卫给出的领域码。

export type FlowRefusal =
  /** 状态机与状态列不在迁移表里；对象 id 不是 UUID */
  | "unknown_chain"
  /** 事件码不在这条链上；或用普通迁移发人工纠偏的 admin.force */
  | "unknown_event"
  /** 新状态有几个候选而没给目标；几行文档都放行这次迁移而没给 ref；给的 ref 不放行 */
  | "ambiguous"
  /** 新建的用法不对：这条链已经有历史、给了随迁列、目标与业务行的当前值不一致 */
  | "created"
  /** 迁移行标了守卫，拥有状态机的模块没有登记实现 */
  | "guard_missing"
  /** 随迁列没有登记，或库里没有这一列 */
  | "column"
  /** 状态历史的载荷不是对象 */
  | "payload"
  /** 没传审计内容，又没有活动流默认描述（staff 一律要传） */
  | "audit_required"
  /** 既没传事件，也没声明不发 */
  | "event_required"
  /** 要算工作分钟的三张表迁移时，工作分钟端口没有注册；或它返回的不是非负整数 */
  | "work_minutes"
  /** 状态机的登记写错了（装配后校验） */
  | "binding";

export class FlowError extends Error {
  readonly reason: FlowRefusal;

  constructor(reason: FlowRefusal, message: string) {
    super(`状态迁移没有执行：${message}`);
    this.name = "FlowError";
    this.reason = reason;
  }
}
