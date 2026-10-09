import { beforeAll, afterAll, it, expect } from "vitest";
import { useSeededDatabase, createClock, assembleForTest } from "../testing/index.js";
import { defineRegistration, implement } from "../kernel/index.js";
import { DramaPricePort } from "./ports.js";
import { seedDemoContent, bindContent } from "./index.js";
import { boundContentPrices } from "./binding.js";
import { contentInvariants, findContentViolations } from "./invariants.js";
import { buildContentTest } from "./test-harness.js";
const db = useSeededDatabase("services"),
  clock = createClock();
let h: Awaited<ReturnType<typeof buildContentTest>>;
beforeAll(async () => {
  h = await buildContentTest(db, clock);
  await seedDemoContent(
    { tx: h.tx, clock, content: h.content, media: h.media, appEnv: "test" },
    h.staff.id,
  );
}, 180000);
afterAll(async () => {
  await h?.media.jobs.shutdown();
  h?.unbind();
});
it("七项已装配且演示库全通过，I3有真实登记且没有伪造恢复", async () => {
  expect(contentInvariants.map((item) => item.code)).toEqual([
    "content.I1",
    "content.I2",
    "content.I3",
    "content.I4",
    "content.I5",
    "content.I6",
    "content.I7",
  ]);
  for (const registered of contentInvariants) {
    expect(h.assembly.invariant(registered.code)).toBeDefined();
    expect(registered.heal).toBe("none");
    expect(await h.tx.run((tx) => registered.run!(tx, {}, { now: clock.now() }))).toEqual([]);
  }
});
it("I1缺等级、I2过期、I4快照、I5集号、I6植入、I7字典均发现；I2不冒充heal", async () => {
  const drama = await h.prisma.drama.findFirstOrThrow({ where: { heatTier: "S" } });
  await h.prisma.drama.update({ where: { id: drama.id }, data: { heatTier: null } });
  expect(await h.tx.run((tx) => findContentViolations(tx, "I1", clock.now()))).toEqual(
    expect.arrayContaining([expect.objectContaining({ subject: { type: "drama", id: drama.id } })]),
  );
  await h.prisma.dramaCopyright.update({
    where: { dramaId: drama.id },
    data: {
      licenseStartDate: new Date("2025-01-01T00:00:00Z"),
      licenseEndDate: new Date("2025-12-31T00:00:00Z"),
    },
  });
  for (const code of ["I2", "I4"])
    expect(await h.tx.run((tx) => findContentViolations(tx, code, clock.now()))).toHaveLength(1);
  expect((await h.prisma.drama.findUniqueOrThrow({ where: { id: drama.id } })).status).toBe(
    "listed",
  );
  await h.prisma.dramaEpisode.deleteMany({ where: { dramaId: drama.id, episodeNo: 2 } });
  expect(await h.tx.run((tx) => findContentViolations(tx, "I5", clock.now()))).toHaveLength(1);
  await h.prisma.drama.update({
    where: { id: drama.id },
    data: { allowedPlacements: ["corner"], genreCodes: ["NOT_REAL"] },
  });
  for (const code of ["I6", "I7"])
    expect(await h.tx.run((tx) => findContentViolations(tx, code, clock.now()))).toHaveLength(1);
});
it("绑定作用域恢复，未绑定显式报错", () => {
  const before = boundContentPrices(),
    replacement = { ...before },
    assembly = assembleForTest({
      entry: "worker",
      extra: [
        defineRegistration("lyxtest_content_binding", {
          portImplementations: [implement(DramaPricePort, replacement)],
        }),
      ],
    }),
    restore = bindContent(assembly);
  expect(boundContentPrices()).not.toBe(before);
  restore();
  expect(boundContentPrices()).toBe(before);
  h.unbind();
  expect(() => boundContentPrices()).toThrow("未绑定装配");
  h.unbind = bindContent(h.assembly);
});
