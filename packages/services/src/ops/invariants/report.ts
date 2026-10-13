// 违规上报复用同一writeViolations；实际API/worker端口捕获所属实例，旧静态调用保留全局入口。
// profile在业务提交后调用独立短事务；kernel invariantsOf保证端口故障不覆盖业务结果。
import { invariantsPort } from "../../kernel/index.js";
import type { Assembly, InvariantReport, Invariants, Port } from "../../kernel/index.js";
import { requireOps } from "../binding.js";
import type { OpsBinding } from "../binding.js";
import { writeViolations } from "./store.js";

type Reporting = Pick<OpsBinding, "db" | "clock" | "assembly">;
async function writeReport(ops: Reporting, input: InvariantReport): Promise<void> {
  await writeViolations(
    ops.db,
    {
      runId: null,
      code: input.code,
      module: input.module,
      severity: input.severity,
      heal: ops.assembly.invariant(input.code)?.heal ?? "none",
      now: ops.clock.now(),
    },
    [
      {
        detail: input.detail,
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.entityId === undefined ? {} : { entityId: input.entityId }),
        ...(input.healed === undefined ? {} : { healed: input.healed }),
      },
    ],
  );
}
export const reportingInvariants: Invariants = {
  report: (input) => writeReport(requireOps("invariants.report"), input),
};

/** 只替换正式report实现，保留样例/自定义port；writer、策略及SQL沿原不变量模块。 */
export function createInvariantReportingAssembly(
  base: Assembly,
  deps: Pick<Reporting, "db" | "clock">,
): Assembly {
  const slot = base.portImplementations.find((item) => item.port === invariantsPort);
  if (slot?.impl !== reportingInvariants) return base;
  const reporting: Invariants = {
    report: (input) => writeReport({ ...deps, assembly: base }, input),
  };
  return {
    ...base,
    portImplementations: base.portImplementations.map((item) =>
      item === slot ? { ...item, impl: reporting } : item,
    ),
    port<T>(port: Port<T>): T {
      return port === invariantsPort ? (reporting as T) : base.port(port);
    },
  };
}
