// 8 个后台角色的代码默认配置（03 分组 第 2.1、4 节；a01 第 2.9、3.34 节 RoleConfig）。
// 两处取它：播种 staff_role（W0-21）；“恢复默认”接口 admin.role.defaults.get。库里的行可以被后台改，这里的不变。
// 名称、职责、模块等级、数据范围照原型 admin/SysRoles（与 PRD 第 3.3 节的权限矩阵一致）。
// actions 不手写：由权限点登记的默认授予算出（defaultRoleActions），登记改了它跟着变。
// 纯常量：本文件只引本目录的登记，不引任何包。
import type { EnumValue } from "../enums/define.js";
import type { STAFF_ROLE_AVAILABLE_FROM, STAFF_ROLE_DATA_SCOPE } from "../enums/staff.js";

import type { PermissionDef, PermissionGroup, StaffRoleKey } from "./define.js";
import { ADMIN_MODULE_KEYS } from "./modules.js";
import type { AdminModuleKey, ModuleLevel } from "./modules.js";
import { PERMISSION_GROUPS } from "./permissions/index.js";

/** 角色的数据范围：own 本人负责、group 本组、all 全部（staff_role.data_scope） */
export type RoleDataScope = EnumValue<typeof STAFF_ROLE_DATA_SCOPE>;
/** 起始版本（staff_role.available_from） */
export type RoleAvailableFrom = EnumValue<typeof STAFF_ROLE_AVAILABLE_FROM>;

/** 13 个模块各一个等级（staff_role.module_levels） */
export type RoleModuleLevels = Readonly<Record<AdminModuleKey, ModuleLevel>>;
/** 一个权限点的开关（staff_role.actions 的值） */
export interface RoleActionSwitch {
  readonly on: boolean;
  readonly leadOnly: boolean;
}
/** 权限点 → 开关；只含该角色适用的键（staff_role.actions） */
export type RoleActions = Readonly<Record<string, RoleActionSwitch>>;

export interface StaffRoleDefault {
  readonly key: StaffRoleKey;
  readonly name: string;
  /** 职责描述（角色页左栏） */
  readonly description: string;
  readonly moduleLevels: RoleModuleLevels;
  readonly dataScope: RoleDataScope;
  /** 超级管理员为真：不可编辑 */
  readonly isLocked: boolean;
  readonly availableFrom: RoleAvailableFrom;
}

/** 一行等级照模块登记的顺序写：工作台、短剧库、套餐与积分、商家、订单、交付、发布、客服、财务、报表、内容运营、系统、渠道 */
function levels(row: readonly ModuleLevel[]): RoleModuleLevels {
  if (row.length !== ADMIN_MODULE_KEYS.length) {
    throw new Error(`模块等级要写满 ${ADMIN_MODULE_KEYS.length} 个，实有 ${row.length} 个`);
  }
  return Object.fromEntries(
    ADMIN_MODULE_KEYS.map((key, index) => [key, row[index]]),
  ) as RoleModuleLevels;
}

function role(
  key: StaffRoleKey,
  name: string,
  description: string,
  row: readonly ModuleLevel[],
  dataScope: RoleDataScope,
  options: { isLocked?: boolean; availableFrom?: RoleAvailableFrom } = {},
): StaffRoleDefault {
  return {
    key,
    name,
    description,
    moduleLevels: levels(row),
    dataScope,
    isLocked: options.isLocked ?? false,
    availableFrom: options.availableFrom ?? "v1.0",
  };
}

