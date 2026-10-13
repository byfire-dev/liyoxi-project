import { beforeAll, describe, expect, it } from "vitest";
import {
  AccountChangeRequestDetailSchema,
  AccountChangeRequestListSchema,
  DictItemViewSchema,
} from "@liyoxi/contract";
import type { AccountChangeRequestDetail } from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, signInAsStaff, snapshotTables } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi(),
  SLOW = 120_000,
  DAY = 86_400_000;
let api: TestApi, prisma: Awaited<ReturnType<typeof handle.db.prisma>>;
let make: ReturnType<typeof createFactories>;
let cs: SignedInStaff, otherCs: SignedInStaff, lead: SignedInStaff, staleLead: SignedInStaff;
let manager: SignedInStaff,
  editor: SignedInStaff,
  reasonCode: string,
  peer = 0;
const TABLES = [
  "merchant_user",
  "entity",
  "entity_member",
  "store",
  "store_member",
  "account_change_request",
  "approval_request",
  "file_object",
  "file_ref",
  "audit_log",
  "outbox_event",
  "status_transition",
  "timer",
  "idempotency_record",
];

beforeAll(async () => {
  api = await handle.start();
  prisma = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  make = createFactories({ db: prisma, clock: api.clock });
  const admin = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  cs = await signInAsStaff(prisma, { roleKey: "cs", now: api.clock.now() });
  otherCs = await signInAsStaff(prisma, { roleKey: "cs", now: api.clock.now() });
  lead = await signInAsStaff(prisma, { roleKey: "cs", isLead: true, now: api.clock.now() });
  staleLead = await signInAsStaff(prisma, {
    roleKey: "cs",
    isLead: true,
    now: new Date(api.clock.now().getTime() - 11 * 60_000),
  });
  manager = await signInAsStaff(prisma, { roleKey: "delivery_manager", now: api.clock.now() });
  editor = await signInAsStaff(prisma, { roleKey: "editor", now: api.clock.now() });
  reasonCode = DictItemViewSchema.parse(
    await payload(
      await api.request("/api/v1/admin/dict-items", {
        method: "POST",
        json: { typeKey: "account_change_reason", name: "账号归属人工核实" },
        headers: { ...admin.headers, "Idempotency-Key": uuidv7() },
      }),
    ),
  ).code;
}, SLOW);

