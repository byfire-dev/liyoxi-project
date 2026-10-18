import { expect, it } from "vitest";
import { ADMIN_MODULE_KEYS } from "@liyoxi/contract/authz";
import { allowsLeadLimit, roleDraft, roleDirty, roleSearch, type RoleConfig } from "./model";

const config: RoleConfig = {
  roleKey: "cs",
  moduleLevels: Object.fromEntries(
    ADMIN_MODULE_KEYS.map((key) => [key, "v"]),
  ) as RoleConfig["moduleLevels"],
  actions: { "service.ticket.assign": { on: true, leadOnly: true } },
  dataScope: "group",
};
it("主管限定只开放实际登记的主管类权限，超级管/普通/未知键不可误设", () => {
  expect(allowsLeadLimit("service.ticket.assign")).toBe(true);
  expect(allowsLeadLimit("sys.role.edit")).toBe(false);
  expect(allowsLeadLimit("self.mfa.reset")).toBe(false);
  expect(allowsLeadLimit("future.action")).toBe(false);
});
it("角色只接受实际内置枚举，丢弃未登记角色与UI字段", () => {
  expect(roleSearch({ role: "finance", secret: "not-url" })).toEqual({ role: "finance" });
  expect(roleSearch({ role: "future" })).toEqual({});
});
it("草稿深拷贝实际返回的模块与权限，不修改当前服务事实", () => {
  const draft = roleDraft(config);
  draft.moduleLevels.system = "n";
  draft.actions["service.ticket.assign"]!.on = false;
  expect(config.moduleLevels.system).toBe("v");
  expect(config.actions["service.ticket.assign"]!.on).toBe(true);
});
it("整体替换草稿保全部13模块与精确权限集合，不补任意权限", () => {
  const draft = roleDraft(config);
  expect(Object.keys(draft.moduleLevels).sort()).toEqual([...ADMIN_MODULE_KEYS].sort());
  expect(draft.actions).toEqual(config.actions);
  expect(draft).not.toHaveProperty("roleKey");
});
it("无改动不脏，主管限定或数据范围变化均要求保存", () => {
  const a = roleDraft(config),
    b = roleDraft(config);
  expect(roleDirty(a, b)).toBe(false);
  b.dataScope = "own";
  expect(roleDirty(a, b)).toBe(true);
  const c = roleDraft(config);
  c.actions["service.ticket.assign"]!.leadOnly = false;
  expect(roleDirty(a, c)).toBe(true);
});