/** 顺序同 staff_role.key 的枚举 */
export const STAFF_ROLE_DEFAULTS: readonly StaffRoleDefault[] = [
  role(
    "super_admin",
    "超级管理员",
    "配置员工账号、角色权限与系统参数",
    // 数据报表只开放查看
    ["v", "e", "e", "e", "e", "e", "e", "e", "e", "v", "e", "e", "e"],
    "all",
    { isLocked: true },
  ),
  role(
    "cs",
    "客服",
    "售前咨询、售后工单处理、订单跟进",
    ["v", "v", "v", "e", "e", "v", "v", "e", "n", "v", "n", "n", "v"],
    "all",
  ),
  role(
    "delivery_manager",
    "交付经理",
    "担任商家的专属服务经理，确认交付方案与上线日期，分派并跟进交付工单",
    ["v", "v", "v", "e", "v", "e", "e", "e", "n", "v", "n", "n", "v"],
    "own",
  ),
  role(
    "editor",
    "剪辑师",
    "制作与修改广告视频，合成植入成片，上传样片与成片",
    ["v", "v", "n", "v", "n", "o", "n", "n", "n", "n", "n", "n", "n"],
    "own",
  ),
  role(
    "publisher",
    "发布专员",
    "交付成片包与发布清单，核验上线链接，跟进按时上线与到期下架",
    ["v", "v", "n", "v", "n", "v", "o", "n", "n", "n", "n", "n", "n"],
    "own",
  ),
  role(
    "content_ops",
    "内容运营",
    "维护短剧库与剧目积分价，配置套餐、商城与营销活动",
    ["v", "e", "e", "v", "v", "v", "v", "v", "n", "v", "e", "n", "n"],
    "all",
  ),
  role(
    "channel_ops",
    "渠道运营",
    "招募与审核服务商，配置服务商等级与返佣比例，审核商家归属变更",
    ["v", "v", "v", "v", "v", "n", "n", "n", "n", "v", "n", "n", "e"],
    "own",
    { availableFrom: "v1.1" },
  ),
  role(
    "finance",
    "财务",
    "确认收款、处理退款、开具发票、对账与服务商结算",
    ["v", "v", "v", "v", "e", "n", "n", "v", "e", "v", "n", "n", "v"],
    "all",
  ),
];

/** 按键找角色的默认配置 */
export function staffRoleDefault(key: string): StaffRoleDefault | undefined {
  return STAFF_ROLE_DEFAULTS.find((item) => item.key === key);
}

/** “有该模块查看权的角色默认开”的键（各模块导出）归哪个模块：键的第一段 */
function moduleOfViewerKey(key: string): AdminModuleKey | undefined {
  const head = key.split(".")[0];
  return (ADMIN_MODULE_KEYS as readonly string[]).includes(head ?? "")
    ? (head as AdminModuleKey)
    : undefined;
}

/**
 * 角色的默认权限点开关，由权限点登记的默认授予算出（registry-permissions 第 1 节“默认授予”一栏）：
 *   roles             列到这个角色的 → { on: true, leadOnly }
 *   module_viewers    这个角色在该模块的等级不是 n → { on: true, leadOnly: false }
 *   super_admin_only、all_staff、undecided  不进任何角色的配置
 * 超级管理员拥有全部，不逐个写：它的 actions 是空对象。V1.1 的键 V1.0 不挂载，不写。
 */
export function defaultRoleActions(key: StaffRoleKey): RoleActions {
  const base = staffRoleDefault(key);
  if (base === undefined) throw new Error(`没有这个角色：${key}`);
  if (key === "super_admin") return {};
  const actions: Record<string, RoleActionSwitch> = {};
  const all: readonly PermissionDef[] = PERMISSION_GROUPS.flatMap(
    (group: PermissionGroup) => group.permissions,
  );
  for (const item of all) {
    if (item.since !== "v1.0") continue;
    if (item.grant.kind === "roles") {
      const granted = item.grant.roles.find((entry) => entry.role === key);
      if (granted) actions[item.key] = { on: true, leadOnly: granted.leadOnly };
    } else if (item.grant.kind === "module_viewers") {
      const moduleKey = moduleOfViewerKey(item.key);
      if (moduleKey === undefined) {
        throw new Error(`权限点 ${item.key} 标了“有该模块查看权”，键的第一段却不是模块键`);
      }
      if (base.moduleLevels[moduleKey] !== "n") {
        actions[item.key] = { on: true, leadOnly: false };
      }
    }
  }
  return actions;
}
