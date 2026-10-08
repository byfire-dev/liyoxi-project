// W2-23：worker CLI 的隔离库样例。应用测试只读数据库，不在应用层造领域行。
import type { PrismaClient } from "@liyoxi/db";
import { uuidv7 } from "../kernel/index.js";
import { createClock } from "./clock.js";
import { createFactories } from "./data/index.js";

export function createFlowOpsCliSupport(prisma: PrismaClient) {
  const clock = createClock();
  return {
    make: createFactories({ db: prisma, clock }),
    alert() {
      return prisma.alertEvent.create({
        data: {
          id: uuidv7(),
          rule: "timer.failed",
          fingerprint: "timer.failed:" + uuidv7(),
          severity: "P2",
          kind: "event",
          status: "open",
          firstSeenAt: clock.now(),
          lastSeenAt: clock.now(),
        },
      });
    },
    webhook() {
      return prisma.webhookEvent.create({
        data: {
          id: uuidv7(),
          provider: "wecom",
          eventId: "fictional-cli-" + uuidv7(),
          eventType: "fictional",
          mode: "inbox",
          receivedAt: clock.now(),
          payloadDigest: Buffer.alloc(32, 0x23),
          processState: "dead",
          attempts: 8,
          error: "WEBHOOK_HANDLER_FAILED",
        },
      });
    },
  };
}
