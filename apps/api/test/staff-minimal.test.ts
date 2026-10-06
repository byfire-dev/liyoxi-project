// W1-01b：生产鉴权链下的 "admin.staff.list"、"admin.staff.get"、"admin.staff.create"、"admin.role.list"。
import { STAFF_ROLE_DEFAULTS } from "@liyoxi/contract";
import type {
  AdminPage,
  StaffDetail,
  StaffListItem,
  StaffMutationResult,
  RoleSummary,
} from "@liyoxi/contract";
import { runSeed, security, staff, uuidv7 } from "@liyoxi/services";
import { signInAsStaff, totpNow, createFactories } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { beforeAll, describe, expect, it } from "vitest";

import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi();
const PATH = "/api/v1/admin";
const WRITE = { "x-lyx-admin": "1", origin: "http://localhost" };
let app: TestApi;
let prisma: Awaited<ReturnType<typeof handle.db.prisma>>;
let admin: SignedInStaff;
let limited: SignedInStaff;
let limitedLead: SignedInStaff;
let outsideGroup: SignedInStaff;
let manager: SignedInStaff;
let publisher: SignedInStaff;
let created: StaffMutationResult;
let editorId: string;
const createInput = {
  name: "新剪辑师",
  phone: "13900120021",
  roleKey: "editor",
  activateNow: true,
  inviteWecom: true,
};
const key = "staff-minimal-create";
let peer = 0;
const post = (path: string, json: unknown, headers: Record<string, string> = WRITE) =>
  app.request(`${PATH}${path}`, { method: "POST", json, headers, peer: `198.19.20.${++peer}` });
async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: code });
}
const create = (input: unknown, idem = uuidv7(), session = admin) =>
  post("/staff", input, { ...session.headers, "Idempotency-Key": idem });

beforeAll(async () => {
  app = await handle.start();
  prisma = await handle.db.prisma();
  await runSeed({ tx: app.runtime.tx, clock: app.clock });
  admin = await signInAsStaff(prisma, { roleKey: "super_admin" });
  const defaults = STAFF_ROLE_DEFAULTS.find((item) => item.key === "finance")!;
  await prisma.staffRole.update({
    where: { key: "finance" },
    data: { moduleLevels: { ...defaults.moduleLevels, system: "v" }, dataScope: "own" },
  });
  limited = await signInAsStaff(prisma, { roleKey: "finance" });
  limitedLead = await signInAsStaff(prisma, { roleKey: "finance", isLead: true });
  outsideGroup = await signInAsStaff(prisma, { roleKey: "finance", staffGroupId: null });
  manager = await signInAsStaff(prisma, { roleKey: "delivery_manager", isLead: true });
  const demo = await staff.seedDemoStaff({
    tx: app.runtime.tx,
    clock: app.clock,
    keyring: security.loadKeyring(app.runtime.env),
    flow: app.runtime.flow,
    appEnv: "test",
  });
  editorId = demo.staff.find((member) => member.key === "editor")!.staffId;
  publisher = await signInAsStaff(prisma, { roleKey: "publisher", isLead: true });
}, 180_000);

