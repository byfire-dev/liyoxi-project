import {
  implementKeyed as notifyReaderImplementation,
  notifyReadPort as currentNotifyReadPort,
} from "../kernel/index.js";
import { assetForNotify } from "./notify-facts.js";
import { defineRegistration, implementKeyed, invariantNow } from "../kernel/index.js";
import { fileCategoryGuardPort, fileRefTypePort } from "./ports.js";
import { findI2Violations, findI14Violations } from "./invariants.js";
import { mediaDeliveryRefTypes } from "./production-stub.js";
const unboundMediaJobs = (): never => {
  throw new Error("媒体执行器未绑定实际运行时");
};
import { findI10Violations, findI11Violations } from "./jobs/invariants.js";
export const registration = defineRegistration("media", {
  ports: [fileRefTypePort, fileCategoryGuardPort],
  portImplementations: [
    notifyReaderImplementation(currentNotifyReadPort, "assetForNotify", assetForNotify),

    implementKeyed(fileRefTypePort, "playable_asset", mediaDeliveryRefTypes.playable_asset),
    implementKeyed(fileRefTypePort, "upload_batch", mediaDeliveryRefTypes.upload_batch),
  ],
  invariants: [
    {
      code: "media.I10",
      severity: "P2",
      modes: ["quick", "full"],
      heal: "heal_only",
      run: (tx, scope, ctx) => findI10Violations(tx, scope, invariantNow(ctx), unboundMediaJobs),
    },
    {
      code: "media.I11",
      severity: "P2",
      modes: ["quick", "full"],
      heal: "heal_only",
      run: (tx, scope, ctx) => findI11Violations(tx, scope, invariantNow(ctx), unboundMediaJobs),
    },
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
