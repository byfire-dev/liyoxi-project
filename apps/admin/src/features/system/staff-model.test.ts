import { describe, expect, it, vi } from "vitest";

import {
  canActivateRole,
  createStaffIntent,
  creationView,
  scopeLabel,
  staffBody,
  staffLabel,
  staffSearch,
  type Role,
  type StaffBody,
  type StaffResult,
} from "./staff-model";

const role = (patch: Partial<Role> = {}): Role => ({
  roleKey: "super_admin",
  name: "超级管理员",
  description: "",
  dataScope: "all",
  isLocked: true,
  availableFrom: "v1.0",
  members: [],
  memberCount: 0,
  updatedAt: "2026-10-06T00:00:00Z",
  updatedBy: null,
  ...patch,
});
const body: StaffBody = {
  name: "演练员工",
  phone: "18800009991",
  roleKey: "super_admin",
  activateNow: true,
  isLead: false,
  activationDelivery: "manual",
  inviteWecom: false,
};

describe("员工页查询与创建守卫", () => {
  it("URL 收口保留合法筛选、页码与最近登录降序，丢掉不支持的排序/字段", () => {
    const search = staffSearch({
      q: " x ",
      roleKey: "cs",
      status: "active",
      page: "2",
      pageSize: "50",
      sort: "-lastLoginAt",
      pool: "cs",
    });
    expect(search).toMatchObject({
      q: "x",
      page: 2,
      pageSize: 50,
      sort: "-lastLoginAt",
      filters: { roleKey: "cs", status: "active" },
    });
    for (const sort of ["-staffNo", "lastLoginAt", "openWorkCount", "future"])
      expect(staffSearch({ sort }).sort).toBeUndefined();
    expect(
      staffSearch({ sort: "staffNo", roleKey: "cs,finance", status: "active,disabled" }),
    ).toMatchObject({
      sort: "staffNo",
      filters: { roleKey: "cs,finance", status: "active,disabled" },
    });
    expect(
      staffSearch({
        roleKey: "future",
        status: "bad",
        page: "0",
        pageSize: "99",
        q: "q".repeat(40),
        tab: "bad",
      }),
    ).toMatchObject({ page: 1, pageSize: 20, filters: {}, q: "q".repeat(20), tab: undefined });
  });
  it("待激活来自 active 与 isActivated，不混成待启用；范围展示接受真实字段", () => {
    expect(staffLabel({ status: "active", isActivated: false })).toBe("待激活");
    expect(staffLabel({ status: "active", isActivated: true })).toBe("启用");
    expect(staffLabel({ status: "pending", isActivated: false })).toBe("待启用");
    expect(staffLabel({ status: "disabled", isActivated: true })).toBe("已禁用");
    expect(scopeLabel("group")).toBe("本组全部");
    expect(scopeLabel("future")).toBe("—");
  });
  it("锁定的超级管理员角色仍可用于新增；姓名/手机号校验与manual方式固定", () => {
    expect(staffBody({ ...body, name: " 员工 " }, [role()], false).body).toEqual({
      ...body,
      name: "员工",
    });
    expect(staffBody({ ...body, name: " ", phone: "123" }, [role()], false).errors).toHaveProperty(
      "name",
    );
    expect(staffBody({ ...body, phone: "123" }, [role()], false).errors).toHaveProperty("phone");
    expect(staffBody({ ...body, roleKey: "future" }, [role()], false).errors).toHaveProperty(
      "roleKey",
    );
  });
  it("未发布角色只可暂不启用，release.partner 不替代角色availableFrom", () => {
    const channel = role({ roleKey: "channel_ops", availableFrom: "v1.1" });
    expect(canActivateRole(channel, false)).toBe(false);
    expect(canActivateRole(channel, true)).toBe(true);
    expect(canActivateRole(role({ availableFrom: "future" }), true)).toBe(false);
    expect(staffBody({ ...body, roleKey: "channel_ops" }, [channel], false).body).toBeUndefined();
    expect(
      staffBody({ ...body, roleKey: "channel_ops", activateNow: false }, [channel], false).body
        ?.activateNow,
    ).toBe(false);
  });
});

describe("单弹层创建意图", () => {
  it("同步双击只有一个请求，成功后不再提交且不缓存返回的激活码", async () => {
    let resolve!: (result: StaffResult) => void;
    const send = vi.fn(
      () =>
        new Promise<StaffResult>((done) => {
          resolve = done;
        }),
    );
    const intent = createStaffIntent(send, () => "staff-create:test");
    const first = intent.submit(body);
    expect(intent.pending).toBe(true);
    expect(await intent.submit(body)).toBeNull();
    const result = { replayed: false } as StaffResult;
    resolve(result);
    expect(await first).toBe(result);
    expect(await intent.submit(body)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("失败重试同键，内容修改同步换键", async () => {
    const send = vi
      .fn<(input: StaffBody, key: string) => Promise<StaffResult>>()
      .mockRejectedValue(new Error("network"));
    let sequence = 0;
    const intent = createStaffIntent(send, () => `staff-create:${++sequence}`);
    await expect(intent.submit(body)).rejects.toThrow("network");
    await expect(intent.submit(body)).rejects.toThrow("network");
    expect(send.mock.calls.map((call) => call[1])).toEqual(["staff-create:1", "staff-create:1"]);
    intent.change();
    await expect(intent.submit({ ...body, name: "修改姓名" })).rejects.toThrow("network");
    expect(send.mock.lastCall?.[1]).toBe("staff-create:2");
  });
});

describe("一次性激活码结果", () => {
  const result = {
    staff: { name: "演练员工", status: "active" },
    replayed: false,
    activation: {
      purpose: "activate",
      delivery: "manual",
      expiresAt: "2026-10-07T00:00:00Z",
      activationCode: "ABCD1234",
      replayed: false,
    },
  };
  it("首次manual展示码，外层或内层重放都不回放旧码", () => {
    expect(creationView(result).code).toBe("ABCD1234");
    expect(creationView({ ...result, replayed: true })).not.toHaveProperty("code");
    expect(
      creationView({ ...result, activation: { ...result.activation, replayed: true } }),
    ).not.toHaveProperty("code");
  });
  it("暂不启用、空码及非manual分支不伪造码或下发结果", () => {
    expect(
      creationView({ ...result, activation: null, staff: { name: "演练员工", status: "pending" } })
        .message,
    ).toContain("暂不启用");
    expect(
      creationView({ ...result, activation: { ...result.activation, activationCode: null } }),
    ).not.toHaveProperty("code");
    expect(
      creationView({ ...result, activation: { ...result.activation, delivery: "sms" } }),
    ).not.toHaveProperty("code");
  });
});
