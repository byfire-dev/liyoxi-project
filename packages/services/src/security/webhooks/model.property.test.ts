import fc from "fast-check";
import { it, expect } from "vitest";
import { createSampleEvents, sampleSystemContext, useTestDatabase } from "../../testing/index.js";
import { createWebhooks } from "../index.js";
import { count, prepare, source, write } from "./__fixtures__/source.js";
const db = useTestDatabase("services");
it("固定种子20261007：重复/乱序与写后故障符合纯模型，领域事实至多一份", async () => {
  const prisma = await db.prisma(),
    sample = createSampleEvents(prisma);
  let failing = false,
    run = 0;
  const hooks = createWebhooks({
    ...sample,
    sources: [
      source("WP", {
        mode: "inline",
        handle: async (tx) => {
          await write(tx, "WP");
          if (failing) throw new Error("fixture failure after domain write");
          return "processed";
        },
      }),
    ],
  });
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.record({ key: fc.integer({ min: 0, max: 3 }), fail: fc.boolean() }), {
        minLength: 4,
        maxLength: 20,
      }),
      async (actions) => {
        run++;
        const accepted = new Set<number>(),
          prefix = `property-${run}-`,
          before = await count(prisma, "WP");
        for (const action of actions) {
          failing = action.fail;
          const success = accepted.has(action.key) || !action.fail;
          const response = await hooks.accept(
            await prepare(hooks, prefix + action.key),
            sampleSystemContext(),
          );
          expect(response.status).toBe(success ? 200 : 500);
          if (success) accepted.add(action.key);
          expect(await count(prisma, "WP")).toBe(before + accepted.size);
        }
        expect(
          await prisma.webhookEvent.count({ where: { eventId: { startsWith: prefix } } }),
        ).toBe(accepted.size);
        expect(
          await prisma.webhookEvent.count({
            where: { eventId: { startsWith: prefix }, processState: { not: "processed" } },
          }),
        ).toBe(0);
      },
    ),
    { numRuns: 100, seed: 20261007 },
  );
}, 120_000);
