import type { PrismaClient } from "@liyoxi/db";
import type { TxRunner } from "../../kernel/index.js";
import { createIdentityContext, createTxRunner, uuidv7 } from "../../kernel/index.js";
import { loadCliStaffContext } from "../../staff/index.js";
import { createFactories, createClock } from "../../testing/index.js";
import { createFlowOps } from "../flow-ops.js";
export function fixture(prisma: PrismaClient) {
  const clock = createClock(),
    tx = createTxRunner({ prisma, appEnv: "test" }),
    make = createFactories({ db: prisma, clock });
  const ops = createFlowOps({ tx, clock });
  return {
    clock,
    tx,
    make,
    ops,
    async actor(role: "super_admin" | "finance" | "editor" = "super_admin") {
      const employee = await make.staff({ staffRoleKey: role });
      const staff = await tx.run((t) => loadCliStaffContext(t, employee.id));
      return {
        staff,
        identity: createIdentityContext({
          actor: { type: "staff", id: employee.id, client: "admin" },
        }),
        meta: { requestId: null, ip: null, userAgent: null, authMethod: null, sessionId: null },
      };
    },
    timer(data: Partial<Parameters<PrismaClient["timer"]["create"]>[0]["data"]> = {}) {
      return prisma.timer.create({
        data: {
          id: uuidv7(),
          kind: "ops.retention",
          fireAt: clock.now(),
          dedupeKey: "ops.retention:" + uuidv7(),
          status: "failed",
          attempts: 6,
          dispatchNo: 6,
          ...data,
        },
      });
    },
    async delivery(subscriber = "support.onBizEvent") {
      const event = await prisma.outboxEvent.create({
        data: {
          id: uuidv7(),
          eventType: "service_ticket.created",
          aggregateType: "service_ticket",
          aggregateId: uuidv7(),
          actorType: "system",
          payload: { v: 1 },
          occurredAt: clock.now(),
        },
      });
      const row = await prisma.outboxDelivery.create({
        data: { outboxEventId: event.id, subscriber, status: "dead", attempts: 10, dispatchNo: 10 },
      });
      return { event, row };
    },
    webhook(data: Partial<Parameters<PrismaClient["webhookEvent"]["create"]>[0]["data"]> = {}) {
      return prisma.webhookEvent.create({
        data: {
          id: uuidv7(),
          provider: "wecom",
          eventId: "fictional-" + uuidv7(),
          eventType: "fictional",
          mode: "inbox",
          receivedAt: clock.now(),
          payloadDigest: Buffer.alloc(32, 0x23),
          processState: "dead",
          attempts: 8,
          error: "WEBHOOK_HANDLER_FAILED",
          ...data,
        },
      });
    },
  };
}

// 只覆盖本次真实事务句柄的审计 INSERT；原角色、锁、目标 UPDATE 与 rollback 都照常执行。
export function failingAuditTx(source: TxRunner): TxRunner {
  return {
    run(fn, options) {
      return source.run(async (tx) => {
        const query = tx.$queryRawUnsafe.bind(tx);
        tx.$queryRawUnsafe = <T = unknown>(sql: string, ...values: unknown[]) => {
          if (/^INSERT INTO audit_log\b/.test(sql)) throw new Error("fictional audit failure");
          return query<T>(sql, ...values);
        };
        return fn(tx);
      }, options);
    },
  };
}
