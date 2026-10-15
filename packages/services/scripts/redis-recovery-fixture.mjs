// 仅由 rehearse --redis-flush 打成一个临时 bundle，在本次自有 worker 一次性容器中执行。
// 不接收 SQL/业务参数，不造 outbox 行，不改生产周期；服务写入提交后才独立持锁跨过 flush。
import { createInterface } from "node:readline";
import { createPrismaClient } from "../../db/src/index.ts";
import { assembleServices } from "../src/assembly.ts";
import {
  createIdentityContext,
  createTxRunner,
  loadEnv,
  systemClock,
} from "../src/kernel/index.ts";
import { createEvents } from "../src/events/index.ts";
import { createCalendarAdmin } from "../src/sla/index.ts";
import { loadCliStaffContext } from "../src/staff/index.ts";
import {
  armRecurringSlot,
  createTimers,
  recurringKey,
  slotAtOrBefore,
} from "../src/timers/index.ts";

let stage = "identity";
async function main() {
  const [project, postgresAddress] = process.argv.slice(2);
  if (
    process.argv.length !== 4 ||
    !/^lyxrh-[a-f0-9]{6}$/.test(project ?? "") ||
    !/^172\.30\.(4[2-9]|5[0-7])\.\d{1,3}$/.test(postgresAddress ?? "")
  )
    throw new Error("fixture identity");
  stage = "environment";
  const env = loadEnv();
  const url = new URL(env.DATABASE_URL);
  if (env.APP_ENV !== "stg" || url.hostname !== "postgres" || url.pathname !== "/liyoxi")
    throw new Error("fixture environment");
  const db = createPrismaClient({ connectionString: env.DATABASE_URL, max: 2 });
  try {
    stage = "database";
    const [database] = await db.$queryRawUnsafe(
      "SELECT current_database() AS name, host(inet_server_addr()) AS address",
    );
    if (database?.name !== "liyoxi" || database.address !== postgresAddress)
      throw new Error("fixture database");
    stage = "assembly";
    const tx = createTxRunner({ prisma: db, appEnv: "stg" });
    const assembly = assembleServices({ entry: "worker", appEnv: "stg" });
    const events = createEvents({ assembly, tx, clock: systemClock });
    const calendar = createCalendarAdmin({ tx, clock: systemClock, events });
    const timers = createTimers({ assembly });
    stage = "actor";
    const staff = await tx.run(async (handle) => {
      const row = await handle.staff.findFirst({
        where: { staffRoleKey: "super_admin", status: "active" },
        orderBy: { id: "asc" },
      });
      if (!row) throw new Error("fixture staff");
      return loadCliStaffContext(handle, row.id);
    });
    const year = new Date().getUTCFullYear() + 1;
    const day = new Date(Date.UTC(year, 0, 4));
    while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() + 1);
    stage = "calendar";
    const imported = await calendar.import(
      {
        staff,
        identity: createIdentityContext({
          actor: { type: "staff", id: staff.staff.id, client: "admin" },
        }),
      },
      {
        year,
        source: "本机自有环境 Redis 恢复演练（非真实放假安排）",
        days: [{ date: day.toISOString().slice(0, 10), kind: "holiday", note: "恢复演练" }],
      },
    );
    if (!imported.isChanged) throw new Error("fixture unchanged");
    stage = "timer";
    const job = timers.registry.recurringJobs.find((item) => item.kind === "invariant.quick");
    if (!job || job.schedule.every !== "minutes" || job.schedule.minutes !== 10)
      throw new Error("fixture registered job");
    // 前一合法格距现在 10–20 分钟，仍在原有 30 分钟 deadline 内；不缩短任何生产周期。
    const slot = slotAtOrBefore(job.schedule, new Date(Date.now() - 10 * 60_000));
    await tx.run(async (handle) => {
      if (!(await armRecurringSlot(handle, job.kind, slot)))
        throw new Error("fixture timer exists");
    });
    const subscribers = assembly.subscribers
      .filter((item) => item.events.includes("calendar.imported"))
      .map((item) => item.name)
      .sort();
    if (!subscribers.length) throw new Error("fixture subscribers");
    // 两个服务事务都已经提交；独立短事务只锁已有行，不更改事件或 timer 的技术状态。
    stage = "lock";
    await tx.run(
      async (handle) => {
        const event = await handle.outboxEvent.findUniqueOrThrow({
          where: { dedupeKey: `calendar.imported:${imported.calendarVersion}` },
        });
        const timer = await handle.timer.findFirstOrThrow({
          where: { dedupeKey: recurringKey(job.kind, slot) },
        });
        await handle.$queryRawUnsafe(
          "SELECT id FROM outbox_event WHERE id=$1::uuid FOR UPDATE",
          event.id,
        );
        await handle.$queryRawUnsafe("SELECT id FROM timer WHERE id=$1::uuid FOR UPDATE", timer.id);
        const currentEvent = await handle.outboxEvent.findUniqueOrThrow({
          where: { id: event.id },
        });
        const currentTimer = await handle.timer.findUniqueOrThrow({ where: { id: timer.id } });
        if (currentEvent.publishedAt !== null || currentTimer.status !== "scheduled")
          throw new Error("fixture consumed before flush");
        const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
        let timeout;
        try {
          const release = new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("fixture release timeout")), 20_000);
            input.once("line", (line) =>
              line === "release" ? resolve() : reject(new Error("fixture release command")),
            );
            input.once("close", () => reject(new Error("fixture release closed")));
          });
          process.stdout.write(
            `${JSON.stringify({ eventId: event.id, timerId: timer.id, subscribers })}\n`,
          );
          await release;
        } finally {
          clearTimeout(timeout);
          input.close();
        }
      },
      { timeoutMs: 30_000 },
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch(() => {
  // 不输出服务错误、SQL、stack、连接串或员工事实。
  process.stderr.write(`Redis 恢复演练事实准备失败:${stage}\n`);
  process.exitCode = 1;
});
