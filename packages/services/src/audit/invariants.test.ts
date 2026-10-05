import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTxRunner, uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { connectTestDatabase, useTestDatabase } from "../testing/index.js";
import {
  adminMeta,
  clerk,
  cliStaff,
  ENTITY_ID,
  noRequest,
  owner,
  staff,
  STORE_ID,
  system,
  weappMeta,
} from "./__fixtures__/actors.js";
import { AUDIT_INVARIANTS, auditI2, auditI3 } from "./invariants.js";
import { record, toAuditRow } from "./record.js";
import type { AuditEntry } from "./record.js";

// 验收第 5 条：经 record 写的数据两条检查 0 违规；绕过 record 直接插的坏行，audit.I3 逐条报出来。

const db = useTestDatabase("services");
let prisma: PrismaClient;
let tx: TxRunner;
let ownerConn: Awaited<ReturnType<typeof connectTestDatabase>>;

beforeAll(async () => {
  prisma = await db.prisma();
  tx = createTxRunner({ prisma, appEnv: "test" });
  ownerConn = await connectTestDatabase(db.name, { role: null });
}, 120_000);

afterAll(async () => {
  await ownerConn?.end();
});

const entry: AuditEntry = {
  stream: "ops",
  category: "staff_authz",
  action: "staff.account.disable",
  summary: "禁用员工",
};
/** 绕过 record：拿规范化好的一行，改坏几列，直接插 */
async function forge(patch: Record<string, unknown>): Promise<string> {
  const id = uuidv7();
  await prisma.auditLog.create({ data: { ...toAuditRow(staff, adminMeta, entry), ...patch, id } });
  return id;
}

describe("audit.I2、audit.I3", () => {
  it("登记的形状照 D7 第 9.6 节：编码、模块、级别、运行方式", () => {
    expect(AUDIT_INVARIANTS.map((check) => [check.code, check.module, check.severity])).toEqual([
      ["audit.I2", "audit", "P2"],
      ["audit.I3", "audit", "P2"],
    ]);
  });

  it("经 record 写的各种行：两条检查 0 违规", async () => {
    await tx.run(async (handle) => {
      const scoped = { entityId: ENTITY_ID, storeId: STORE_ID };
      await record(handle, staff, adminMeta, { ...entry, ...scoped });
      await record(handle, staff, adminMeta, {
        ...entry,
        target: { type: "staff", id: uuidv7() },
      });
      await record(handle, staff, adminMeta, {
        ...entry,
        target: { type: "staff_role", id: "cs" },
      });
      await record(handle, owner, weappMeta, { ...entry, stream: "activity", ...scoped });
      await record(handle, clerk, { ...weappMeta, authMethod: "portal" }, { ...entry, ...scoped });
      await record(handle, cliStaff, { ...noRequest, jobName: "staff.disable" }, entry);
      await record(handle, system, adminMeta, { ...entry, entityId: ENTITY_ID });
      await record(handle, system, noRequest, { ...entry, stream: "access" });
    });
    expect(await prisma.auditLog.count()).toBe(8);
    expect(await auditI2.run(prisma)).toEqual([]);
    expect(await auditI3.run(prisma)).toEqual([]);
  });

  it("绕过 record 直接插一条 system 且带 client 的行：audit.I3 报 1 条", async () => {
    const id = await forge({ actorType: "system", actorId: null, client: "admin" });
    const found = await auditI3.run(prisma);
    expect(found).toEqual([
      {
        subjectType: "audit_log",
        subjectId: id,
        detail: {
          logNo: expect.stringMatching(/^RZ\d{13,}$/),
          rule: "system_with_actor_or_client",
        },
      },
    ]);
    expect(await auditI2.run(prisma)).toEqual([]);
  });

  it("其余几种坏行各报各的规则；事务句柄也能当查询入口", async () => {
    const forged: Array<[string, Record<string, unknown>]> = [
      ["system_with_actor_or_client", { actorType: "system", client: null }],
      ["person_without_actor_or_client", { client: null }],
      ["person_without_actor_or_client", { actorId: null }],
      ["cli_shape", { client: "cli", jobName: "cli.x", sessionId: uuidv7() }],
      ["cli_shape", { client: "cli", jobName: "staff.x", sessionId: null }],
      ["cli_shape", { client: "cli", jobName: null, sessionId: null }],
      ["cli_shape", { actorType: "merchant", client: "cli", jobName: "cli.x", sessionId: null }],
      ["target_id_and_key", { targetType: "staff", targetId: uuidv7(), targetKey: "k" }],
      ["target_without_type", { targetType: null, targetKey: "k" }],
      ["target_without_type", { targetType: null, targetId: uuidv7() }],
      ["store_without_entity", { storeId: STORE_ID, entityId: null }],
    ];
    const expected = new Map<string, string>();
    for (const [rule, patch] of forged) expected.set(await forge(patch), rule);

    const found = await tx.run((handle) => auditI3.run(handle));
    const reported = new Map(found.map((item) => [item.subjectId, item.detail.rule]));
    for (const [id, rule] of expected) expect(reported.get(id), JSON.stringify(rule)).toBe(rule);
    // 上一条用例的 1 条加这里的 11 条；合规的 8 条一条不报
    expect(found).toHaveLength(12);
  });

  it("since：只查这个时刻之后写入的行", async () => {
    expect(await auditI3.run(prisma, { since: new Date(Date.now() + 3_600_000) })).toEqual([]);
    expect(await auditI3.run(prisma, { since: new Date(Date.now() - 3_600_000) })).toHaveLength(12);
  });

  it("audit.I2：编号的日期与写入时间不同日的行报得出来（停掉插入触发器才造得出这种行）", async () => {
    const id = uuidv7();
    await ownerConn.query("ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_bi");
    try {
      await ownerConn.query(
        `INSERT INTO audit_log (id, created_at, log_no, stream, category, action, summary,
                                actor_type, actor_name, actor_role)
         VALUES ($1, '2026-01-05T16:30:00Z', 'RZ2026010500001', 'ops', 'param', 'a.b.c', '跨日',
                 'system', '系统', '自动任务')`,
        [id],
      );
    } finally {
      await ownerConn.query("ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_bi");
    }
    // 2026-01-05 16:30 UTC 是北京时间 1 月 6 日 00:30：编号却写的 5 日
    expect(await auditI2.run(prisma)).toEqual([
      {
        subjectType: "audit_log",
        subjectId: id,
        detail: { logNo: "RZ2026010500001", rule: "log_no_date_mismatch" },
      },
    ]);
  });
});
