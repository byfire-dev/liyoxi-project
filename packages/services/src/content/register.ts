import { defineRegistration, implementKeyed, implement, catalogRefPort } from "../kernel/index.js";
import { DramaPricePort } from "./ports.js";
import { contentMachine } from "./machines.js";
import { contentFileRefs } from "./file-refs.js";
import { contentInvariants } from "./invariants.js";
export const registration = defineRegistration("content", {
  ports: [DramaPricePort],
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
