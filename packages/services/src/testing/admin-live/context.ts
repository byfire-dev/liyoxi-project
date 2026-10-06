import type { Runtime } from "../../runtime.js";
import type { createFactories } from "../data/factories/index.js";

/** 后台页面的真实接口造数：所有登记文件在同一进程里共享工厂序号和测试密钥。 */
export interface AdminLiveFixtureContext {
  runtime: Runtime;
  make: ReturnType<typeof createFactories>;
}
export type AdminLiveFixture = (context: AdminLiveFixtureContext) => Promise<unknown>;
