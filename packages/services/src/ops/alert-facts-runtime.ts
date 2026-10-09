import { alertsPort } from "../kernel/index.js";
import type { Assembly, Port } from "../kernel/index.js";
import { createAlertFacts, unboundAlertFacts } from "./alert-facts.js";
import type { AlertFactsDeps } from "./alert-facts.js";

/** 仅替换告警端口；其他登记项、数组与索引保持所属运行时的原对象。 */
export function createAlertFactsAssembly(base: Assembly, deps: AlertFactsDeps) {
  const slot = base.portImplementations.find((item) => item.port === alertsPort);
  if (slot?.impl !== unboundAlertFacts)
    return { assembly: base, close: async (): Promise<void> => {} };
  const facts = createAlertFacts(deps);
  const portImplementations = base.portImplementations.map((item) =>
    item.port === alertsPort ? { ...item, impl: facts } : item,
  );
  const assembly: Assembly = {
    ...base,
    portImplementations,
    port<T>(port: Port<T>): T {
      return port === alertsPort ? (facts as T) : base.port(port);
    },
  };
  return { assembly, close: () => facts.close() };
}
