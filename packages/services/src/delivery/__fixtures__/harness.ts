// Keep existing delivery tests on the same shared real fixture.
export {
  createDeliveryFixture as harness,
  deliveryDraftForTest as draft,
} from "../../testing/index.js";
export type { DeliveryFixtureHarness as Harness } from "../../testing/index.js";
