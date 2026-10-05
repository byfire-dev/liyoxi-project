// W0-07 的门禁：lint 禁用项（kernel 之外不得出现 $transaction），不经成员访问的三种写法：
// 解构、模板字面量当键、字符串常量当键。三种各占一行，三行都要被报出来，少报一行即算原因对不上。
// 反例不入库，从标准输入喂给 ESLint。
const reported = (line) =>
  `\\n\\s+${line}:\\d+\\s+error\\s+开事务只有 kernel 的 tx\\.run 一个入口[^\\n]*no-restricted-syntax`;

export default {
  gate: "lint：开事务只有 kernel 一个入口（解构、模板字面量、字符串常量）",
  mutation: "packages/services 的业务模块里用解构、模板字面量、字符串常量三种写法取 $transaction",
  reason: new RegExp(`${reported(2)}[\\s\\S]*${reported(3)}[\\s\\S]*${reported(4)}`),
  run(ctx) {
    return ctx.node(
      "node_modules/eslint/bin/eslint.js",
      ["--stdin", "--stdin-filename", "packages/services/src/billing/pay.ts"],
      {
        input:
          "type Db = { $transaction: (fn: () => Promise<void>) => Promise<void> };\n" +
          "export const viaPattern = ({ $transaction }: Db) => $transaction;\n" +
          "export const viaTemplate = (db: Db) => db[`$transaction`];\n" +
          'export const KEY = "$transaction" as const;\n' +
          "export const viaKey = (db: Db) => db[KEY];\n",
      },
    );
  },
};
