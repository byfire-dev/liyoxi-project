// status_transition 的 machine 与 state_field 取值清单（01 分组 第 3.2 节；06 第 3.2 节“多态引用”，M52、M53）。
// 库里这两列只校验写法；已知取值登记在这里：25 张业务状态机表（最终表名）与各自经 flow.transition() 迁移的状态列。
// 迁移表本身（状态 × 事件 → 新状态）在 packages/shared 的 machines 目录，按这份清单声明；两边加上 01 分组 第 3.2 节的表
// 与 catalogue.json 里 state_machine = true 的表四方一致，由 pnpm machines:check 核对。
// 增减状态机或改状态列名：这里、shared 的迁移表、分组文档同一个 PR 改；库不用改。
// 纯常量：本文件不引任何包。

/** 状态机（表名）→ 它的状态列。顺序照 01 分组 第 3.2 节的表 */
export const STATE_MACHINES = {
  merchant_user: ["status"],
  entity_member: ["status"],
  invitation: ["status"],
  entity: ["lifecycle", "verification_status"],
  store: ["lifecycle", "qualification_status"],
  staff: ["status"],
  approval_request: ["status"],
  drama: ["status"],
  billing_order: ["status"],
  refund_request: ["status"],
  payment_exception: ["status"],
  invoice_request: ["status"],
  drama_order: ["status"],
  cancel_request: ["status"],
  ad: ["status"],
  order_item: ["phase"],
  delivery_ticket: ["step"],
  delivery_plan: ["status"],
  sample: ["status"],
  channel_account: ["status"],
  patrol_task: ["status"],
  takedown_task: ["status"],
  launch_task: ["review_status"],
  service_ticket: ["status"],
  license_letter: ["status"],
} as const satisfies Record<string, readonly [string, ...string[]]>;

/** status_transition.machine 的取值 */
export type StateMachineName = keyof typeof STATE_MACHINES;

/** 某个状态机的 status_transition.state_field 取值 */
export type StateFieldOf<M extends StateMachineName> = (typeof STATE_MACHINES)[M][number];

/** 全部状态机名 */
export const STATE_MACHINE_NAMES = Object.keys(STATE_MACHINES) as StateMachineName[];
