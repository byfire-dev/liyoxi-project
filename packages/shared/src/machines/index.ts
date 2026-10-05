// 子路径 @liyoxi/shared/machines：25 张业务状态机表的迁移表（27 条链）与查表的纯函数。
//
// 依据：03 第 3.1 节（迁移表是 packages/shared 里的代码数据）；06 第 3.4 节；01 分组 第 2.6、3.2 节；
// 计划 第 5.7 节“状态机”行。用法、加行的规矩、与分组文档对照的口径见本目录的 README.md。
// 一个模块一个文件，文件名是 services 的模块名；汇总是自动收集的：加一个模块文件，在下面照样加两行，
// 漏加时用例会红（目录里的文件与这里收的要一一对应）。
// 纯常量与纯函数：本入口可达的文件只引 @liyoxi/contract 的纯常量子路径。

import type { StateFieldOf, StateMachineName } from "@liyoxi/contract/registry";

import * as ad from "./ad.js";
import * as approval from "./approval.js";
import * as billing from "./billing.js";
import * as content from "./content.js";
import type { Chain } from "./define.js";
import * as delivery from "./delivery.js";
import * as docs from "./docs.js";
import * as identity from "./identity.js";
import * as order from "./order.js";
import * as publish from "./publish.js";
import * as staff from "./staff.js";
import * as support from "./support.js";
import * as tenant from "./tenant.js";

export { ADMIN_FORCE_EVENT, NO_GUARD, SAME, chain } from "./define.js";
export type { Chain, RowInput, TransitionRow } from "./define.js";
export * from "./lookup.js";

const SOURCES = {
  ad,
  approval,
  billing,
  content,
  delivery,
  docs,
  identity,
  order,
  publish,
  staff,
  support,
  tenant,
};

const isChain = (value: unknown): value is Chain =>
  typeof value === "object" &&
  value !== null &&
  "machine" in value &&
  "stateField" in value &&
  "rows" in value;

/** 按文件汇总：键是模块名（services 的模块） */
export const CHAINS_BY_MODULE: Readonly<Record<string, readonly Chain[]>> = Object.fromEntries(
  Object.entries(SOURCES).map(([module, exported]) => [
    module,
    Object.values(exported).filter(isChain),
  ]),
);

/** 全部链：一张状态机表的一个状态列一条 */
export const CHAINS: readonly Chain[] = Object.values(CHAINS_BY_MODULE).flat();

let byColumn: Map<string, Chain> | undefined;

/** 按状态机（表名）与状态列取链；没有登记的返回 undefined */
export function findChain(machine: string, stateField: string): Chain | undefined {
  byColumn ??= new Map(CHAINS.map((item) => [item.column, item] as const));
  return byColumn.get(`${machine}.${stateField}`);
}

/** 按契约登记的状态机与状态列取链。契约登记了而这里没有声明的会抛错：对照脚本与用例保证不会发生 */
export function chainOf<M extends StateMachineName>(
  machine: M,
  stateField: StateFieldOf<M>,
): Chain {
  const found = findChain(machine, stateField);
  if (found === undefined) throw new Error(`没有 ${machine}.${stateField} 的迁移表`);
  return found;
}
