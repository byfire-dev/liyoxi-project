// Compatibility for existing order tests; shared fixtures cross the public testing boundary.
export {
  createOrderBaseFixture as harness,
  createOrderFixtureBuyer as buyer,
  createOrderFixtureBody as body,
  readOrderFixtureResidual as residual,
  prepareOrderProfile as profile,
  prepareOrderDrama as drama,
  prepareOrderAgreement as version,
} from "../../testing/index.js";
export type { OrderBaseFixtureHarness as Harness } from "../../testing/index.js";
