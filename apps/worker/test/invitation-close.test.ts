import { beforeAll, expect, it, vi } from "vitest";
import { createSampleEvents, useSeededDatabase, useTestRedis } from "@liyoxi/services/testing";
import { uuidv7 } from "@liyoxi/services";
import { createHarness, SLOW } from "./support/harness.js";
import type { Harness } from "./support/harness.js";

const db = useSeededDatabase("worker", { label: "inviteclose" });
const redis = useTestRedis();
let h: Harness;
beforeAll(async () => {
  h = await createHarness(db, redis);
}, SLOW);
it(
  "真实worker先收完timer消费者再关邀请实例，重复stop不二次关闭",
  async () => {
    const one = await h.instance(),
      consumer = one.runtime.consumers.timer_run;
    const original = consumer.close.bind(consumer);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = vi.spyOn(consumer, "close").mockImplementation(async (timeout) => {
      enter();
      await gate;
      await original(timeout);
    });
    const close = vi.spyOn(one.services, "closeInvitations");
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
        tx.run((handle) =>
          one.services.assembly.timerHandler("invitation.expire")!.handle(handle, {
            id: uuidv7(),
            kind: "invitation.expire",
            subjectType: "invitation",
            subjectId: uuidv7(),
            payload: null,
          }),
        ),
      ).rejects.toThrow("已经关闭");
    } finally {
      release();
      await stopping;
      held.mockRestore();
      close.mockRestore();
    }
  },
  SLOW,
);
