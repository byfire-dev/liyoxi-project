import {
  AccountChangeRequestDetailSchema,
  EntityCardSchema,
  FollowUpItemSchema,
  MemberRowSchema,
} from "@liyoxi/contract";
import { describe, expect, it } from "vitest";
import { createAdminApi } from "../../../lib/api";
import type { AccessSnapshot } from "../../../lib/permissions";
import { writeIntent } from "../../system/staff-access";
import {
  closeIntent,
  createAccountIntent,
  decideAccountIntent,
  followIntent,
  quotaIntent,
  userIntent,
} from "./actions";
import { createMerchantApi } from "./api";
import { allowed, merchantDetailSearch, merchantScope, status, text, validStoreId } from "./model";
const id = "0199e187-e72a-7000-8000-000000000001",
  other = "0199e187-e72a-7000-8000-000000000002",
  now = "2030-10-14T04:00:00.000Z";
const user = {
  merchantUserId: other,
  displayName: "虚构老板",
  phoneMask: "138****0000",
  status: "active",
};
const entity = EntityCardSchema.parse({
  entityId: id,
  name: "虚构主体",
  entityType: "enterprise",
  lifecycle: "active",
  closedAt: null,
  verificationStatus: "verified",
  usccMask: "91****01",
  legalRepNameMask: "测*",
  verifiedAt: now,
  sourceType: "organic",
  referralCode: null,
  createdAt: now,
  owner: user,
  subscription: {
    status: "none",
    plan: null,
    months: null,
    startDate: null,
    endDate: null,
    hasScheduledTerm: false,
    isRefundPending: false,
    latestPaymentOrder: null,
  },
  usage: {
    storesUsed: 2,
    storeLimit: 4,
    seatsUsed: 3,
    memberLimit: 5,
    storesOver: 0,
    seatsOver: 0,
    limitReason: "plan",
    storeLimitOverride: 4,
    memberLimitOverride: null,
    pendingInvitationCount: 1,
    activeMemberCount: 3,
    isOverLimit: false,
  },
  spendablePoints: 7,
  stores: [],
  pendingInvitations: [],
  lockVersion: 9,
  actions: ["update-quota", "close"],
});
const member = MemberRowSchema.parse({
  memberId: id,
  user,
  role: "owner",
  status: "active",
  storeIds: [id, other],
  joinedAt: now,
  registeredAt: now,
  removedAt: null,
  removeReason: null,
  uploadedAssetCount: 3,
  adoptedAssetCount: 2,
  actions: ["disable", "force-logout"],
});
const request = AccountChangeRequestDetailSchema.parse({
  accountChangeRequestId: id,
  kind: "phone_rebind",
  requestNo: "AC-TEST-001",
  approval: {
    approvalId: other,
    kind: "account_change",
    status: "pending",
    roundNo: 2,
    submittedAt: now,
    dueAt: null,
    badges: [],
    requester: null,
    decidedBy: null,
    isDecidedBySystem: false,
    decidedAt: null,
    decisionNote: null,
    reasons: [],
    lockVersion: 12,
    actions: ["approve", "reject"],
  },
  target: user,
  entity: { entityId: id, name: "虚构主体" },
  newPhoneMask: "139****0000",
  reason: { code: "lost", name: "虚构原因" },
  reasonText: "虚构证明核验",
  appliedAt: now,
  actions: ["approve", "reject"],
  proofFileIds: [other],
  confirmChecks: ["identity_checked"],
  verifyMethod: null,
  verifyRecord: null,
  currentOwner: user,
  precheck: { ok: true, issues: [] },
  result: null,
  createdAt: now,
});
const follow = FollowUpItemSchema.parse({
  followUpId: id,
  subjectType: "store",
  subjectId: other,
  entityId: id,
  storeId: other,
  channel: "phone",
  content: "虚构联系记录",
  intent: null,
  nextFollowAt: now,
  isOpen: true,
  owner: null,
  doneAt: null,
  doneNote: null,
  recorder: { actorType: "system", staff: null },
  createdAt: now,
  lockVersion: 4,
  actions: ["update", "complete"],
});
const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, message: "ok", data }), {
    headers: { "Content-Type": "application/json" },
  });
