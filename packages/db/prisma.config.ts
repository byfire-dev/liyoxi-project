// Prisma 的配置（W0-05）。连接串只取环境变量 DATABASE_URL：不读 .env，没有默认值。
// validate、generate、format 不连库，可以不给；其余命令（migrate deploy 等）缺了就报错。
// 本地的取值写法见 CLAUDE.md 第 9 节；怎么用见本目录的 README.md。
import { defineConfig } from "prisma/config";

const url = process.env.DATABASE_URL;
const offline = process.argv.some((arg) => ["validate", "generate", "format"].includes(arg));
if (!url && !offline) {
  throw new Error("DATABASE_URL 未设置：连接串只取这个环境变量，不读 .env，也没有默认值");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  ...(url ? { datasource: { url } } : {}),
});
