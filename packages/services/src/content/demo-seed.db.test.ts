import { beforeAll, afterAll, it, expect } from "vitest";
import { useSeededDatabase, createClock } from "../testing/index.js";
import { createIdentityContext } from "../kernel/index.js";
import { seedDemoContent } from "./index.js";
import { dramaFacts, evaluateListing } from "./checks.js";
import { findContentViolations } from "./invariants.js";
import { DramaPricePort } from "./ports.js";
import { buildContentTest } from "./test-harness.js";
const db = useSeededDatabase("services"),
  clock = createClock();
let h: Awaited<ReturnType<typeof buildContentTest>>;
beforeAll(async () => {
  h = await buildContentTest(db, clock);
}, 180000);
afterAll(() => h?.unbind());
it(
  "真实服务种子两次：3上架、版权修订/引用/状态历史/审计/事件恰好一次、不变量全过",
  { timeout: 180000 },
  async () => {
    const deps = { tx: h.tx, clock, content: h.content, media: h.media, appEnv: "test" as const };
    const first = await seedDemoContent(deps, h.staff.id);
    expect(first.find((row) => row.table === "drama")?.inserted).toBe(3);
    expect((await seedDemoContent(deps, h.staff.id)).every((row) => row.inserted === 0)).toBe(true);
    const dramas = await h.prisma.drama.findMany({ orderBy: { heatTier: "asc" } });
    expect(dramas).toHaveLength(3);
    const ids = dramas.map((row) => row.id);
    expect(
      await h.prisma.statusTransition.count({
        where: { machine: "drama", subjectId: { in: ids } },
      }),
    ).toBe(6);
    expect(
      await h.prisma.auditLog.count({
        where: {
          targetType: "drama",
          targetId: { in: ids },
          action: { in: ["content.drama.create", "content.drama.list"] },
        },
      }),
    ).toBe(6);
    expect(
      await h.prisma.outboxEvent.count({
        where: { eventType: "drama.listed", aggregateId: { in: ids } },
      }),
    ).toBe(3);
    expect(await h.prisma.dramaCopyrightRevision.count({ where: { dramaId: { in: ids } } })).toBe(
      3,
    );
    const transitions = await h.prisma.statusTransition.findMany({
      where: { machine: "drama", subjectId: { in: ids }, toState: "listed" },
    });
    for (const history of transitions)
      expect(history.payload).toEqual({
        passed: true,
        total: 14,
        items: Array.from({ length: 14 }, (_, index) => ({
          code: `L${index + 1}`,
          severity: [5, 7, 12, 13].includes(index) ? "hint" : "block",
          ok: index !== 5,
        })),
      });
    for (const row of dramas) {
      expect(row.firstListedAt).toEqual(row.listedAt);
      expect(row.listedAt).toEqual(row.statusChangedAt);
      await expect(
        h.tx.run((tx) =>
          h.content.list(
            tx,
            createIdentityContext({ actor: { type: "staff", id: h.staff.id, client: "admin" } }),
            row.id,
          ),
        ),
      ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    }
    for (const code of ["I1", "I2", "I4", "I5", "I6", "I7"])
      expect(await h.tx.run((tx) => findContentViolations(tx, code, clock.now())), code).toEqual(
        [],
      );
    const catalog = await h.tx.run((tx) => h.content.visibleCatalog(tx, clock.now()));
    expect(catalog).toHaveLength(3);
    expect(catalog.every((row) => row.listPricePoints !== null)).toBe(true);
  },
);
it("L1–L14 各条件与严重度；草稿上架失败指出阻断项且不写迁移", async () => {
  const drama = await h.prisma.drama.findFirstOrThrow();
  const facts = await h.tx.run((tx) => dramaFacts(tx, drama.id));
  const options = {
    at: clock.now(),
    priceAvailable: true,
    minLicenseMonths: 3,
    openSlots: ["opening", "ending"],
    trailerBlocking: false,
    media: { mastersReady: true, trailerReady: true },
  };
  const base = evaluateListing(facts, options);
  expect(base.items.every((row) => row.isOk)).toBe(true);
  const broken = [
    { drama: { dramaClass: null } },
    { copyright: { source: null } },
    { copyright: { canAdapt: false } },
    { copyright: { hasNetworkRight: false } },
    { drama: { heatTier: null } },
    null,
    { copyright: { licenseEndDate: new Date("2025-01-01Z") } },
    { copyright: { licenseEndDate: new Date("2026-02-01Z") } },
    { drama: { synopsis: null } },
    { episodes: [] },
    { drama: { allowedPlacements: [] } },
    { drama: { isPermitRecheckRequired: true } },
    { drama: { industryCodes: [] } },
    { permits: [] },
  ];
  broken.forEach((mutation, index) => {
    const f = structuredClone(facts);
    if (mutation) {
      if (mutation.drama) Object.assign(f.drama, mutation.drama);
      if (mutation.copyright) Object.assign(f.copyright!, mutation.copyright);
      if (mutation.episodes) f.episodes = mutation.episodes;
      if (mutation.permits) f.permits = mutation.permits;
    }
    const result = evaluateListing(f, {
      ...options,
      trailerBlocking: index === 5,
      media: { mastersReady: true, trailerReady: index !== 5 },
    });
    expect(result.items[index]?.isOk, `L${index + 1}`).toBe(false);
    if (index === 5) expect(result.isShelvable).toBe(false);
  });
  const hintFacts = structuredClone(facts);
  hintFacts.drama.industryCodes = [];
  expect(evaluateListing(hintFacts, options).isShelvable).toBe(true);
  const prices = await h.tx.run((tx) =>
    h.assembly.port(DramaPricePort).priceAt(tx, [drama.id], clock.now()),
  );
  expect(prices.get(drama.id)).toMatchObject({
    source: { mode: "template", tier: drama.heatTier },
  });
  expect(
    await h.tx.run((tx) => h.assembly.port(DramaPricePort).minLicenseMonths(tx, clock.now())),
  ).toBe(3);
  const ctx = createIdentityContext({ actor: { type: "staff", id: h.staff.id, client: "admin" } }),
    draft = await h.tx.run((tx) => h.content.createDraft(tx, ctx, { title: "校验失败草稿" }));
  await expect(h.tx.run((tx) => h.content.list(tx, ctx, draft.id))).rejects.toMatchObject({
    error: "LISTING_CHECK_FAILED",
    details: { failed: expect.arrayContaining([{ code: "L1", note: expect.any(String) }]) },
  });
  expect(
    await h.prisma.statusTransition.count({ where: { machine: "drama", subjectId: draft.id } }),
  ).toBe(1);
});
