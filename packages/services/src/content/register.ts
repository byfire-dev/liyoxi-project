import { defineRegistration, implementKeyed, implement, catalogRefPort } from "../kernel/index.js";
import { DramaPricePort, DramaUsagePort } from "./ports.js";
import { contentMachine } from "./machines.js";
import { contentFileRefs } from "./file-refs.js";
import { contentInvariants } from "./invariants.js";
export const registration = defineRegistration("content", {
  ports: [DramaPricePort, DramaUsagePort],
  subscribers: [
    {
      name: "content.onMastersChanged",
      events: ["drama.masters_changed"],
      handle: async () => {
        throw new TypeError("内容维护运行时尚未绑定");
      },
    },
    {
      name: "content.onTrailerReady",
      events: ["drama.trailer_ready"],
      handle: async () => {
        throw new TypeError("内容维护运行时尚未绑定");
      },
    },
  ],
  recurringJobs: [
    {
      kind: "content.stat_refresh",
      schedule: { every: "hour" },
      mode: "job",
      leaseSec: 120,
      maxAttempts: 3,
      deadlineMin: 60,
      missSeverity: "P2",
      catchUp: true,
      run: async () => {
        throw new TypeError("内容维护运行时尚未绑定");
      },
    },
    {
      kind: "content.archive_sweep",
      schedule: { every: "day", at: "02:30" },
      mode: "job",
      leaseSec: 120,
      maxAttempts: 3,
      deadlineMin: 120,
      missSeverity: "P2",
      catchUp: true,
      run: async () => {
        throw new TypeError("内容维护运行时尚未绑定");
      },
    },
  ],
  portImplementations: [
    implementKeyed(dictReferencesPort, "content", contentDictReferences),
    implement(catalogRefPort, contentCatalogRefs),
    implementKeyed(remindersPort, "R7", copyrightReminder),
    contentMachine,
    ...contentFileRefs,
  ],
  timerHandlers: [
    {
      kind: "content.license_end",
      handle: async () => {
        throw new TypeError("版权计价运行时尚未绑定");
      },
    },
  ],
  invariants: contentInvariants,
});

import { dictReferencesPort } from "../kernel/index.js";
import { contentDictReferences } from "./dict-references.js";

import { contentCatalogRefs } from "./catalog-refs.js";

import { remindersPort } from "../kernel/index.js";
import { copyrightReminder } from "./reminder.js";
