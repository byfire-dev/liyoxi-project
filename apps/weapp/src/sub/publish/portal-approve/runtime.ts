import type { Me } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
import { request } from "@/lib/runtime";
import { deliveryScope } from "@/stores/delivery";
import { useSessionStore } from "@/stores/session";
import { createPortalApprovalApi } from "./api";
import { approvalIdentity } from "./model";

export const portalApprovalIdentity = () =>
  approvalIdentity(deliveryScope(), useSessionStore.getState().me as Me | null);

let call: RequestLayer["request"] = request;
let installation: Promise<void> | null = null;
async function installShots() {
  if (process.env.TARO_ENV !== "h5") return;
  const scene = (globalThis as { __LYX_PORTAL_APPROVAL_SHOT__?: string })
    .__LYX_PORTAL_APPROVAL_SHOT__;
  if (scene) {
    installation ??= import("../../../../shots/portal-approval-fixtures").then(
      ({ offlinePortalApprovalRequest }) => {
        call = offlinePortalApprovalRequest(scene);
      },
    );
    await installation;
  }
}
export const portalApprovalApi = createPortalApprovalApi(async (path, options) => {
  await installShots();
  return call(path, options);
});