function request(
  path = "",
  json?: unknown,
  caller: SignedInStaff | null = cs,
  key: string | null = uuidv7(),
) {
  return api.request(`/api/v1/admin/account-change-requests${path}`, {
    method: json === undefined ? "GET" : "POST",
    ...(json === undefined ? {} : { json }),
    headers: {
      ...(caller?.headers ?? { origin: "http://localhost", "x-lyx-admin": "1" }),
      ...(json === undefined || key === null ? {} : { "Idempotency-Key": key }),
    },
    peer: `198.19.74.${++peer}`,
  });
}
async function payload(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: unknown }).data;
}
async function detail(response: Response) {
  const body = await payload(response);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const value = AccountChangeRequestDetailSchema.parse(body);
  expect(JSON.stringify(value)).not.toMatch(/phoneEnc|phoneBidx|newPhone"|https?:\/\/|tokenHash/);
  return value;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
function mounted(operationId: string) {
  expect(HANDLERS.filter((entry) => entry.route.operationId === operationId)).toHaveLength(1);
}
async function owner(deliveryManagerId?: string) {
  const user = await make.merchantUser({
    lastActiveAt: new Date(api.clock.now().getTime() - 181 * DAY),
    dormantBypassUntil: null,
  });
  const entity = await make.entity({ createdByUserId: user.id, verificationStatus: "verified" });
  const store = await make.store({
    entityId: entity.id,
    isPrimary: true,
    ...(deliveryManagerId ? { deliveryManagerId } : {}),
  });
  await make.entityMember({
    entityId: entity.id,
    merchantUserId: user.id,
    role: "owner",
    lastStoreId: store.id,
  });
  return { user, entity, store };
}
function createBody(w: Awaited<ReturnType<typeof owner>>, extra: Record<string, unknown> = {}) {
  return {
    kind: "owner_reverify",
    merchantUserId: w.user.id,
    proofFileIds: [],
    verifyMethod: "电话回访",
    verifyRecord: "核对经营主体与老板身份记录一致",
    reasonCode,
    reasonText: "老板休眠后申请人工复核账号归属",
    confirm: { targetPhoneMask: w.user.phoneMask },
    ...extra,
  };
}
async function pending(caller = cs, deliveryManagerId?: string) {
  const w = await owner(deliveryManagerId);
  return { ...w, change: await detail(await request("", createBody(w), caller)) };
}
const pathOf = (value: AccountChangeRequestDetail) => `/${value.accountChangeRequestId}`;
const approveBody = (value: AccountChangeRequestDetail) => ({
  lockVersion: value.approval.lockVersion,
  confirm: { requestNo: value.requestNo, newPhoneMask: value.newPhoneMask },
  confirmChecks: ["callback_done"],
});

describe("admin.accountChangeRequest.list", { timeout: SLOW }, () => {
  it("真实分页筛选、own范围和登录要求；GET及拒绝均零业务写", async () => {
    mounted("admin.accountChangeRequest.list");
    const visible = await pending(cs, manager.staff.id),
      hidden = await pending(otherCs);
    const before = await snapshotTables(prisma, TABLES);
    const response = await request(
      `?entityId=${visible.entity.id}&merchantUserId=${visible.user.id}&kind=owner_reverify,phone_rebind&status=pending,rejected&page=1&pageSize=1`,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const list = AccountChangeRequestListSchema.parse(await payload(response));
    expect(list).toMatchObject({ page: 1, pageSize: 1, total: 1 });
    expect(list.items.map((item) => item.accountChangeRequestId)).toEqual([
      visible.change.accountChangeRequestId,
    ]);
    const scoped = AccountChangeRequestListSchema.parse(
      await payload(await request("?kind=owner_reverify&status=pending", undefined, manager)),
    );
    expect(scoped.items.map((item) => item.accountChangeRequestId)).toContain(
      visible.change.accountChangeRequestId,
    );
    expect(scoped.items.map((item) => item.accountChangeRequestId)).not.toContain(
      hidden.change.accountChangeRequestId,
    );
    await error(await request("?kind=unknown"), 400, "VALIDATION_FAILED");
    expect(
      AccountChangeRequestListSchema.parse(
        await payload(await request(`?entityId=${visible.entity.id}`, undefined, editor)),
      ).total,
    ).toBe(0);
    await error(await request("", undefined, null), 401, "AUTH_REQUIRED");
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
  });
});

describe("admin.accountChangeRequest.get", { timeout: SLOW }, () => {
  it("完整脱敏DTO与真实actions/precheck，跨范围及不存在同态404且GET零写", async () => {
    mounted("admin.accountChangeRequest.get");
    const p = await pending(),
      before = await snapshotTables(prisma, TABLES);
    const own = await detail(await request(pathOf(p.change)));
    expect(own).toMatchObject({
      target: { merchantUserId: p.user.id, phoneMask: p.user.phoneMask },
      entity: { entityId: p.entity.id },
      reason: { code: reasonCode },
      proofFileIds: [],
      verifyMethod: "电话回访",
      currentOwner: null,
      precheck: { ok: true, issues: [] },
      result: null,
      appliedAt: null,
      actions: ["withdraw"],
    });
    expect((await detail(await request(pathOf(p.change), undefined, lead))).actions).toEqual([
      "approve",
      "reject",
    ]);
    for (const id of [p.change.accountChangeRequestId, uuidv7()])
      await error(await request(`/${id}`, undefined, manager), 404, "NOT_FOUND");
    await error(await request(pathOf(p.change), undefined, null), 401, "AUTH_REQUIRED");
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
  });
});

describe("admin.accountChangeRequest.create", { timeout: SLOW }, () => {
  it("客服发起真实审批并幂等重放；回显、权限、重复及三kind条件必填拒绝无写", async () => {
    mounted("admin.accountChangeRequest.create");
    const w = await owner(),
      body = createBody(w),
      key = uuidv7();
    const created = await detail(await request("", body, cs, key));
    expect(created).toMatchObject({
      kind: "owner_reverify",
      approval: { status: "pending", requester: { staffId: cs.staff.id } },
      newPhoneMask: null,
    });
    const before = await snapshotTables(prisma, TABLES);
    const replay = await request("", body, cs, key);
    expect(await detail(replay)).toEqual(created);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    await error(await request("", body, otherCs), 409, "APPROVAL_ALREADY_PENDING");
    await error(await request("", body, manager), 403, "PERMISSION_DENIED");
    await error(await request("", body, cs, null), 400, "IDEMPOTENCY_KEY_REQUIRED");
    for (const invalid of [
      {
        kind: "phone_rebind",
        merchantUserId: w.user.id,
        newPhone: "13911112222",
        reasonCode,
        reasonText: "人工换绑",
        confirm: body.confirm,
      },
      {
        kind: "owner_transfer",
        entityId: w.entity.id,
        proofFileIds: [uuidv7()],
        reasonCode,
        reasonText: "老板更换",
        confirm: body.confirm,
      },
      { ...body, verifyRecord: "" },
    ])
      await error(await request("", invalid), 400, "VALIDATION_FAILED");
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
    const fresh = await owner(),
      unchanged = await snapshotTables(prisma, TABLES);
    await error(
      await request("", createBody(fresh, { confirm: { targetPhoneMask: "不匹配" } })),
      409,
      "CONFIRM_MISMATCH",
    );
    expect(await snapshotTables(prisma, TABLES)).toEqual(unchanged);
  });
});

describe("admin.accountChangeRequest.approve", { timeout: SLOW }, () => {
  it("主管决定同事务生效；自审、再验证、版本及回显失败不写，成功仅一次", async () => {
    mounted("admin.accountChangeRequest.approve");
    const p = await pending(),
      self = await pending(lead),
      path = pathOf(p.change) + "/approve";
    const body = approveBody(p.change),
      before = await snapshotTables(prisma, TABLES);
    await error(await request(path, body, cs), 403, "PERMISSION_DENIED");
    await error(await request(path, body, staleLead), 403, "STEP_UP_REQUIRED");
    await error(
      await request(pathOf(self.change) + "/approve", approveBody(self.change), lead),
      403,
      "APPROVAL_SELF_FORBIDDEN",
    );
    await error(
      await request(path, { ...body, lockVersion: body.lockVersion + 1 }, lead),
      409,
      "VERSION_CONFLICT",
    );
    await error(
      await request(path, { ...body, confirm: { ...body.confirm, requestNo: "错误单号" } }, lead),
      409,
      "CONFIRM_MISMATCH",
    );
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
    const key = uuidv7(),
      approved = await detail(await request(path, body, lead, key));
    const bypassUntil = new Date(api.clock.now().getTime() + 3 * DAY).toISOString();
    expect(approved).toMatchObject({
      approval: { status: "approved", decidedBy: { staffId: lead.staff.id } },
      appliedAt: api.clock.now().toISOString(),
      result: { bypassUntil },
      confirmChecks: ["callback_done"],
      precheck: null,
      actions: [],
    });
    expect(await prisma.merchantUser.findUnique({ where: { id: p.user.id } })).toMatchObject({
      dormantBypassUntil: new Date(bypassUntil),
    });
    const after = await snapshotTables(prisma, TABLES);
    expect(await detail(await request(path, body, lead, key))).toEqual(approved);
    expect(await snapshotTables(prisma, TABLES)).toEqual(after);
    expect(
      await prisma.auditLog.findFirst({
        where: { targetId: p.change.approval.approvalId, actorId: lead.staff.id },
      }),
    ).toMatchObject({ sessionId: lead.sessionId, authMethod: "password+totp" });
  });
});

describe("admin.accountChangeRequest.reject", { timeout: SLOW }, () => {
  it("驳回免再验证但仍检查主管、自审、必填说明和单号；失败零写", async () => {
    mounted("admin.accountChangeRequest.reject");
    const p = await pending(otherCs),
      self = await pending(lead),
      path = pathOf(p.change) + "/reject";
    const body = { note: "回访信息不足，请补充核实", confirm: { requestNo: p.change.requestNo } };
    const before = await snapshotTables(prisma, TABLES);
    await error(await request(path, body, cs), 403, "PERMISSION_DENIED");
    await error(
      await request(
        pathOf(self.change) + "/reject",
        { ...body, confirm: { requestNo: self.change.requestNo } },
        lead,
      ),
      403,
      "APPROVAL_SELF_FORBIDDEN",
    );
    await error(await request(path, { ...body, note: "" }, staleLead), 400, "VALIDATION_FAILED");
    await error(
      await request(path, { ...body, confirm: { requestNo: "错误单号" } }, staleLead),
      409,
      "CONFIRM_MISMATCH",
    );
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
    expect(await detail(await request(path, body, staleLead))).toMatchObject({
      approval: {
        status: "rejected",
        decisionNote: body.note,
        decidedBy: { staffId: staleLead.staff.id },
      },
      result: null,
      appliedAt: null,
      precheck: null,
      actions: [],
    });
    const after = await snapshotTables(prisma, TABLES);
    await error(await request(path, body, staleLead), 409, "APPROVAL_NOT_PENDING");
    expect(await snapshotTables(prisma, TABLES)).toEqual(after);
  });
});

describe("admin.accountChangeRequest.withdraw", { timeout: SLOW }, () => {
  it("发起人本人撤回与幂等；活跃发起人禁止代撤，错回显无写", async () => {
    mounted("admin.accountChangeRequest.withdraw");
    const p = await pending(otherCs),
      path = pathOf(p.change) + "/withdraw";
    const body = { note: "重新整理核实记录后再提交", confirm: { requestNo: p.change.requestNo } };
    const before = await snapshotTables(prisma, TABLES);
    await error(await request(path, body, cs), 403, "APPROVAL_WITHDRAW_FORBIDDEN");
    await error(await request(path, body, lead), 403, "APPROVAL_WITHDRAW_FORBIDDEN");
    await error(
      await request(path, { ...body, confirm: { requestNo: "错误单号" } }, otherCs),
      409,
      "CONFIRM_MISMATCH",
    );
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
    const key = uuidv7(),
      withdrawn = await detail(await request(path, body, otherCs, key));
    expect(withdrawn).toMatchObject({
      approval: { status: "withdrawn", decidedBy: null, decisionNote: body.note },
      appliedAt: null,
      result: null,
      precheck: null,
      actions: [],
    });
    const after = await snapshotTables(prisma, TABLES);
    expect(await detail(await request(path, body, otherCs, key))).toEqual(withdrawn);
    expect(await snapshotTables(prisma, TABLES)).toEqual(after);
  });
});
