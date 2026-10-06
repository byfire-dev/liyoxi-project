import { defineRegistration } from "../kernel/index.js";
import { fileCategoryGuardPort, fileRefTypePort } from "./ports.js";
import { findI2Violations, findI14Violations } from "./invariants.js";
export const registration = defineRegistration("media", {
  ports: [fileRefTypePort, fileCategoryGuardPort],
  invariants: [
    {
      code: "media.I2",
      severity: "P2",
      modes: ["full"],
      heal: "none",
      run: (tx) => findI2Violations(tx),
    },
    {
      code: "media.I14",
      severity: "P2",
      modes: ["full"],
      every: "week",
      heal: "none",
      run: (tx) => findI14Violations(tx),
    },
  ],
});
