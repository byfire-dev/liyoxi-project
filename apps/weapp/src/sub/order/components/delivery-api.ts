import type { operations } from "@liyoxi/contract/types/merchant";
import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
export type Plan = Data<"m.deliveryPlan.get">;
export type Sample = Data<"m.orderItem.sample.get">;
export type Release = Data<"m.orderItem.release.get">;
export type TaskPage = Data<"m.launchTask.list">;
export type Task = Data<"m.launchTask.get">;
export type Submit = Body<"m.launchTask.submit">;
export type Change = Body<"m.deliveryPlan.requestChange">;
export type TaskQuery = NonNullable<operations["m.launchTask.list"]["parameters"]["query"]>;
import { createPlanApi } from "../plan/api";
import { createSampleApi } from "../sample/api";
import { createTaskReadApi } from "../../publish/components/task-read-api";
import { createTaskWriteApi } from "../../publish/tasks/api";
import { createReleaseApi } from "../../publish/components/release-api";
/** 全接口组合只供独立端口测试；页面按用途取工厂，避免无关写口提升主包。 */
export function createDeliveryApi(send: RequestLayer["request"]) {
  return {
    ...createPlanApi(send),
    ...createSampleApi(send),
    ...createTaskReadApi(send),
    ...createTaskWriteApi(send),
    ...createReleaseApi(send),
  };
}
export type DeliveryApi = ReturnType<typeof createDeliveryApi>;
