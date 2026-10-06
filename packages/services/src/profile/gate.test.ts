import { beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
describe("storeGate", () => {
  it.each([
    ["unsubmitted", true, "blocked"],
    ["pending", true, "parallel"],
    ["verified", true, "full"],
    ["rejected", true, "blocked"],
    ["pending", false, "blocked"],
  ])("%s primary=%s → %s", async (qualificationStatus, isPrimary, expected) => {
    const store = await h.make.store({
      qualificationStatus: String(qualificationStatus),
      isPrimary: Boolean(isPrimary),
    });
    expect(await h.profile.storeGate(store.id)).toBe(expected);
  });
});
it("齐全断言仅前三步；资质、联系人与声明不影响订购建档检查", async () => {
  const { viewer } = await h.owner();
  const { complete } = await import("./__fixtures__/harness.js");
  await complete(h, viewer);
  await h.prisma.storeProfile.update({
    where: { storeId: viewer.membership.storeId },
    data: { contactName: null },
  });
  await expect(h.profile.assertProfileComplete(viewer.membership.storeId)).resolves.toBeUndefined();
  await h.prisma.storeProfile.update({
    where: { storeId: viewer.membership.storeId },
    data: { brandName: null },
  });
  await expect(h.profile.assertProfileComplete(viewer.membership.storeId)).rejects.toMatchObject({
    error: "STORE_PROFILE_INCOMPLETE",
    details: { missing: [{ step: 1, item: "brand_name", permitType: null }] },
  });
});
