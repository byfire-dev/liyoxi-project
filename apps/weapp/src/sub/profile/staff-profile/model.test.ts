import { expect, it } from "vitest";
import { ApiError } from "@/lib/request";
import {
  TENANT_ID,
  TENANT_SECOND,
  tenantMe,
  tenantMembers,
  tenantProfile,
  tenantQualification,
} from "../../../../shots/tenant-data";
import { qualificationEditable, qualificationKind, errorInfo } from "../private/model";
import { createResource } from "../private/resource";
import { selfProfile } from "./model";
it("本人店员按执行时门店匹配并裁剪owner字段；跨身份旧读拒回写，资质多轮/短信事实保真", async () => {
  expect(selfProfile(tenantMe(true), TENANT_SECOND)?.member.role).toBe("clerk");
  expect(selfProfile(tenantMe(), TENANT_SECOND)).toBeNull();
  expect(selfProfile(tenantMe(true), "outside")).toBeNull();
  const profile = tenantProfile(true),
    members = tenantMembers(true);
  expect(profile).not.toHaveProperty("ads");
  expect(members).not.toHaveProperty("seats");
  expect(members.items[0]).not.toHaveProperty("phoneMask");
  expect(members.items[0]).not.toHaveProperty("stores");
  let storeId = TENANT_ID,
    me = tenantMe(true),
    context = "clerk";
  const resource = createResource({
    context: () => context,
    message: String,
    read: async () => {
      const at = storeId;
      return selfProfile(me, at);
    },
  });
  await resource.load();
  expect(resource.snapshot().data?.member.role).toBe("clerk");
  storeId = TENANT_SECOND;
  me = tenantMe();
  context = "owner";
  resource.reset();
  await resource.load();
  expect(resource.snapshot().data).toBeNull();
  const initial = structuredClone(tenantQualification);
  expect(qualificationEditable(initial)).toBe(true);
  expect(qualificationKind(initial)).toBe("initial");
  const branch = {
    ...initial,
    openRound: null,
    entity: { ...initial.entity, verificationStatus: "verified" },
  };
  expect(qualificationKind(branch)).toBe("new_store");
  expect(qualificationKind({ ...branch, storeQualificationStatus: "verified" })).toBe("change");
  if (!initial.openRound) throw new Error("fixture");
  expect(
    qualificationEditable({ ...initial, openRound: { ...initial.openRound, phase: "in_review" } }),
  ).toBe(false);
  expect(qualificationEditable({ ...initial, isFinalRejected: true })).toBe(false);
  expect(
    errorInfo(
      new ApiError({
        error: "SMS_CODE_INVALID",
        message: "验证码不正确",
        status: 400,
        requestId: "fixture",
        details: { attemptsLeft: 2 },
      }),
    ).message,
  ).toContain("剩余 2 次");
  expect(initial.contact.isSmsVerifyAvailable).toBe(false);
});
