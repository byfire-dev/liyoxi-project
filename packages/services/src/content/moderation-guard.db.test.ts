import { expect, it } from "vitest";
import { createTxRunner } from "../kernel/index.js";
import { createClock, createFactories, useSeededDatabase } from "../testing/index.js";
import { dramaFacts, evaluateListing } from "./checks.js";
const handle = useSeededDatabase("services");
it("blocked public poster fails the actual listing L9 guard", async () => {
  const db = await handle.prisma(),
    clock = createClock(),
    make = createFactories({ db, clock }),
    tx = createTxRunner({ prisma: db, appEnv: "test" });
  const poster = await make.fileObject({ moderationState: "block" }),
    drama = await make.drama({ posterFileId: poster.id });
  const facts = await tx.run((tx) => dramaFacts(tx, drama.id));
  const result = evaluateListing(facts, {
    at: clock.now(),
    priceAvailable: true,
    minLicenseMonths: 1,
    openSlots: ["opening", "ending"],
    trailerBlocking: false,
  });
  expect(result.items.find((item) => item.code === "L9")).toMatchObject({
    isOk: false,
    severity: "block",
  });
});
