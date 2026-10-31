import { AppError } from "../kernel/index.js";
import type { Assembly, Tx } from "../kernel/index.js";
import { readMaterialFileFacts } from "../media/index.js";
import { createLicenseFacts } from "../delivery/index.js";
import {
  lockOrderLicenseItems,
  readOrderLicenseFacts,
  listLicenseCandidateItemIds,
  readLicenseOrderItemIds,
} from "../order/index.js";
import { readLicenseAccounts } from "../publish/index.js";
import { readLicenseScope } from "../content/index.js";
import { readLicenseeFacts } from "../tenant/index.js";
import { paramsAt } from "../config/index.js";
import { decryptField } from "../security/index.js";
import type { Keyring } from "../security/index.js";
import {
  findN6Violations,
  findN16Violations,
  reconcileLetters,
  ensureLetters,
} from "../docs/index.js";
import type { LicenseConvergenceDeps } from "../docs/index.js";

export function createRuntimeDocsLicense(
  deps: Pick<LicenseConvergenceDeps, "clock" | "flow" | "events"> & {
    portalOrigin?: string;
    keyring: () => Keyring;
  },
): LicenseConvergenceDeps {
  return {
    clock: deps.clock,
    flow: deps.flow,
    events: deps.events,
    readFiles: readMaterialFileFacts,
    facts: createLicenseFacts({
      lockItems: lockOrderLicenseItems,
      readItems: readOrderLicenseFacts,
      readAccounts: readLicenseAccounts,
      listCandidateIds: listLicenseCandidateItemIds,
      orderItemIds: readLicenseOrderItemIds,
    }),
    snapshot: {
      portalOrigin: deps.portalOrigin,
      async licensor(tx, at) {
        const value = (await paramsAt(tx, ["platform.legal_entity"], at))["platform.legal_entity"];
        if (!value)
          throw new AppError("PRECONDITION_CHANGED", { message: "授权快照缺少平台法定主体" });
        return { name: value.name, creditCode: value.creditCode };
      },
      async licensee(tx, input) {
        const value = await readLicenseeFacts(tx, input);
        return {
          name: value.name,
          store: value.store,
          creditCode: decryptField(deps.keyring(), "entity.uscc_enc", value.usccEnc),
        };
      },
      scope: readLicenseScope,
    },
  };
}

/** Every runtime owns its handlers and pending work. No module-wide binding stack is consulted. */
export function createDocsLicenseAssembly(base: Assembly) {
  let deps: LicenseConvergenceDeps | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const assertOpen = () => {
    if (closed || !deps) throw new TypeError("授权事实运行时尚未绑定或已经关闭");
  };
  const current = () => {
    assertOpen();
    return { ...deps!, assertOpen };
  };
  const run = <T>(operation: (value: LicenseConvergenceDeps) => Promise<T>): Promise<T> => {
    const value = current();
    const active = operation(value).then((result) => {
      assertOpen();
      return result;
    });
    pending.add(active);
    void active.finally(() => pending.delete(active)).catch(() => undefined);
    return active;
  };
  const subscribers = base.subscribers.map((item) =>
    item.name === "docs.onLicenseFacts"
      ? {
          ...item,
          handle: (tx: Tx, event: Parameters<typeof item.handle>[1]) =>
            run(async (value) => {
              const ids = await value.facts.eventItemIds(tx, event);
              assertOpen();
              await reconcileLetters(tx, value, ids, event.id);
            }),
        }
      : item,
  );
  const invariants = base.invariants.map((item) =>
    item.code === "docs.N6" || item.code === "docs.N16"
      ? {
          ...item,
          run: (tx: Tx, scope: Parameters<NonNullable<typeof item.run>>[1]) =>
            run((value) =>
              item.code === "docs.N6"
                ? findN6Violations(tx, value, scope)
                : findN16Violations(tx, value, scope),
            ),
        }
      : item,
  );
  const subscriberIndex = new Map(subscribers.map((item) => [item.name, item]));
  const invariantIndex = new Map(invariants.map((item) => [item.code, item]));
  return {
    assembly: {
      ...base,
      subscribers,
      invariants,
      subscriber: (name: string) => subscriberIndex.get(name),
      invariant: (code: string) => invariantIndex.get(code),
    },
    attach(value: LicenseConvergenceDeps) {
      if (closed || deps) throw new TypeError("授权事实运行时只能绑定一次");
      deps = value;
    },
    reconcileLetters: (tx: Tx, ids: readonly string[], triggerRef: string) =>
      run((value) => reconcileLetters(tx, value, ids, triggerRef)),
    ensureLetters: (tx: Tx, ids: readonly string[], triggerRef: string) =>
      run((value) => ensureLetters(tx, value, ids, triggerRef)),
    close() {
      closed = true;
      return (closing ??= Promise.allSettled([...pending]).then(() => {
        deps = undefined;
      }));
    },
  };
}
