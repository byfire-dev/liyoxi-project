import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { connectTestDatabase, useTestDatabase } from "./testing/index.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const db = useTestDatabase("db");
const now = new Date("2026-10-08T10:00:00Z");
let app: Client, other: Client, readonly: Client;
beforeAll(async () => {
  const prisma = await db.prisma();
  for (const sceneKey of ["m.rule_change_notice", "m.rule_change_withdrawn"])
    await prisma.notifyScene.create({
      data: {
        sceneKey,
        audience: "merchant",
        name: "公告分页",
        sendWindow: "immediate",
        createdAt: now,
        updatedAt: now,
      },
    });
  app = await connectTestDatabase(db.name);
  other = await connectTestDatabase(db.name);
  readonly = await connectTestDatabase(db.name, { role: "lyx_readonly" });
});
afterAll(async () => {
  await Promise.all([app?.end(), other?.end(), readonly?.end()]);
});
async function notice() {
  const id = randomUUID();
  await (
    await db.prisma()
  ).siteNotice.create({
    data: {
      id,
      kind: "agreement_version",
      refId: randomUUID(),
      title: "分页公告",
      summary: "协议将生效",
      effectiveAt: new Date("2026-10-22T10:00:00Z"),
      announcedAt: now,
      leadDays: 14,
      link: { route: "messages.list", params: {} },
      createdByStaffId: randomUUID(),
      createdAt: now,
      updatedAt: now,
    },
  });
  return id;
}
async function insert(siteNoticeId: string, client = app, scene = "m.rule_change_notice") {
  const id = randomUUID();
  await client.query(
    `insert into notification_fanout
    (id, source_outbox_event_id, notify_scene_key, site_notice_id, due_at, created_at, updated_at)
    values ($1,$2,$3,$4,$5,$5,$5)`,
    [id, randomUUID(), scene, siteNoticeId, now],
  );
  return id;
}

