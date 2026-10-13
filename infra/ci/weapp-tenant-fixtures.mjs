// 仓库层同源校验：显式静态依赖可检查，由tsx按weapp tsconfig加载，不把Zod带回端侧。
import assert from "node:assert/strict";
import {
  InvitationCardSchema,
  InvitationCreateBodySchema,
  InvitationPreviewSchema,
  MemberListSchema,
  MemberUpdateBodySchema,
  MembershipResultSchema,
  StoreCreateBodySchema,
  StoreListSchema,
  StoreProfileOverviewSchema,
} from "../../packages/contract/src/index.ts";
import {
  TENANT_ID,
  TENANT_SECOND,
  tenantInvitation,
  tenantMembers,
  tenantPreview,
  tenantProfile,
  tenantResult,
  tenantStores,
} from "../../apps/weapp/shots/tenant-data.ts";
import { storeCreateBody } from "../../apps/weapp/src/sub/profile/store-add/model.ts";

const input = {
  name: "  新门店  ",
  detail: "邻里路18号",
  industry: "food",
  category: "coffee",
  addressPrefix: "广东省深圳市福田区",
  sourceId: TENANT_SECOND,
  options: [],
};
assert.equal(StoreListSchema.parse(tenantStores()).viewerRole, "owner");
assert.equal(StoreListSchema.parse(tenantStores(true)).viewerRole, "clerk");
assert.equal(MemberListSchema.parse(tenantMembers()).viewerRole, "owner");
assert.equal(MemberListSchema.parse(tenantMembers(true)).viewerRole, "clerk");
assert.equal(StoreProfileOverviewSchema.parse(tenantProfile(true)).viewerRole, "clerk");
assert.deepEqual(StoreCreateBodySchema.parse(storeCreateBody(input)), {
  name: "新门店",
  addressDetail: "广东省深圳市福田区邻里路18号",
  industryCode: "food",
  categoryCode: "coffee",
});
const copied = StoreCreateBodySchema.parse(
  storeCreateBody({ ...input, options: ["service", "media"] }),
);
assert.equal(copied.copyFromStoreId, TENANT_SECOND);
assert.deepEqual(copied.copyOptions, ["service", "media"]);
assert.equal(MemberUpdateBodySchema.safeParse({ storeIds: [] }).success, false);
assert.equal(
  MemberUpdateBodySchema.safeParse({ storeIds: [TENANT_SECOND, TENANT_SECOND] }).success,
  false,
);
assert.equal(InvitationCardSchema.parse(tenantInvitation).storeId, TENANT_SECOND);
const invitationBody = {
  clientRequestId: TENANT_ID,
  remarkName: "晚班",
  targetPhone: "13900009000",
};
assert.deepEqual(InvitationCreateBodySchema.parse(invitationBody), invitationBody);
for (const status of ["pending", "accepted", "revoked", "expired"])
  assert.equal(InvitationPreviewSchema.parse(tenantPreview(status)).status, status);
assert.equal(MembershipResultSchema.parse(tenantResult).storeId, TENANT_SECOND);
assert.equal(
  MembershipResultSchema.parse({ ...tenantResult, abandonedEntityId: TENANT_ID }).abandonedEntityId,
  TENANT_ID,
);
process.stdout.write(JSON.stringify({ checked: "W214六页同源契约", invitationStates: 4 }));
