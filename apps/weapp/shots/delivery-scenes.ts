/** 交付域固定离线场景，样片含Q9关闭与历史渠道状态。 */
const id = "00000000-0000-4000-8000-000000000020";
export const DELIVERY_SCENES = [
  ...["plan-pending", "plan-revising", "plan-confirmed", "plan-change"].map((name) => ({
    name,
    route: `sub/order/plan/index?deliveryPlanId=${id}`,
  })),
  ...[
    "sample-unsaved",
    "sample-viewed",
    "sample-confirmed",
    "sample-disabled",
    "sample-legacy",
  ].map((name) => ({
    name,
    route: `sub/order/sample/index?orderItemId=${id}`,
  })),
  ...["tasks-todo", "tasks-verifying", "tasks-live", "tasks-submit"].map((name) => ({
    name,
    route:
      name === "tasks-submit"
        ? `sub/publish/tasks/index?launchTaskId=${id}`
        : "sub/publish/tasks/index",
  })),
  ...["downloads-default", "downloads-expired"].map((name) => ({
    name,
    route: `sub/publish/downloads/index?orderItemId=${id}`,
  })),
  ...["record-default", "record-returned"].map((name) => ({
    name,
    route: `sub/order/launch-record/index?orderItemId=${id}`,
  })),
] as const;
