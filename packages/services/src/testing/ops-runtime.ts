// 跨域集成测试从测试公口使用真实运维装配，领域内测试不向上引用ops。
// 不替换runner、savepoint或写库行为；worker固定test环境，连接仍由隔离测试支架拥有。
import { buildWorkerServices, runInvariants } from "../ops/index.js";
import type { WorkerServicesOptions } from "../ops/index.js";

export function createTestWorkerServices(options: Omit<WorkerServicesOptions, "appEnv">) {
  return buildWorkerServices({ ...options, appEnv: "test" });
}

export function runTestInvariants(...args: Parameters<typeof runInvariants>) {
  return runInvariants(...args);
}
