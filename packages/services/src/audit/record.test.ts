import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTxRunner, isUuid, uuidv7 } from "../kernel/index.js";
import type { Tx, TxRunner } from "../kernel/index.js";
import { connectTestDatabase, useTestDatabase } from "../testing/index.js";
import {
  adminMeta,
  clerk,
  cliStaff,
  ENTITY_ID,
  noRequest,
  owner,
  SESSION_ID,
  staff,
  STAFF_ID,
  STORE_ID,
  system,
  USER_ID,
  weappMeta,
} from "./__fixtures__/actors.js";
import { findUnknownAuditTargetTypes } from "./invariants.js";
import { record, toAuditRow } from "./record.js";
import type { AuditEntry } from "./record.js";

// 验收第 1–3 条：事务回滚时审计不留；改删审计行被拒；三条流与规范化。
// 连接用支架给的缺省身份（应用角色 lyx_app）；验触发器那一道另开一条属主身份的连接。

const db = useTestDatabase("services");
let prisma: PrismaClient;
let tx: TxRunner;
type Owner = Awaited<ReturnType<typeof connectTestDatabase>>;
let ownerConn: Owner;

beforeAll(async () => {
  prisma = await db.prisma();
  tx = createTxRunner({ prisma, appEnv: "test" });
  ownerConn = await connectTestDatabase(db.name, { role: null });
}, 120_000);

afterAll(async () => {
  await ownerConn?.end();
});

const refund: AuditEntry = {
  stream: "ops",
  category: "refund",
  action: "finance.refund.execute",
  summary: "执行退款 TK20260105001，退回 199.00 元",
};
const count = (): Promise<number> => prisma.auditLog.count();
const rowOf = (id: string) => prisma.auditLog.findUniqueOrThrow({ where: { id } });
/** 业务写：biz_sequence 的一行 */
const bizWrite = (handle: Tx, prefix: string): Promise<unknown> =>
  handle.bizSequence.create({ data: { prefix, bizDate: new Date("2026-01-05"), nextVal: 1 } });
const bizRows = (): Promise<number> => prisma.bizSequence.count();
const sqlState = (error: unknown): string =>
  String((error as { code?: unknown }).code ?? (error as Error).message);

