import type { components } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../app/services";
import { accessResult, type StaffDetail, type OpenWork } from "./staff-access";

export interface StaffCommandDraft {
  name: string;
  roleKey: components["schemas"]["StaffUpdateBody"]["roleKey"];
  isLead: boolean;
  staffGroupId: string;
  displayName: string;
  servicePhone: string;
  ackNoLead: boolean;
  target: string;
  reason: "resigned" | "reassigned" | "long_leave" | "other";
  note: string;
  wecomUserid: string;
  takeOver: boolean;
  bucket: "trusted" | "untrusted" | "all";
  delivery: "manual" | "sms";
  memberships: components["schemas"]["StaffPoolMembershipReplaceBody"]["memberships"];
}
export function commandDraft(staff: StaffDetail): StaffCommandDraft {
  return {
    name: staff.name,
    roleKey: staff.roleKey as StaffCommandDraft["roleKey"],
    isLead: staff.isLead,
    staffGroupId: staff.staffGroup?.staffGroupId ?? "",
    displayName: staff.displayName ?? "",
    servicePhone: staff.servicePhone ?? "",
    ackNoLead: false,
    target: "",
    reason: "reassigned",
    note: "",
    wecomUserid: staff.wecom.userid ?? "",
    takeOver: false,
    bucket: "all",
    delivery: "manual",
    memberships: staff.poolMemberships.map((row) => ({
      pool: row.pool as StaffCommandDraft["memberships"][number]["pool"],
      cityCode: row.city?.code ?? null,
    })),
  };
}
export async function sendStaffCommand(
  services: { api: Pick<AppServices["api"], "client"> },
  staff: Pick<StaffDetail, "staffId" | "staffNo" | "lockVersion">,
  action: string,
  draft: StaffCommandDraft,
  key: string,
  work?: OpenWork,
) {
  const params = { path: { staffId: staff.staffId } },
    headers = { "Idempotency-Key": key };
  const delivery = { activationDelivery: draft.delivery };
  switch (action) {
    case "update":
      return accessResult(
        await services.api.client.PATCH("/api/v1/admin/staff/{staffId}", {
          params,
          headers,
          body: {
            name: draft.name.trim(),
            roleKey: draft.roleKey,
            isLead: draft.isLead,
            ...(draft.staffGroupId ? { staffGroupId: draft.staffGroupId } : {}),
            displayName: draft.displayName.trim() || null,
            servicePhone: draft.servicePhone.trim() || null,
            ackNoLead: draft.ackNoLead,
            lockVersion: staff.lockVersion,
          },
        }),
      );
    case "enable":
      return accessResult(
        await services.api.client.POST("/api/v1/admin/staff/{staffId}/enable", {
          params,
          headers,
          body: delivery,
        }),
      );
    case "reissue-activation-code":
      return accessResult(
        await services.api.client.POST("/api/v1/admin/staff/{staffId}/reissue-activation-code", {
          params,
          headers,
          body: delivery,
        }),
      );
    case "reset-password":
      return accessResult(
        await services.api.client.POST("/api/v1/admin/staff/{staffId}/reset-password", {
          params,
          headers,
          body: { ...delivery, confirm: { staffNo: staff.staffNo }, note: draft.note || undefined },
        }),
      );
    case "reset-mfa":
      return accessResult(
        await services.api.client.POST("/api/v1/admin/staff/{staffId}/reset-mfa", {
          params,
          headers,
          body: { ...delivery, confirm: { staffNo: staff.staffNo }, note: draft.note || undefined },
        }),
      );
    case "disable": {
      if (!work) throw new Error("请先读取当前在办摘要");
      return accessResult(
        await services.api.client.POST("/api/v1/admin/staff/{staffId}/disable", {
          params,
          headers,
          body: {
            ...(draft.target ? { handoverToStaffId: draft.target } : {}),
            reason: draft.reason,
            note: draft.note || undefined,
            confirm: { staffNo: staff.staffNo, openWorkCount: work.total },
          },
        }),
      );
    }
    case "handover": {
      if (draft.reason === "resigned") throw new Error("仅移交请使用调岗、长期休假或其他原因");
      return accessResult(
        await services.api.client.POST("/api/v1/admin/staff/{staffId}/handover", {
          params,
          headers,
          body: {
            handoverToStaffId: draft.target,
            reason: draft.reason,
            note: draft.note || undefined,
          },
        }),
      );
    }
    case "unlock":
      return accessResult(
        await services.api.client.POST("/api/v1/admin/staff/{staffId}/unlock", {
          params,
          headers,
          body: { bucket: draft.bucket, note: draft.note || undefined },
        }),
      );
    case "bind-wecom":
      return accessResult(
        await services.api.client.POST("/api/v1/admin/staff/{staffId}/bind-wecom", {
          params,
          headers,
          body: { wecomUserid: draft.wecomUserid.trim(), takeOver: draft.takeOver },
        }),
      );
    case "invite-wecom":
      return accessResult(
        await services.api.client.POST("/api/v1/admin/staff/{staffId}/invite-wecom", {
          params,
          headers,
        }),
      );
    case "pools":
      return accessResult(
        await services.api.client.PUT("/api/v1/admin/staff/{staffId}/pool-memberships", {
          params,
          headers,
          body: { memberships: draft.memberships, lockVersion: staff.lockVersion },
        }),
      );
    default:
      throw new Error("未登记的员工操作");
  }
}
