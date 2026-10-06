import type { Config } from "../config/index.js";
import type { Docs } from "../docs/index.js";
import type { Assembly, Clock, TxRunner } from "../kernel/index.js";
import type { Tenant } from "../tenant/index.js";

/** 读侧不依赖登录 Provider 与密钥；独立文件避免装配入口与用例类型成环。 */
export interface IdentityReadDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly assembly: Pick<Assembly, "port" | "portEntries">;
  readonly docs: Docs;
  readonly tenant: Tenant;
  readonly config: Pick<Config, "params" | "flags" | "dicts" | "siteConfig">;
}
