import { createIdentityContext } from "../../kernel/index.js";
import { createProfile } from "../../profile/index.js";
import { currentSessionOpenid } from "../../identity/index.js";
import { createTenant } from "../../tenant/index.js";
import { loadKeyring } from "../../security/index.js";
import { sampleStaffContext } from "../approval.js";
import type { AdminLiveFixture } from "./context.js";

/** 独立多店/跨主体前置；初始指派经正式同TX公口，浏览器写口产生后续状态。 */
const fixture: AdminLiveFixture = async ({ runtime, make }) => {
  if (runtime.env.APP_ENV !== "test") throw new Error("商家页面夹具只接受隔离测试环境");
  const admin = await runtime.tx.run((tx) =>
    tx.staff.findFirstOrThrow({ where: { staffRoleKey: "super_admin", status: "active" } }),
  );
  await runtime.configAdmin.createDictItem(
    {
      staff: await runtime.tx.run((tx) => sampleStaffContext(tx, admin.id)),
      identity: createIdentityContext({ actor: { type: "staff", id: admin.id, client: "admin" } }),
    },
    { typeKey: "account_change_reason", name: "W215虚构身份核对" },
  );
  const group = await runtime.tx.run((tx) =>
    tx.staffGroup.findFirstOrThrow({
      where: { staffRoleKey: "delivery_manager", isDefault: true },
    }),
  );
  const previous = await make.staff({
    name: "W215原交付经理",
    staffRoleKey: "delivery_manager",
    staffGroupId: group.id,
    status: "active",
  });
  const dormantDays = await runtime.config.params.get("auth.dormant_days");
  if (dormantDays <= 0) throw new Error("本轮正式休眠保护关闭，不能演练重认证放行申请");
  const old = new Date(runtime.clock.now().getTime() - (dormantDays + 2) * 86_400_000);
  const user = await make.merchantUser({
    createdAt: old,
    updatedAt: old,
    lastActiveAt: new Date(old.getTime() + 86_400_000),
  });
  const entity = await make.entity({
    createdByUserId: user.id,
    verificationStatus: "verified",
    createdAt: old,
    updatedAt: old,
    verifiedAt: old,
  });
  const primary = await make.store({
    entityId: entity.id,
    isPrimary: true,
    qualificationStatus: "verified",
    createdAt: old,
    updatedAt: old,
  });
  const owner = await make.entityMember({
    entityId: entity.id,
    merchantUserId: user.id,
    role: "owner",
    lastStoreId: primary.id,
    createdAt: old,
    updatedAt: old,
  });
  await make.billingAccount({ entityId: entity.id });
  const merchant = { user, entity, store: primary, owner };
  const store = await make.store({
    entityId: merchant.entity.id,
    name: "W215演练二号店",
    qualificationStatus: "verified",
  });
  const other = await make.merchant({ verified: true });
  const clerk = await make.merchantUser({ displayName: "W215演练店员" });
  const member = await make.entityMember({
    entityId: merchant.entity.id,
    merchantUserId: clerk.id,
    role: "clerk",
    displayName: "W215演练店员",
  });
  await make.storeMember({
    entityId: merchant.entity.id,
    entityMemberId: member.id,
    storeId: store.id,
    addedByMemberId: merchant.owner.id,
  });
  const tenant = createTenant(runtime);
  const profile = createProfile({
    ...runtime,
    tenant,
    keyring: () => loadKeyring(runtime.env),
    wechat: runtime.providers.wechat,
    currentOpenid: (principal) => runtime.tx.run((tx) => currentSessionOpenid(tx, principal)),
  });
  await runtime.tx.run((tx) =>
    profile.assignDeliveryManager(
      tx,
      createIdentityContext({
        actor: { type: "system", job: "lyxtest.w215_fixture" },
        entityId: merchant.entity.id,
        storeId: store.id,
      }),
      { storeId: store.id, staffId: previous.id },
    ),
  );
  return {
    store: {
      storeId: store.id,
      name: store.name,
      entityId: merchant.entity.id,
      primaryStoreId: merchant.store.id,
    },
    otherStoreId: other.store.id,
    previousManager: { staffId: previous.id, name: previous.name },
    owner: { merchantUserId: merchant.user.id, phoneMask: merchant.user.phoneMask },
    clerk: {
      merchantUserId: clerk.id,
      memberId: member.id,
      phoneMask: clerk.phoneMask,
      name: clerk.displayName,
    },
  };
};
export default fixture;