describe("notification_fanout 独立结构能力", () => {
  it("应用角色可写实际公告/场景引用；事件和游标不依赖可删除的收件人或 outbox", async () => {
    const id = await insert(await notice());
    const row = (
      await app.query(
        `select status, attempt_no, cursor_merchant_user_id, cursor_entity_id from notification_fanout where id=$1`,
        [id],
      )
    ).rows[0];
    expect(row).toEqual({
      status: "pending",
      attempt_no: 0,
      cursor_merchant_user_id: null,
      cursor_entity_id: null,
    });
    await app.query(
      `update notification_fanout set cursor_merchant_user_id=$2, cursor_entity_id=$3 where id=$1`,
      [id, randomUUID(), randomUUID()],
    );
    const fks = (
      await app.query(
        `select conname from pg_constraint where conrelid='notification_fanout'::regclass and contype='f' order by conname`,
      )
    ).rows;
    expect(fks.map((row) => row.conname)).toEqual([
      "fk_notification_fanout_notify_scene_key",
      "fk_notification_fanout_site_notice_id",
    ]);
  });

  it("两个真实连接并发创建同一公告/场景只留一页任务；撤回另有一条任务", async () => {
    const siteId = await notice();
    const results = await Promise.allSettled([insert(siteId, app), insert(siteId, other)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "23505", constraint: "uq_notification_fanout_scene_notice" },
    });
    await insert(siteId, app, "m.rule_change_withdrawn");
    expect(
      (
        await app.query(
          `select count(*)::int as n from notification_fanout where site_notice_id=$1`,
          [siteId],
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
  });

  it("CHECK 拒绝不完整游标、未知状态、次数越界及不一致租约/终态；合法两端边界保留", async () => {
    const id = await insert(await notice());
    const invalid = [
      {
        sql: "cursor_merchant_user_id=$2",
        value: randomUUID(),
        constraint: "ck_notification_fanout_cursor",
      },
      { sql: "status=$2", value: "dead", constraint: "ck_notification_fanout_status" },
      { sql: "attempt_no=$2", value: -1, constraint: "ck_notification_fanout_attempt" },
      { sql: "attempt_no=$2", value: 4, constraint: "ck_notification_fanout_attempt" },
      { sql: "status=$2", value: "sending", constraint: "ck_notification_fanout_lease" },
      { sql: "lease_until=$2", value: now, constraint: "ck_notification_fanout_lease" },
      { sql: "status=$2", value: "sent", constraint: "ck_notification_fanout_finished" },
      { sql: "finished_at=$2", value: now, constraint: "ck_notification_fanout_finished" },
    ];
    for (const input of invalid)
      await expect(
        app.query(`update notification_fanout set ${input.sql} where id=$1`, [id, input.value]),
      ).rejects.toMatchObject({ code: "23514", constraint: input.constraint });
    await app.query(`update notification_fanout set attempt_no=3 where id=$1`, [id]);
    expect(
      (await app.query(`select attempt_no from notification_fanout where id=$1`, [id])).rows,
    ).toEqual([{ attempt_no: 3 }]);
  });

  it("短事务 CAS 认领只有一个赢家，过期租约重入后旧 attempt 不能推进游标", async () => {
    const id = await insert(await notice());
    const lease1 = new Date(now.getTime() + 30_000),
      lease2 = new Date(now.getTime() + 90_000);
    const claim = (client: Client) =>
      client.query(
        `update notification_fanout set status='sending', attempt_no=attempt_no+1, lease_until=$2, updated_at=$3 where id=$1 and status='pending' and due_at<=$3 returning attempt_no`,
        [id, lease1, now],
      );
    const winners = await Promise.all([claim(app), claim(other)]);
    expect(winners.map((result) => result.rowCount).sort()).toEqual([0, 1]);
    const reentry = await other.query(
      `update notification_fanout set attempt_no=attempt_no+1, lease_until=$3, updated_at=$2 where id=$1 and status='sending' and lease_until<=$2 and attempt_no<3 returning attempt_no`,
      [id, new Date(now.getTime() + 30_000), lease2],
    );
    expect(reentry.rows).toEqual([{ attempt_no: 2 }]);
    const stale = await app.query(
      `update notification_fanout set cursor_merchant_user_id=$4, cursor_entity_id=$5 where id=$1 and status='sending' and attempt_no=$2 and lease_until=$3`,
      [id, 1, lease1, randomUUID(), randomUUID()],
    );
    expect(stale.rowCount).toBe(0);
    expect(
      (
        await app.query(
          `select cursor_merchant_user_id, cursor_entity_id from notification_fanout where id=$1`,
          [id],
        )
      ).rows,
    ).toEqual([{ cursor_merchant_user_id: null, cursor_entity_id: null }]);
    await app.query(
      `update notification_fanout set status='sent', lease_until=null, finished_at=$2, updated_at=$2 where id=$1 and status='sending' and attempt_no=2 and lease_until=$3`,
      [id, new Date(now.getTime() + 60_000), lease2],
    );
    expect(
      (await app.query(`select status, attempt_no from notification_fanout where id=$1`, [id]))
        .rows,
    ).toEqual([{ status: "sent", attempt_no: 2 }]);
  });

  it("页末游标与同事务结果回滚，不把失败页变成已处理", async () => {
    const id = await insert(await notice());
    await app.query("begin");
    try {
      await app.query(
        `update notification_fanout set cursor_merchant_user_id=$2, cursor_entity_id=$3, status='sent', finished_at=$4, updated_at=$4 where id=$1`,
        [id, randomUUID(), randomUUID(), now],
      );
      expect(
        (await app.query(`select status from notification_fanout where id=$1`, [id])).rows,
      ).toEqual([{ status: "sent" }]);
    } finally {
      await app.query("rollback");
    }
    expect(
      (
        await other.query(
          `select status, cursor_merchant_user_id, cursor_entity_id, finished_at from notification_fanout where id=$1`,
          [id],
        )
      ).rows,
    ).toEqual([
      {
        status: "pending",
        cursor_merchant_user_id: null,
        cursor_entity_id: null,
        finished_at: null,
      },
    ]);
  });

  it("场景/公告真实外键与权限下限仍生效：readonly只读，应用无删除/清空权", async () => {
    const id = await insert(await notice());
    await expect(
      app.query(`update notification_fanout set site_notice_id=$2 where id=$1`, [id, randomUUID()]),
    ).rejects.toMatchObject({ code: "23503", constraint: "fk_notification_fanout_site_notice_id" });
    expect(
      (await readonly.query(`select status from notification_fanout where id=$1`, [id])).rows,
    ).toEqual([{ status: "pending" }]);
    await expect(
      readonly.query(`update notification_fanout set attempt_no=1 where id=$1`, [id]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      app.query(`delete from notification_fanout where id=$1`, [id]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("truncate notification_fanout")).rejects.toMatchObject({
      code: "42501",
    });
  });
});
