import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { createAlertActions } from "./alert-actions.js";
import { fixture, failingAuditTx } from "./__fixtures__/flow-ops.js";
const db = useSeededDatabase("services");
let prisma: PrismaClient,
  f: ReturnType<typeof fixture>,
  actions: ReturnType<typeof createAlertActions>;
beforeAll(async () => {
  prisma = await db.prisma();
  f = fixture(prisma);
  actions = createAlertActions(f);
}, 180000);
async function alert() {
  return prisma.alertEvent.create({
    data: {
      id: uuidv7(),
      rule: "timer.failed",
      fingerprint: "timer.failed:" + uuidv7(),
      severity: "P2",
      kind: "event",
      status: "open",
      firstSeenAt: f.clock.now(),
      lastSeenAt: f.clock.now(),
    },
  });
}
describe("W223受限CLI真实服务", { timeout: 120000 }, () => {
  it("active财务主管认领/关闭：身份/原因审计，无会话/无恢复通知/不改首次指纹", async () => {
    const person = await f.make.staff({ staffRoleKey: "finance", isLead: true }),
      row = await alert();
    const base = { staffId: person.id, targetId: row.id, note: "已核对需要人工处理" };
    expect(await actions.runCli({ ...base, command: "ack" })).toEqual({
      command: "ack",
      targetId: row.id,
      status: "acked",
    });
    const ack = await prisma.alertEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(ack).toMatchObject({
      fingerprint: row.fingerprint,
      firstSeenAt: row.firstSeenAt,
      occurrences: row.occurrences,
      ackedByStaffId: person.id,
      ackedAt: f.clock.now(),
      notifyCount: row.notifyCount,
    });
    await expect(actions.runCli({ ...base, command: "ack" })).rejects.toMatchObject({
      error: "STATE_NOT_ALLOWED",
    });
    expect(await actions.runCli({ ...base, command: "close" })).toEqual({
      command: "close",
      targetId: row.id,
      status: "resolved",
    });
    const audit = await prisma.auditLog.findMany({
      where: { targetId: row.id },
      orderBy: { seq: "asc" },
    });
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => a.action)).toEqual(["ops.alert.acknowledge", "ops.alert.resolve"]);
    for (const log of audit)
      expect(log).toMatchObject({
        actorType: "staff",
        actorId: person.id,
        client: "cli",
        sessionId: null,
        authMethod: null,
        jobName: "cli.alerts.ack",
        reasonText: base.note,
      });
    expect((await prisma.alertEvent.findUniqueOrThrow({ where: { id: row.id } })).notifyCount).toBe(
      row.notifyCount,
    );
  });
  it("只active真实权限、不造会话、不批量、缺理由/未知参数/错误对象不改", async () => {
    const editor = await f.make.staff({ staffRoleKey: "editor" }),
      nonLead = await f.make.staff({ staffRoleKey: "finance" }),
      disabled = await f.make.staff({
        staffRoleKey: "super_admin",
        status: "disabled",
        disabledAt: f.clock.now(),
        disabledReason: "other",
      }),
      row = await alert();
    for (const person of [editor, nonLead, disabled])
      await expect(
        actions.runCli({
          command: "ack",
          staffId: person.id,
          targetId: row.id,
          note: "核对后准备人工处理",
        }),
      ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    const admin = await f.make.staff({ staffRoleKey: "super_admin" });
    for (const note of ["", "短", "字".repeat(201)])
      await expect(
        actions.runCli({ command: "close", staffId: admin.id, targetId: row.id, note }),
      ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    await expect(
      actions.runCli({
        command: "ack",
        staffId: admin.id,
        targetId: uuidv7(),
        note: "明确指定目标记录",
      }),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    expect((await prisma.alertEvent.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      "open",
    );
    expect(await prisma.auditLog.count({ where: { targetId: row.id } })).toBe(0);
  });
  it("并发ack一成功一409，关闭open允许；callbackCLI共享复位且无新事件", async () => {
    const admin = await f.make.staff({ staffRoleKey: "super_admin" }),
      row = await alert();
    const input = {
      command: "ack" as const,
      staffId: admin.id,
      targetId: row.id,
      note: "核实后受限认领操作",
    };
    const results = await Promise.allSettled([actions.runCli(input), actions.runCli(input)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { targetId: row.id } })).toBe(1);
    const open = await alert();
    await actions.runCli({ ...input, command: "close", targetId: open.id });
    const inbox = await f.webhook(),
      events = await prisma.outboxEvent.count();
    expect(
      await actions.runCli({ ...input, command: "reset-webhook", targetId: inbox.id }),
    ).toMatchObject({ status: "received" });
    expect(await prisma.outboxEvent.count()).toBe(events);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { targetId: inbox.id } });
    expect(log).toMatchObject({
      action: "ops.webhook.retry",
      client: "cli",
      jobName: "cli.alerts.ack",
    });
  });
  it("CLI审计失败让ack/close/reset同事务目标变更全部回滚", async () => {
    const failing = createAlertActions({ clock: f.clock, tx: failingAuditTx(f.tx) });
    const admin = await f.make.staff({ staffRoleKey: "super_admin" }),
      ack = await alert(),
      close = await alert(),
      inbox = await f.webhook();
    for (const [command, targetId] of [
      ["ack", ack.id],
      ["close", close.id],
      ["reset-webhook", inbox.id],
    ] as const)
      await expect(
        failing.runCli({ command, staffId: admin.id, targetId, note: "受控模拟审计失败" }),
      ).rejects.toThrow("fictional audit failure");
    for (const row of [ack, close])
      expect(await prisma.alertEvent.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: inbox.id } })).toEqual(inbox);
    expect(
      await prisma.auditLog.count({ where: { targetId: { in: [ack.id, close.id, inbox.id] } } }),
    ).toBe(0);
  });
});
