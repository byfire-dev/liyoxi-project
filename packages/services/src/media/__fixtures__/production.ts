import type { PrismaClient } from "@liyoxi/db";
import { createTxRunner, createIdentityContext } from "../../kernel/index.js";
import { createEvents } from "../../events/index.js";
import { createMedia } from "../index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
} from "../../testing/index.js";
export function harness(prisma: PrismaClient) {
  const clock = createClock(),
    tx = createTxRunner({ prisma, appEnv: "test" }),
    assembly = assembleForTest({ entry: "api" }),
    make = createFactories({ db: prisma, clock }),
    fake = createFakeProviders({ clock }),
    events = createEvents({ tx, clock, assembly }),
    media = createMedia({ tx, clock, assembly, events, storage: fake.storage });
  return {
    prisma,
    clock,
    tx,
    assembly,
    make,
    deps: { clock, events, media },
    unbind: () => {},
    staff: async () => ({ row: await make.staff() }),
    order: async (_hasManager: boolean) => {
      const user = await make.merchantUser(),
        entity = await make.entity({ createdByUserId: user.id }),
        store = await make.store({ entityId: entity.id }),
        order = await make.dramaOrder({
          entityId: entity.id,
          storeId: store.id,
          status: "producing",
        }),
        item = await make.orderItem({ dramaOrderId: order.id, phase: "producing" });
      return {
        user,
        entity,
        store,
        order,
        items: [item],
        viewer: {
          ctx: createIdentityContext({
            actor: { type: "merchant", id: user.id, client: "weapp", role: "owner" },
            entityId: entity.id,
            storeId: store.id,
          }),
        },
      };
    },
  };
}
export type Harness = ReturnType<typeof harness>;
