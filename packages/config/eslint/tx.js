// 事务入口规则片段（W0-07；01 第 5 节调用规则 2；ADR-005）：开事务只有 kernel 的 tx.run 一个入口，
// kernel 之外不得出现 $transaction。prisma.$transaction、tx.$transaction、prisma["$transaction"] 都算。
//
// 管的范围是 apps 与 packages 下的源码，三处除外：
//   packages/services/src/kernel/    入口本身
//   packages/services/src/testing/   测试支架：进程中断的场景夹具要绕开入口直接开事务
//   packages/db/                     数据访问层自己：客户端工厂的用例在这里，它引不到 services
// files 里的一组（内层数组）要同时满足：第一个模式圈范围，后面三个取反把上面三处划出去。

/** 不得出现 $transaction 的路径 */
export const txEntryFiles = [
  [
    "{apps,packages}/**/*.{ts,tsx,js,jsx,mjs,cjs}",
    "!packages/services/src/kernel/**",
    "!packages/services/src/testing/**",
    "!packages/db/**",
  ],
  // 第二组（复审后补，只加行）：上面划出去的 testing/ 与 packages/db/ 两处，本意只为用例与夹具，
  // 这两个目录里其余的源码照样受管。组内同样要同时满足：第一个模式圈范围，后两个取反划掉用例与夹具。
  [
    "packages/{db,services/src/testing}/**/*.{ts,tsx,js,jsx,mjs,cjs}",
    "!**/*.test.{ts,tsx,js,jsx,mjs,cjs}",
    "!**/__fixtures__/**",
  ],
];

const message =
  "开事务只有 kernel 的 tx.run 一个入口：用例函数调 tx.run，往下传 tx；要局部回滚用 savepoint（01 第 5 节调用规则 2）。";

/** 后面的包要再禁别的语法，把自己的条目与这里的拼在一起：同一条规则后写的配置会整条盖掉前面的 */
export const txEntryRestrictedSyntax = [
  { selector: "MemberExpression[property.name='$transaction']", message },
  { selector: "MemberExpression[property.value='$transaction']", message },
  // 以下三条是复审后补的（只加行）：不经成员访问、字面上照样出现 $transaction 的写法。
  // 解构：const { $transaction } = prisma、const { $transaction: begin } = prisma
  { selector: "ObjectPattern > Property[key.name='$transaction']", message },
  // 字符串当键：const KEY = "$transaction"; prisma[KEY]。方括号里直接写的已由上一条报，类型位置上的不算
  { selector: ":not(MemberExpression, TSLiteralType) > Literal[value='$transaction']", message },
  // 模板字面量当键：prisma[`$transaction`]
  { selector: "TemplateElement[value.cooked='$transaction']", message },
];

export const txEntryRules = {
  "no-restricted-syntax": ["error", ...txEntryRestrictedSyntax],
};
