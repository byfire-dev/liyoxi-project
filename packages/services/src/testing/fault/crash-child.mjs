// 进程中断工具的子进程入口（W0-05b）：由 crash.ts 的 runUntilCrash 用 fork 起，不单独运行。
// 场景模块可能是 TypeScript、会引工作区的包：用 Vite 加载它（Vitest 带的那一份，与加载测试文件同一套办法）。
// 场景函数正常跑完：退出码 0。抛错：打印后退出码 1。到指定断点：停在 crashPoint 里等父进程的 SIGKILL。
import { fileURLToPath } from "node:url";

import { createViteServer } from "vitest/node";

const spec = JSON.parse(process.env.LYX_CRASH_SPEC ?? "null");
if (!spec || typeof process.send !== "function") {
  console.error("crash-child.mjs 只由 runUntilCrash 起，不单独运行");
  process.exit(2);
}

// 父进程没了（用例超时、worker 被杀）就跟着退出：不留一个连着数据库的孤儿进程
process.on("disconnect", () => process.exit(1));

const server = await createViteServer({
  configFile: false,
  root: fileURLToPath(new URL("../../../", import.meta.url)),
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
let code = 0;
try {
  const loaded = await server.ssrLoadModule(spec.module);
  const scenario = loaded[spec.exportName];
  if (typeof scenario !== "function") {
    throw new Error(`场景模块没有导出函数 ${spec.exportName}`);
  }
  await scenario(spec.payload);
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  await server.close();
}
process.exit(code);