const fail = (status: number, error: string, details?: unknown) =>
  new Response(JSON.stringify({ code: 40001, error, message: "虚构受控拒绝", details }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function transport(reply?: (request: Request, index: number) => Response, stepped = () => {}) {
  const requests: Request[] = [];
  const api = createMerchantApi({
    api: createAdminApi({
      baseUrl: "http://admin.test",
      build: "w215",
      fetch: async (input) => {
        if (!(input instanceof Request)) throw new Error("必须使用真实Request");
        requests.push(input.clone());
        if (reply) return reply(input, requests.length);
        const path = new URL(input.url).pathname;
        if (path.endsWith("members")) return ok({ items: [member] });
        if (path.endsWith("follow-ups"))
          return ok({ items: [follow], page: 1, pageSize: 20, total: 1 });
        if (path.includes("account-change-requests")) return ok(request);
        return ok(entity);
      },
      handlers: {
        redirectToLogin() {},
        stepUp: async () => {
          stepped();
          return true;
        },
        refreshAccess() {},
        invalidateQueries() {},
        notify() {},
        showBlocked() {},
        buildMismatch() {},
      },
    }),
  });
  return { api, requests };
}
const access: AccessSnapshot = {
  staff: { id, name: "虚构员工", roleKey: "cs", roleName: "客服" },
  isLead: true,
  moduleLevels: { merchant: "v" },
  actions: ["merchant.quota.override"],
  dataScope: "all",
  releases: {},
};
describe("W215商家详情真实意图", () => {
  it("actor/scope及server actions缺一关闭入口，非首门店ID/空值/未来字段不会借旧事实", () => {
    expect(validStoreId(other)).toBe(true);
    expect(validStoreId("first")).toBe(false);
    expect(merchantDetailSearch({ tab: "invented" })).toEqual({ tab: "profile" });
    expect(merchantDetailSearch({ tab: "entity", private: "drop" })).toEqual({ tab: "entity" });
    expect(allowed(access, "merchant.quota.override", ["update-quota"], "update-quota")).toBe(true);
    for (const current of [null, { ...access, moduleLevels: {} }, { ...access, actions: [] }])
      expect(allowed(current, "merchant.quota.override", ["update-quota"], "update-quota")).toBe(
        false,
      );
    expect(allowed(access, "merchant.quota.override", [], "update-quota")).toBe(false);
    for (const current of [
      { ...access, staff: { ...access.staff, id: other } },
      { ...access, dataScope: "own" as const },
      { ...access, actions: [] },
    ])
      expect(merchantScope(current)).not.toBe(merchantScope(access));
    expect(text({ privateKey: "never-render" })).toBe("—");
    expect(text("名字\n后缀")).toBe("名字 后缀");
    expect(status({ privateKey: "never-render" }, "entity.source_type")).toBe("未识别状态");
    expect(status("future_source", "entity.source_type")).toBe("future_source");
  });
  it("额度/关闭与成员账号意图携带服务器当前版本、回显与实际目标，非法额度不发写", async () => {
    const client = transport(),
      actual = await client.api.entity(id),
      owner = (await client.api.members(id, { storeId: other })).items[0]!;
    expect(() =>
      quotaIntent(actual).prepare({ stores: "0", members: "1", reason: "虚构调整" }, [], []),
    ).toThrow();
    await quotaIntent(actual).prepare(
      { stores: "", members: "6", reason: "虚构调整" },
      [],
      [],
    )(client.api, "quota-key");
    await closeIntent(actual).prepare(
      { reason: "经核对后关闭本虚构测试主体" },
      [],
      [],
    )(client.api, "close-key");
    await userIntent(owner, "disable").prepare(
      { reason: "虚构账号核对" },
      [],
      [],
    )(client.api, "disable-key");
    await userIntent(owner, "logout").prepare({}, [], [])(client.api, "logout-key");
    const writes = client.requests.filter((item) => item.method !== "GET");
    expect(await Promise.all(writes.map((item) => item.json()))).toEqual([
      {
        storeLimitOverride: null,
        memberLimitOverride: 6,
        lockVersion: 9,
        confirm: { storeLimitOverride: 4, memberLimitOverride: null },
        reasonText: "虚构调整",
      },
      {
        reasonText: "经核对后关闭本虚构测试主体",
        confirm: { activeStoreCount: 2, activeMemberCount: 3 },
      },
      { reasonText: "虚构账号核对", confirm: { phoneMask: "138****0000" } },
      { confirm: { phoneMask: "138****0000" } },
    ]);
    expect(new URL(writes[2]!.url).pathname).toContain(`/merchant-users/${other}/disable`);
    expect(writes.map((item) => item.headers.get("Idempotency-Key"))).toEqual([
      "quota-key",
      "close-key",
      "disable-key",
      "logout-key",
    ]);
  });
  it("账号申请证明与审批回显/版本分开，门店跟进不伪造新建且已有记录版本保留", async () => {
    const client = transport(),
      actual = await client.api.entity(id),
      owner = (await client.api.members(id)).items[0]!,
      approval = await client.api.request(id),
      contact = (await client.api.follows({ storeId: other })).items[0]!;
    const create = createAccountIntent("phone_rebind", actual, owner.user, [
      { value: "lost", label: "虚构原因" },
    ]);
    const values = { reasonCode: "lost", reason: "虚构申请说明", phone: "13900000000" };
    expect(() => create.prepare(values, [], [])).toThrow();
    await create.prepare(values, [other], [])(client.api, "apply-key");
    await decideAccountIntent(approval, "approve").prepare(
      {},
      [],
      ["identity_checked"],
    )(client.api, "approve-key");
    await decideAccountIntent(approval, "reject").prepare(
      { reason: "虚构驳回" },
      [],
      [],
    )(client.api, "reject-key");
    expect(() =>
      followIntent(contact, "continue").prepare({ content: "不能以store新建" }, [], []),
    ).toThrow();
    await followIntent(contact, "update").prepare({ next: "" }, [], [])(client.api, "follow-key");
    const writes = client.requests.filter((item) => item.method !== "GET");
    expect(await Promise.all(writes.map((item) => item.json()))).toEqual([
      {
        kind: "phone_rebind",
        merchantUserId: other,
        reasonCode: "lost",
        reasonText: "虚构申请说明",
        newPhone: "13900000000",
        proofFileIds: [other],
        confirm: { targetPhoneMask: "138****0000" },
      },
      {
        lockVersion: 12,
        confirm: { requestNo: "AC-TEST-001", newPhoneMask: "139****0000" },
        confirmChecks: ["identity_checked"],
      },
      { note: "虚构驳回", confirm: { requestNo: "AC-TEST-001" } },
      { lockVersion: 4, nextFollowAt: null },
    ]);
  });
  it("中央step-up与手动重试保留同意图键，409/越权/不可见原样失败不转为成功", async () => {
    let stepups = 0,
      posts = 0;
    const client = transport(
      (input) => {
        if (input.method === "GET") return ok(entity);
        if (new URL(input.url).pathname.endsWith("quota")) {
          posts++;
          return posts === 1
            ? fail(403, "STEP_UP_REQUIRED")
            : posts === 2
              ? fail(503, "PROVIDER_UNAVAILABLE")
              : ok(entity);
        }
        return fail(409, "ENTITY_CLOSE_BLOCKED", { blockers: ["active_subscription"] });
      },
      () => stepups++,
    );
    const actual = await client.api.entity(id),
      prepared = quotaIntent(actual).prepare(
        { stores: "4", members: "6", reason: "虚构调整" },
        [],
        [],
      );
    const intent = writeIntent("quota", () => "stable-key");
    await expect(
      intent.run({ action: "quota" }, (key) => prepared(client.api, key)),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", status: 503 });
    await intent.run({ action: "quota" }, (key) => prepared(client.api, key));
    expect(stepups).toBe(1);
    expect(client.requests.slice(1).map((item) => item.headers.get("Idempotency-Key"))).toEqual([
      "stable-key",
      "stable-key",
      "stable-key",
    ]);
    await expect(
      closeIntent(actual).prepare(
        { reason: "虚构关闭主体原因已核对" },
        [],
        [],
      )(client.api, "close-key"),
    ).rejects.toMatchObject({
      code: "ENTITY_CLOSE_BLOCKED",
      status: 409,
      details: { blockers: ["active_subscription"] },
    });
    for (const [http, code] of [
      [403, "PERMISSION_DENIED"],
      [404, "NOT_FOUND"],
      [409, "STALE_VERSION"],
      [409, "CONFIRM_MISMATCH"],
      [409, "SELF_APPROVAL_FORBIDDEN"],
    ] as const) {
      const rejected = transport(() => fail(http, code));
      await expect(rejected.api.store(other)).rejects.toMatchObject({ code, status: http });
    }
  });
});
