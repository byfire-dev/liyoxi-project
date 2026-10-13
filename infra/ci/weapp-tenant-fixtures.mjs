// 仓库层同源快照：显式静态依赖可检查，由tsx按weapp tsconfig加载，不把Zod带回端侧。
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
process.stdout.write(
  JSON.stringify({
    entityId: TENANT_ID,
    targetStoreId: TENANT_SECOND,
    ownerStores: tenantStores(),
    clerkStores: tenantStores(true),
    createDefault: storeCreateBody(input),
    createCopied: storeCreateBody({ ...input, options: ["service", "media"] }),
    ownerMembers: tenantMembers(),
    clerkMembers: tenantMembers(true),
    clerkProfile: tenantProfile(true),
    invitation: tenantInvitation,
    invitationBody: { clientRequestId: TENANT_ID, remarkName: "晚班", targetPhone: "13900009000" },
    previews: ["pending", "accepted", "revoked", "expired"].map((status) => tenantPreview(status)),
    membership: tenantResult,
    abandoned: { ...tenantResult, abandonedEntityId: TENANT_ID },
  }),
);
