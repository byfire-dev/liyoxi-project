/** W120 商家五页十五态；本域独立离线数据，旧场景保持。 */
const id = "00000000-0000-4000-8000-000000000020";
export const DELIVERY_SCENES = [
  ...["plan-pending", "plan-revising", "plan-confirmed", "plan-change"].map((name) => ({
    name,
    route: `sub/order/plan/index?deliveryPlanId=${id}`,
  })),
  ...["sample-unsaved", "sample-viewed", "sample-confirmed"].map((name) => ({
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