describe("验收 1：审计行与业务写同事务", () => {
  it("用例写业务行与审计行后抛错：两者都不存在", async () => {
    const [auditBefore, bizBefore] = [await count(), await bizRows()];
    const boom = new Error("业务失败");
    let written = "";
    await expect(
      tx.run(async (handle) => {
        await bizWrite(handle, "RB");
        written = (await record(handle, staff, adminMeta, refund)).id;
        // 事务里看得见这一行
        expect(await handle.auditLog.count({ where: { id: written } })).toBe(1);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await count()).toBe(auditBefore);
    expect(await bizRows()).toBe(bizBefore);
    expect(await prisma.auditLog.findUnique({ where: { id: written } })).toBeNull();
  });

  it("正常提交恰多 1 行；log_no 是 RZ 加当日日期（北京时间）加序号；created_at 由库写", async () => {
    const before = await count();
    const startedAt = Date.now();
    const recorded = await tx.run(async (handle) => {
      await bizWrite(handle, "OK");
      return record(handle, staff, adminMeta, refund);
    });
    expect(await count()).toBe(before + 1);
    const row = await rowOf(recorded.id);
    expect(isUuid(row.id)).toBe(true);
    expect(row.id[14]).toBe("7");
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" })
      .format(row.createdAt)
      .replaceAll("-", "");
    expect(row.logNo).toMatch(new RegExp(`^RZ${day}\\d{5,}$`));
    expect(recorded.logNo).toBe(row.logNo);
    expect(Math.abs(row.createdAt.getTime() - startedAt)).toBeLessThan(60_000);
  });

  it("只接受事务句柄：普通客户端传不进去（类型检查拦）", () => {
    // @ts-expect-error 普通 Prisma 客户端不是 Tx
    const attempt = () => record(prisma, staff, adminMeta, refund);
    expect(attempt).toBeTypeOf("function");
  });
});

describe("验收 2：改删审计行被拒", () => {
  let id: string;
  beforeAll(async () => {
    id = (await tx.run((handle) => record(handle, staff, adminMeta, refund))).id;
  });

  it("应用角色：UPDATE、DELETE、TRUNCATE 都没有权限，行不变", async () => {
    const before = await rowOf(id);
    const attempts = [
      prisma.auditLog.update({ where: { id }, data: { summary: "改掉" } }),
      prisma.auditLog.delete({ where: { id } }),
      prisma.$executeRawUnsafe("UPDATE audit_log SET summary = '改掉'"),
      prisma.$executeRawUnsafe("DELETE FROM audit_log"),
      prisma.$executeRawUnsafe("TRUNCATE audit_log"),
    ];
    for (const attempt of attempts) {
      await expect(attempt).rejects.toThrow(/permission denied|42501/);
    }
    expect(await rowOf(id)).toEqual(before);
  });

  it("属主身份（越过授权）：触发器照样拦 UPDATE、DELETE、TRUNCATE，行不变", async () => {
    const before = await rowOf(id);
    const total = await count();
    const statements = [
      ["UPDATE audit_log SET summary = '改掉' WHERE id = $1", [id]],
      ["DELETE FROM audit_log WHERE id = $1", [id]],
      ["TRUNCATE audit_log", []],
    ] as const;
    for (const [sql, params] of statements) {
      const failure = await ownerConn.query(sql, [...params]).then(
        () => "没有报错",
        (error: unknown) => `${sqlState(error)} ${(error as Error).message}`,
      );
      // 23001 restrict_violation：lyx_forbid_mutation() 抛的
      expect(failure, sql).toMatch(/^23001 table audit_log is append-only/);
    }
    expect(await rowOf(id)).toEqual(before);
    expect(await count()).toBe(total);
  });

  it("created_at、log_no 应用传了也被触发器覆盖", async () => {
    const forged = uuidv7();
    await prisma.auditLog.create({
      data: {
        ...toAuditRow(staff, adminMeta, refund),
        id: forged,
        createdAt: new Date("2001-01-01T00:00:00Z"),
        logNo: "RZ2001010100001",
      },
    });
    const row = await rowOf(forged);
    expect(row.createdAt.getUTCFullYear()).toBeGreaterThan(2020);
    expect(row.logNo).not.toBe("RZ2001010100001");
  });
});

describe("验收 3：三条流与规范化", () => {
  const write = (...args: Parameters<typeof toAuditRow>) =>
    tx.run((handle) => record(handle, ...args)).then((recorded) => rowOf(recorded.id));

  it("ops、activity、access 各写成功", async () => {
    const ops = await write(staff, adminMeta, {
      ...refund,
      target: { type: "refund_request", id: uuidv7(), label: "星河洗车 · TK20260105001" },
      entityId: ENTITY_ID,
      storeId: STORE_ID,
      reason: { code: "merchant_request", text: "商家申请" },
      meta: { approvalStatus: "approved", requestNo: "TK20260105001" },
    });
    expect(ops).toMatchObject({
      stream: "ops",
      category: "refund",
      action: "finance.refund.execute",
      actorType: "staff",
      actorId: STAFF_ID,
      client: "admin",
      actorName: "林晓",
      actorRole: "财务",
      targetType: "refund_request",
      targetKey: null,
      targetLabel: "星河洗车 · TK20260105001",
      entityId: ENTITY_ID,
      storeId: STORE_ID,
      reasonCode: "merchant_request",
      reasonText: "商家申请",
      meta: { approvalStatus: "approved", requestNo: "TK20260105001" },
      requestId: "req-0001",
      sessionId: SESSION_ID,
      authMethod: "password+totp",
      ip: "182.139.20.52",
      userAgent: "Mozilla/5.0 (Macintosh)",
      jobName: null,
      timerId: null,
      before: null,
      after: null,
    });

    const activity = await write(owner, weappMeta, {
      stream: "activity",
      category: "profile_edit",
      action: "profile.store.update",
      summary: "修改门店档案",
      target: { type: "store", id: STORE_ID },
      entityId: ENTITY_ID,
      storeId: STORE_ID,
      before: { name: "星河洗车", contactPhone: "13812345678", hours: "9-18" },
      after: { name: "星河洗车（高新店）", contactPhone: "13912345678", hours: "9-18" },
      fields: ["name", "contactPhone", "hours"],
    });
    expect(activity).toMatchObject({
      stream: "activity",
      actorType: "merchant",
      actorId: USER_ID,
      client: "weapp",
      actorName: "商家",
      actorRole: "老板",
      authMethod: "weapp",
      targetId: STORE_ID,
      before: { name: "星河洗车", contactPhone: "138****5678" },
      after: { name: "星河洗车（高新店）", contactPhone: "139****5678" },
    });

    const access = await write(staff, adminMeta, {
      stream: "access",
      category: "pii_reveal",
      action: "merchant.phone.reveal",
      summary: "查看商家手机号明文",
      target: { type: "merchant_user", id: USER_ID },
      entityId: ENTITY_ID,
    });
    expect(access).toMatchObject({ stream: "access", entityId: ENTITY_ID, storeId: null });
  });

  it("system 行：actor_id、client 为空，即使请求带了客户端；会话、IP、UA 为空，登录方式是 system", async () => {
    const timerId = uuidv7();
    const row = await write(
      system,
      { ...adminMeta, timerId },
      {
        stream: "ops",
        category: "points_expire",
        action: "billing.points.expire",
        summary: "清零",
      },
    );
    expect(row).toMatchObject({
      actorType: "system",
      actorId: null,
      client: null,
      actorName: "系统",
      actorRole: "自动任务",
      sessionId: null,
      authMethod: "system",
      ip: null,
      userAgent: null,
      jobName: "timers.points_expire",
      timerId,
      requestId: "req-0001",
    });
  });

  it("命令行：员工身份、client 是 cli、job_name 以 cli. 开头，没有会话与登录方式", async () => {
    const entry: AuditEntry = {
      stream: "ops",
      category: "system_ops",
      action: "ops.alert.ack",
      summary: "认领告警",
    };
    const row = await write(cliStaff, { ...adminMeta, jobName: "alerts.ack" }, entry);
    expect(row).toMatchObject({
      actorType: "staff",
      actorId: STAFF_ID,
      client: "cli",
      jobName: "cli.alerts.ack",
      sessionId: null,
      authMethod: null,
    });
    const kept = toAuditRow(cliStaff, { ...noRequest, jobName: "cli.staff.reset" }, entry);
    expect(kept.jobName).toBe("cli.staff.reset");
    expect(() => toAuditRow(cliStaff, noRequest, entry)).toThrow("命令行要给命令名");
  });

  it("商家经下载页：店员的名称与角色快照，会话照写", async () => {
    const row = toAuditRow(
      clerk,
      { ...weappMeta, authMethod: "portal" },
      { ...refund, stream: "activity" },
    );
    expect(row).toMatchObject({
      client: "portal",
      actorName: "店员",
      actorRole: "店员",
      authMethod: "portal",
      sessionId: SESSION_ID,
    });
  });

  it("非 uuid 的对象标识落在 target_key；uuid 落在 target_id；两列只填一个", async () => {
    const byKey = await write(staff, adminMeta, {
      stream: "ops",
      category: "staff_authz",
      action: "staff.role.save",
      summary: "保存角色权限",
      target: { type: "staff_role", id: "finance", label: "财务" },
    });
    expect(byKey).toMatchObject({ targetType: "staff_role", targetId: null, targetKey: "finance" });

    const id = uuidv7();
    const upper = toAuditRow(staff, adminMeta, {
      ...refund,
      target: { type: "staff", id: id.toUpperCase() },
    });
    expect(upper).toMatchObject({ targetType: "staff", targetId: id, targetKey: null });
    expect(toAuditRow(staff, adminMeta, refund)).toMatchObject({
      targetType: null,
      targetId: null,
      targetKey: null,
    });
  });

  it("未登记的 target_type、类别、流被拒；动作写法不对被拒：一行都不写", async () => {
    const before = await count();
    const bad: AuditEntry[] = [
      // @ts-expect-error 没有登记的对象类型
      { ...refund, target: { type: "refund_requests", id: uuidv7() } },
      // @ts-expect-error 没有登记的类别
      { ...refund, category: "退款" },
      // @ts-expect-error 没有这条流
      { ...refund, stream: "audit" },
      // @ts-expect-error 动作至少三段
      { ...refund, action: "refund" },
      { ...refund, action: "Finance.Refund.Execute" },
    ];
    for (const entry of bad) {
      await expect(tx.run((handle) => record(handle, staff, adminMeta, entry))).rejects.toThrow(
        TypeError,
      );
    }
    await expect(
      tx.run((handle) => record(handle, staff, adminMeta, bad[0] as AuditEntry)),
    ).rejects.toThrow("对象类型 refund_requests 没有登记");
    expect(await count()).toBe(before);
  });

  it("给 storeId 不给 entityId 过不了类型检查；绕过类型时运行期也拒", () => {
    // @ts-expect-error 给 storeId 必给 entityId
    const entry: AuditEntry = { ...refund, storeId: STORE_ID };
    expect(() => toAuditRow(staff, adminMeta, entry)).toThrow("给 storeId 必给 entityId");
    // 只给 entityId（主体级事件）可以
    expect(toAuditRow(staff, adminMeta, { ...refund, entityId: ENTITY_ID })).toMatchObject({
      entityId: ENTITY_ID,
      storeId: null,
    });
    expect(() => toAuditRow(staff, adminMeta, { ...refund, entityId: "not-a-uuid" })).toThrow(
      TypeError,
    );
    expect(() => toAuditRow(staff, { ...adminMeta, sessionId: "abc" }, refund)).toThrow(TypeError);
  });

  it("前后值：只记白名单里变化的字段；新建、删除、没有变化", () => {
    const fields = ["name", "status", "password", "ghost"];
    const created = toAuditRow(staff, adminMeta, {
      ...refund,
      before: null,
      after: { name: "甲", status: null, other: 1 },
      fields,
    });
    expect(created).toMatchObject({ after: { name: "甲" } });
    expect(created.before).toBeUndefined();
    const removed = toAuditRow(staff, adminMeta, {
      ...refund,
      before: { name: "甲", password: "p@ss" },
      after: null,
      fields,
    });
    expect(removed).toMatchObject({ before: { name: "甲" } });
    expect(removed.after).toBeUndefined();
    const same = toAuditRow(staff, adminMeta, {
      ...refund,
      before: { name: "甲", other: 1 },
      after: { name: "甲", other: 2 },
      fields,
    });
    expect([same.before, same.after]).toEqual([undefined, undefined]);
  });

  it("前后值：比的是脱敏之前的值，两个号码脱敏后一样也记作变化；嵌套里的敏感键同样处理", () => {
    const row = toAuditRow(staff, adminMeta, {
      ...refund,
      before: {
        contactPhone: "13812345678",
        bank: { accountNo: "6225880212346688", token: "t-1" },
      },
      after: { contactPhone: "13899995678", bank: { accountNo: "6225880299996688", token: "t-2" } },
      fields: ["contactPhone", "bank"],
    });
    expect(row.before).toEqual({ contactPhone: "138****5678", bank: { accountNo: "****6688" } });
    expect(row.after).toEqual({ contactPhone: "138****5678", bank: { accountNo: "****6688" } });
  });

  it("契约登记的对象类型都是库里存在的表（启动自检用的函数）", async () => {
    expect(await findUnknownAuditTargetTypes(prisma)).toEqual([]);
    await tx.run(async (handle) => {
      expect(await findUnknownAuditTargetTypes(handle)).toEqual([]);
    });
  });
});
