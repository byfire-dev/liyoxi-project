import type { Assembly } from "../kernel/index.js";
import { invariantNow } from "../kernel/index.js";
import type { ContentLicense } from "../content/index.js";
import type { DramaPricingService } from "../billing/index.js";
/** Runtime-local closures; a closed/unattached instance never falls back to another runtime. */
export function createContentPricingAssembly(base: Assembly) {
  let bound: { license: ContentLicense; pricing: DramaPricingService } | undefined,
    closed = false;
  const current = () => {
    if (closed || !bound) throw new TypeError("本版权计价运行时尚未绑定或已经关闭");
    return bound;
  };
  const timerHandlers = base.timerHandlers.map((item) =>
    item.kind === "content.license_end"
      ? {
          ...item,
          handle: (...args: Parameters<typeof item.handle>) => current().license.handle(...args),
        }
      : item.kind === "pricing.drama_price_effective"
        ? {
            ...item,
            handle: (...args: Parameters<typeof item.handle>) =>
              current().pricing.effective(...args),
          }
        : item,
  );
  const subscribers = base.subscribers.map((item) =>
    item.name === "billing.onTierChanged"
      ? {
          ...item,
          handle: (...args: Parameters<typeof item.handle>) =>
            current().pricing.onTierChanged(...args),
        }
      : item,
  );
  const invariants = base.invariants.map((item) =>
    item.code === "content.I2" || item.code === "content.I3"
      ? {
          ...item,
          modes: ["full"] as const,
          heal: "heal_and_alert" as const,
          run: (
            tx: Parameters<NonNullable<typeof item.run>>[0],
            _scope: Parameters<NonNullable<typeof item.run>>[1],
            ctx: Parameters<NonNullable<typeof item.run>>[2],
          ) =>
            current().license.check(
              tx,
              item.code === "content.I2" ? "I2" : "I3",
              invariantNow(ctx),
            ),
        }
      : item,
  );
  const assembly: Assembly = {
    ...base,
    timerHandlers,
    subscribers,
    invariants,
    timerHandler: (kind) => timerHandlers.find((v) => v.kind === kind),
    subscriber: (name) => subscribers.find((v) => v.name === name),
    invariant: (code) => invariants.find((v) => v.code === code),
  };
  return {
    assembly,
    attach(value: NonNullable<typeof bound>) {
      if (closed || bound) throw new TypeError("版权计价运行时只能绑定一次");
      bound = value;
    },
    close() {
      closed = true;
    },
  };
}
