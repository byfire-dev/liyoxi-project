// 本机假 pnpm 子进程验证运行器失败行为，不跑业务链或连接库。
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";

export default {
  gate: "M1 连续验收的任意失败必须红",
  mutation: "第一轮退出 7；若偷偷重试，后面假程序会成功",
  reason: /M1 连续运行未通过：1\/10 轮已尝试，成功 0，失败 1，未执行 9/,
  run(ctx) {
    const workflow = readFileSync(join(ctx.repoRoot, ".github/workflows/e2e-repeat.yml"), "utf8");
    const command = workflow.match(/^ {8}run: (node infra\/ci\/e2e-repeat\.mjs --times 10)$/m)?.[1];
    if (!command) throw new Error("main 手动验收缺少真实连续命令");
    const dir = ctx.tempDir();
    ctx.writeFiles(dir, {
      "bin/pnpm": [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const file = process.env.LYX_REPEAT_FIXTURE_COUNT;",
        "const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;",
        "fs.writeFileSync(file, String(count + 1));",
        "process.stdout.write('本机运行器反例，无业务库\\n');",
        "process.exit(count === 0 ? 7 : 0);",
      ].join("\n"),
    });
    chmodSync(join(dir, "bin/pnpm"), 0o755);
    const [tool, ...args] = command.split(" ");
    return ctx.run(tool, [...args, "--out", join(dir, "artifacts")], {
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        LYX_REPEAT_FIXTURE_COUNT: join(dir, "count"),
      },
    });
  },
};
