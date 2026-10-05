// 角色的代码默认配置的自测（任务书 W0-21 第 7 节第 5 条）。
import { describe, expect, it } from "vitest";

import { STAFF_ROLE_KEY } from "../enums/index.js";

import {
  ADMIN_MODULE_KEYS,
  MODULE_LEVELS,
  OWN_TASK_MODULES,
  PERMISSIONS,
  STAFF_ROLE_DEFAULTS,
  defaultRoleActions,
  permissionByKey,
  staffRoleDefault,
} from "./index.js";

describe("角色的默认配置", () => {
  it("8 个角色，键与顺序同库里的枚举；只有超级管理员锁定，只有渠道运营是 V1.1", () => {
    expect(STAFF_ROLE_DEFAULTS.map((item) => item.key)).toEqual([...STAFF_ROLE_KEY.values]);
    expect(STAFF_ROLE_DEFAULTS.filter((item) => item.isLocked).map((item) => item.key)).toEqual([
      "super_admin",
    ]);
    expect(
      STAFF_ROLE_DEFAULTS.filter((item) => item.availableFrom === "v1.1").map((item) => item.key),
    ).toEqual(["channel_ops"]);
    for (const item of STAFF_ROLE_DEFAULTS) {
      expect(item.name.trim(), item.key).not.toBe("");
      expect(item.description.trim(), item.key).not.toBe("");
    }
    expect(staffRoleDefault("finance")?.name).toBe("财务");
    expect(staffRoleDefault("nobody")).toBeUndefined();
  });

  it("13 个模块都有等级；“本人任务”只出现在交付与发布（staff.I7）", () => {
    for (const item of STAFF_ROLE_DEFAULTS) {
      expect(Object.keys(item.moduleLevels), item.key).toEqual([...ADMIN_MODULE_KEYS]);
      for (const key of ADMIN_MODULE_KEYS) {
        const level = item.moduleLevels[key];
        expect(MODULE_LEVELS, `${item.key}.${key}`).toContain(level);
        if (level === "o") {
          expect(OWN_TASK_MODULES as readonly string[], `${item.key}.${key}`).toContain(key);
        }
      }
    }
    // 照原型抽两格：剪辑师在交付是本人任务，财务管理只有财务与超级管理员能编辑
    expect(staffRoleDefault("editor")?.moduleLevels.delivery).toBe("o");
    expect(
      STAFF_ROLE_DEFAULTS.filter((item) => item.moduleLevels.finance === "e").map(
        (item) => item.key,
      ),
    ).toEqual(["super_admin", "finance"]);
  });

  it("权限点开关由默认授予算出：键都在登记里，只含 V1.0 的键", () => {
    for (const item of STAFF_ROLE_DEFAULTS) {
      const actions = defaultRoleActions(item.key);
      for (const [key, value] of Object.entries(actions)) {
        const def = permissionByKey(key);
        expect(def, `${item.key}: ${key}`).toBeDefined();
        expect(def?.since, key).toBe("v1.0");
        expect(value.on, key).toBe(true);
      }
    }
    expect(defaultRoleActions("super_admin")).toEqual({});
  });

  it("“给这几个角色”的键进这几个角色，仅主管的带 leadOnly", () => {
    for (const def of PERMISSIONS) {
      if (def.grant.kind !== "roles" || def.since !== "v1.0") continue;
      for (const granted of def.grant.roles) {
        expect(defaultRoleActions(granted.role)[def.key], `${granted.role}: ${def.key}`).toEqual({
          on: true,
          leadOnly: granted.leadOnly,
        });
      }
    }
    expect(defaultRoleActions("delivery_manager")["merchant.manager.assign"]).toEqual({
      on: true,
      leadOnly: true,
    });
    expect(defaultRoleActions("cs")["merchant.manager.assign"]).toBeUndefined();
  });

  it("各模块导出：该模块有查看权的角色默认开，没有的不进配置；仅超级管理员的键不进任何角色", () => {
    // 财务管理：客服无权限，财务可编辑
    expect(defaultRoleActions("cs")["finance.export"]).toBeUndefined();
    expect(defaultRoleActions("finance")["finance.export"]).toEqual({ on: true, leadOnly: false });
    expect(defaultRoleActions("editor")["drama.export"]).toEqual({ on: true, leadOnly: false });
    const superOnly = PERMISSIONS.filter((def) => def.grant.kind === "super_admin_only");
    expect(superOnly.length).toBeGreaterThan(0);
    for (const item of STAFF_ROLE_DEFAULTS) {
      const actions = defaultRoleActions(item.key);
      for (const def of superOnly) expect(actions[def.key], def.key).toBeUndefined();
    }
  });
});