describe("员工新增、幂等和首次登录", { timeout: 180_000 }, () => {
  it("立即启用建待激活员工、默认分组、manual 激活码与 invited；重放不泄露明文，不重复写", async () => {
    const response = await create(createInput, key);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    created = await data<StaffMutationResult>(response);
    expect(created).toMatchObject({
      staff: {
        status: "active",
        isActivated: false,
        wecomBindStatus: "invited",
        actions: [],
        wecom: { qrUrl: null },
      },
      activation: { purpose: "activate", delivery: "manual", replayed: false },
      replayed: false,
    });
    expect(created.activation!.activationCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(
      (
        await prisma.staffGroup.findUniqueOrThrow({
          where: { id: created.staff.staffGroup!.staffGroupId },
        })
      ).isDefault,
    ).toBe(true);
    const replay = await data<StaffMutationResult>(await create(createInput, key));
    expect(replay).toMatchObject({
      staff: { staffId: created.staff.staffId },
      replayed: true,
      activation: { activationCode: null, replayed: true },
    });
    expect(await prisma.staff.count({ where: { phoneLast4: "0021" } })).toBe(1);
    const idem = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { scope: "admin.staff.create", key },
    });
    expect(JSON.stringify(idem.result)).not.toContain(created.activation!.activationCode!);
    expect(idem.result).toMatchObject({ activation: { activationCode: null } });
    await error(
      await create({ ...createInput, name: "换内容" }, key),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
  });

  it("暂不启用无激活码；未开放角色/异角色分组/无管理权/手机号占用均拒绝", async () => {
    const pending = await data<StaffMutationResult>(
      await create({
        name: "待启用渠道",
        phone: "13900120022",
        roleKey: "channel_ops",
        activateNow: false,
        inviteWecom: true,
      }),
    );
    expect(pending).toMatchObject({
      staff: { status: "pending", wecomBindStatus: "none" },
      activation: null,
    });
    await error(
      await create({
        name: "未开放",
        phone: "13900120023",
        roleKey: "channel_ops",
        activateNow: true,
      }),
      409,
      "STATE_NOT_ALLOWED",
    );
    await error(
      await create({
        ...createInput,
        phone: "13900120024",
        staffGroupId: admin.staff.staffGroupId,
      }),
      400,
      "VALIDATION_FAILED",
    );
    await error(
      await create({ ...createInput, phone: "13900120025" }, uuidv7(), limited),
      403,
      "PERMISSION_DENIED",
    );
    await error(await create(createInput), 409, "STAFF_PHONE_TAKEN");
    expect(
      await prisma.staff.count({ where: { phoneLast4: { in: ["0023", "0024", "0025"] } } }),
    ).toBe(0);
  });

  it("响应激活码可完成激活四步并取当前员工会话", async () => {
    const activated = await data<{ ticket: string }>(
      await post("/auth/activate", {
        phone: createInput.phone,
        activationCode: created.activation!.activationCode,
      }),
    );
    const password = await data<{ ticket: string }>(
      await post("/auth/set-password", { ticket: activated.ticket, newPassword: "Liyoxi-2026-ok" }),
    );
    const enrollment = await data<{ ticket: string; secret: string }>(
      await post("/auth/enroll-totp", { ticket: password.ticket }),
    );
    const response = await post("/auth/confirm-totp", {
      ticket: enrollment.ticket,
      code: totpNow(enrollment.secret, app.clock),
    });
    expect(await data(response)).toMatchObject({
      me: { staff: { staffId: created.staff.staffId, roleKey: "editor" } },
    });
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("lyx_admin="))!
      .split(";")[0]!;
    expect(await data(await app.request(`${PATH}/auth/me`, { headers: { cookie } }))).toMatchObject(
      { staff: { staffId: created.staff.staffId } },
    );
  });
});

