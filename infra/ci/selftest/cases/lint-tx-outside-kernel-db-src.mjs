// W0-07 的门禁：lint 禁用项（kernel 之外不得出现 $transaction）。packages/db 与 packages/services/src/testing
// 两个目录只有用例与夹具可以直接开事务，其余源码照样受管：两处各喂一例，两例都要被报出来。
// 反例不入库，从标准输入喂给 ESLint。
const PATHS = ["packages/db/src/seed.ts", "packages/services/src/testing/helper.ts"];

export default {
  gate: "lint：开事务只有 kernel 一个入口（packages/db 与测试支架里的非用例源码）",
  mutation:
    "packages/db 与 packages/services/src/testing 的非用例、非夹具源码里直接调 prisma.$transaction",
  reason: new RegExp(
    PATHS.map(
      (path) => `${path.replaceAll(".", "\\.")}\\n[^\\n]*开事务只有 kernel 的 tx\\.run 一个入口`,
    ).join("[\\s\\S]*"),
  ),
  run(ctx) {
    const results = PATHS.map((path) =>
      ctx.node("node_modules/eslint/bin/eslint.js", ["--stdin", "--stdin-filename", path], {
        input:
          "export const begin = (prisma: { $transaction: (fn: () => Promise<void>) => Promise<void> }) =>\n" +
          "  prisma.$transaction(async () => {});\n",
      }),
    );
    // 两处都被拦下才算检查失败；有一处放过去，退出码按 0 交回，这一例即告失败
    return {
      status: results.every((result) => result.status !== 0) ? 1 : 0,
      output: results.map((result) => result.output).join("\n"),
    };
  },
};
