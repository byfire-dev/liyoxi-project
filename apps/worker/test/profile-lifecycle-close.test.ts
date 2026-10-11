import { beforeAll, expect, it, vi } from "vitest";
import { createSampleEvents, useSeededDatabase, useTestRedis } from "@liyoxi/services/testing";
import { createHarness, SLOW } from "./support/harness.js";
import type { Harness } from "./support/harness.js";

const db = useSeededDatabase("worker", { label: "profclose" });
const redis = useTestRedis();
let h: Harness;
beforeAll(async () => {
  h = await createHarness(db, redis);
}, SLOW);

it(
  "真实worker收完outbox消费者才关闭profile生命周期实例，重复stop只关闭一次",
  async () => {
    const one = await h.instance();
    const consumer = one.runtime.consumers.outbox_delivery;
    const original = consumer.close.bind(consumer);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldClose = vi.spyOn(consumer, "close").mockImplementation(async (timeout) => {
      enter();
      await gate;
      await original(timeout);
    });
    const close = vi.spyOn(one.services, "closeProfile");
    const stopping = one.runtime.stop();
    try {
      await entered;
      expect(close).not.toHaveBeenCalled();
      release();
      await stopping;
      expect(close).toHaveBeenCalledOnce();
      await one.runtime.stop();
      expect(close).toHaveBeenCalledOnce();
      const { tx } = createSampleEvents(h.prisma);
      await expect(
        tx.run((t) =>
          one.services.assembly.subscriber("profile.onTenantLifecycle")!.handle(t, {
            id: "00000000-0000-4000-8000-000000000001",
            type: "store.restored",
            payload: {},
          }),
        ),
      ).rejects.toThrow("已经关闭");
    } finally {
      release();
      await stopping;
      heldClose.mockRestore();
      close.mockRestore();
    }
  },
  SLOW,
);
