// W0-07 复审后补的配置排在 W0-07b 的“不得 new PrismaClient”之后：同一条 ESLint 规则，后写的整条盖掉前面的。
// 测试支架里的非用例源码两样都要拦：这一例喂一份同时 new PrismaClient、调 $transaction 的源码，两条都要报出来，
// 少报一条就是装配时把另一组条目盖掉了。反例不入库，从标准输入喂给 ESLint。
export default {
  gate: "lint：测试支架的非用例源码，事务入口与客户端构造两组条目都在",
  mutation: "packages/services/src/testing 的非用例源码里 new PrismaClient，并直接调 $transaction",
  reason:
    /\n\s+2:\d+\s+error\s+Prisma 客户端只由 createPrismaClient 构造[^\n]*no-restricted-syntax[\s\S]*\n\s+3:\d+\s+error\s+开事务只有 kernel 的 tx\.run 一个入口[^\n]*no-restricted-syntax/,
  run(ctx) {
    return ctx.node(
      "node_modules/eslint/bin/eslint.js",
      ["--stdin", "--stdin-filename", "packages/services/src/testing/helper.ts"],
      {
        input:
          'import { PrismaClient } from "@liyoxi/db";\n' +
          "export const open = () => new PrismaClient();\n" +
          "export const begin = (prisma: PrismaClient) => prisma.$transaction(async () => {});\n",
      },
    );
  },
};