describe("列表、选人、详情与角色", { timeout: 180_000 }, () => {
  it("完整列表/详情按当前 DataScope，范围外与不存在同为 404", async () => {
    const own = await data<AdminPage<StaffListItem>>(
      await app.request(`${PATH}/staff`, { headers: limited.headers }),
    );
    expect(own.total).toBe(1);
    expect(own.items.map((item) => item.staffId)).toEqual([limited.staff.id]);
    const group = await data<AdminPage<StaffListItem>>(
      await app.request(`${PATH}/staff`, { headers: limitedLead.headers }),
    );
    expect(group.items.map((item) => item.staffId)).toEqual(
      expect.arrayContaining([limited.staff.id, limitedLead.staff.id]),
    );
    expect(group.items.map((item) => item.staffId)).not.toContain(outsideGroup.staff.id);
    await error(
      await app.request(`${PATH}/staff/${outsideGroup.staff.id}`, { headers: limitedLead.headers }),
      404,
      "NOT_FOUND",
    );
    await error(
      await app.request(`${PATH}/staff/${created.staff.staffId}`, { headers: limited.headers }),
      404,
      "NOT_FOUND",
    );
    await error(
      await app.request(`${PATH}/staff/${uuidv7()}`, { headers: admin.headers }),
      404,
      "NOT_FOUND",
    );
    await error(
      await app.request(`${PATH}/staff/${manager.staff.id}`, { headers: manager.headers }),
      403,
      "PERMISSION_DENIED",
    );
    const all = await data<AdminPage<StaffListItem>>(
      await app.request(`${PATH}/staff?roleKey=delivery_manager`, { headers: admin.headers }),
    );
    expect(all.items.find((item) => item.staffId === manager.staff.id)?.dataScope).toBe("group");
  });

  it("池读权可跨本人范围看安全候选；只列池内 active，全部所带池均须有读权", async () => {
    const factory = createFactories({ db: prisma, clock: app.clock });
    const pending = await factory.staff({
      name: "池内待启用",
      staffRoleKey: "editor",
      status: "pending",
    });
    await prisma.assignmentPoolMember.create({
      data: {
        staffId: pending.id,
        pool: "editor",
        cityCode: "",
        createdAt: app.clock.now(),
        updatedAt: app.clock.now(),
      },
    });
    await error(
      await app.request(`${PATH}/staff`, { headers: manager.headers }),
      403,
      "PERMISSION_DENIED",
    );
    await error(
      await app.request(`${PATH}/staff?pool=publisher,cs`, { headers: publisher.headers }),
      403,
      "PERMISSION_DENIED",
    );
    const pool = await data<AdminPage<StaffListItem>>(
      await app.request(`${PATH}/staff?recommendPool=editor&withLoad=true&sort=openWorkCount`, {
        headers: manager.headers,
      }),
    );
    expect(pool.items.map((item) => item.staffId)).toEqual([editorId]);
    expect(pool.items[0]).toMatchObject({
      status: "active",
      phoneMask: null,
      isRecommended: true,
      openWorkCount: 0,
      openWorkBySource: [],
      actions: [],
    });
    await error(
      await app.request(`${PATH}/staff?withLoad=true&pageSize=51`, { headers: admin.headers }),
      400,
      "VALIDATION_FAILED",
    );
    await error(
      await app.request(`${PATH}/staff?sort=openWorkCount`, { headers: admin.headers }),
      400,
      "VALIDATION_FAILED",
    );
    await error(
      await app.request(`${PATH}/staff?recommendPool=delivery_manager`, { headers: admin.headers }),
      400,
      "VALIDATION_FAILED",
    );
  });

  it("数字后四位/姓名/多值/主管筛选与分页生效，withLoad=false 保留 null", async () => {
    const exact = await data<AdminPage<StaffListItem>>(
      await app.request(`${PATH}/staff?q=0021&status=active,pending`, { headers: admin.headers }),
    );
    expect(exact.items.map((item) => item.staffId)).toEqual([created.staff.staffId]);
    expect(exact.items[0]).toMatchObject({ openWorkCount: null, openWorkBySource: null });
    const byName = await data<AdminPage<StaffListItem>>(
      await app.request(
        `${PATH}/staff?q=${encodeURIComponent("新剪辑")}&roleKey=editor,cs&isLead=false`,
        { headers: admin.headers },
      ),
    );
    expect(byName.items.map((item) => item.staffId)).toEqual([created.staff.staffId]);
    const page = await data<AdminPage<StaffListItem>>(
      await app.request(
        `${PATH}/staff?roleKey=delivery_manager&isLead=true&pageSize=1&page=2&sort=staffNo`,
        { headers: admin.headers },
      ),
    );
    expect(page).toMatchObject({ page: 2, pageSize: 1, total: 2 });
    expect(page.items).toHaveLength(1);
    const latest = await data<AdminPage<StaffListItem>>(
      await app.request(`${PATH}/staff?sort=-lastLoginAt&pageSize=1`, { headers: admin.headers }),
    );
    expect(latest.items.map((item) => item.staffId)).toEqual([created.staff.staffId]);
  });

  it("详情仅返回展示/安全状态，IP 隐去第三段；角色恰八行且启用成员按工号排序", async () => {
    await prisma.staff.update({
      where: { id: created.staff.staffId },
      data: { lastLoginIp: "198.51.100.7" },
    });
    const response = await app.request(`${PATH}/staff/${created.staff.staffId}`, {
      headers: admin.headers,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const detail = await data<StaffDetail>(response);
    expect(detail).toMatchObject({
      isActivated: true,
      security: { isActivated: true, lastLoginIpMask: "198.51.**.7", recoveryCodesLeft: 10 },
      wecom: { qrUrl: null },
    });
    const serialized = JSON.stringify(detail);
    for (const forbidden of [
      "phoneEnc",
      "phoneBidx",
      "passwordHash",
      "totpSecretEnc",
      "codeHash",
      '"recoveryCodes"',
    ])
      expect(serialized).not.toContain(forbidden);
    expect(serialized).not.toContain(createInput.phone);
    const rolesResponse = await app.request(`${PATH}/roles`, { headers: admin.headers });
    expect(rolesResponse.headers.get("Cache-Control")).toBe("no-store");
    const roles = await data<{ items: RoleSummary[] }>(rolesResponse);
    expect(roles.items).toHaveLength(8);
    for (const role of roles.items) {
      expect(role.memberCount).toBe(role.members.length);
      expect(role.members.every((member) => member.status === "active")).toBe(true);
      expect(role.members.map((member) => member.staffNo)).toEqual(
        role.members.map((member) => member.staffNo).sort((a, b) => a - b),
      );
    }
    await error(
      await app.request(`${PATH}/roles`, { headers: manager.headers }),
      403,
      "PERMISSION_DENIED",
    );
  });
});
