import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { connectTestDatabase, useTestDatabase } from "./testing/index.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const db = useTestDatabase("db", { max: 1 });
const at = new Date("2026-10-11T10:00:00.123Z");
const expires = new Date(at.getTime() + 86_400_000);
let app: Client, other: Client, owner: Client, readonly: Client;
let appPid: number, otherPid: number;
type Scope = { entityId: string; storeId: string; inviterMemberId: string; userId: string };
type Invite = Scope & { invitationId: string; clientRequestId: string };

beforeAll(async () => {
  await db.url();
  app = await connectTestDatabase(db.name);
  other = await connectTestDatabase(db.name);
  owner = await connectTestDatabase(db.name, { role: null });
  readonly = await connectTestDatabase(db.name, { role: "lyx_readonly" });
  for (const client of [app, other]) await client.query("SET statement_timeout='10s'");
  appPid = (await app.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  otherPid = (await other.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
});
afterAll(async () => {
  await Promise.all([app?.end(), other?.end(), owner?.end(), readonly?.end()]);
});

// 仅构造真实 SQL 结构事实；不是尚未实现的邀请 HTTP/用例 producer。
async function user() {
  const id = randomUUID();
  await app.query(
    `INSERT INTO merchant_user
      (id,status,source_type,phone_enc,phone_bidx,phone_mask,phone_last4,last_active_at,created_at,updated_at)
     VALUES ($1,'active','organic','fixture-cipher',$2,'138****0000','0000',$3,$3,$3)`,
    [id, randomBytes(32), at],
  );
  return id;
}
async function member(entityId: string, role = "clerk") {
  const userId = await user(),
    id = randomUUID();
  await app.query(
    `INSERT INTO entity_member (id,entity_id,merchant_user_id,role,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'active',$5,$5)`,
    [id, entityId, userId, role, at],
  );
  return { inviterMemberId: id, userId };
}
async function store(entityId: string) {
  const id = randomUUID();
  await app.query(
    `INSERT INTO store (id,entity_id,lifecycle,created_at,updated_at)
     VALUES ($1,$2,'active',$3,$3)`,
    [id, entityId, at],
  );
  return id;
}
async function scope(): Promise<Scope> {
  const entityId = randomUUID(),
    createdBy = await user();
  await app.query(
    `INSERT INTO entity (id,lifecycle,verification_status,source_type,created_by_user_id,created_at,updated_at)
     VALUES ($1,'active','unsubmitted','organic',$2,$3,$3)`,
    [entityId, createdBy, at],
  );
  return { entityId, storeId: await store(entityId), ...(await member(entityId, "owner")) };
}
async function invite(s: Scope, client = app): Promise<Invite> {
  const invitationId = randomUUID(),
    clientRequestId = randomUUID();
  await client.query(
    `INSERT INTO invitation
      (id,entity_id,store_id,role,inviter_member_id,token_hash,token_enc,remark_name,
       target_phone_bidx,status,expires_at,client_request_id,created_at,updated_at)
     VALUES ($1,$2,$3,'clerk',$4,$5,'fixture-token','结构夹具',$6,'pending',$7,$8,$9,$9)`,
    [
      invitationId,
      s.entityId,
      s.storeId,
      s.inviterMemberId,
      randomBytes(32),
      randomBytes(32),
      expires,
      clientRequestId,
      at,
    ],
  );
  return { ...s, invitationId, clientRequestId };
}
async function bind(i: Invite, client = app, requestId = i.clientRequestId, conflict = false) {
  return client.query(
    `INSERT INTO invitation_request
      (id,inviter_member_id,client_request_id,invitation_id,entity_id,store_id,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ${conflict ? "ON CONFLICT (inviter_member_id,client_request_id) DO NOTHING" : ""}
     RETURNING invitation_id`,
    [randomUUID(), i.inviterMemberId, requestId, i.invitationId, i.entityId, i.storeId, at],
  );
}
async function bindings(invitationId: string, client = app) {
  return (
    await client.query(
      "SELECT row_to_json(r)::text AS row FROM invitation_request r WHERE invitation_id=$1 ORDER BY id",
      [invitationId],
    )
  ).rows;
}
async function waitForUniqueLock() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await owner.query("SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked", [
      appPid,
      otherPid,
    ]);
    if (result.rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("第二应用连接未实际等待第一连接的唯一键事务锁");
}

describe("invitation_request 独立结构能力", () => {
  it("origin 下只有七个无默认非空字段、精确四 FK 与四项新增索引", async () => {
    expect((await app.query("SHOW session_replication_role")).rows).toEqual([
      { session_replication_role: "origin" },
    ]);
    const columns = (
      await app.query(
        `SELECT column_name,is_nullable,column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='invitation_request' ORDER BY ordinal_position`,
      )
    ).rows;
    expect(columns).toEqual(
      [
        "id",
        "inviter_member_id",
        "client_request_id",
        "invitation_id",
        "entity_id",
        "store_id",
        "created_at",
      ].map((column_name) => ({ column_name, is_nullable: "NO", column_default: null })),
    );
    const fks = (
      await app.query(
        `SELECT conname,confrelid::regclass::text AS parent,confdeltype,confupdtype,
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,pos)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.pos) AS columns,
        ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,pos)
          JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.pos) AS referenced
       FROM pg_constraint c WHERE conrelid='invitation_request'::regclass AND contype='f' ORDER BY conname`,
      )
    ).rows;
    expect(fks).toEqual(
      [
        {
          conname: "fk_invitation_request_entity_id",
          parent: "entity",
          columns: ["entity_id"],
          referenced: ["id"],
        },
        {
          conname: "fk_invitation_request_invitation_scope",
          parent: "invitation",
          columns: ["invitation_id", "inviter_member_id", "entity_id", "store_id"],
          referenced: ["id", "inviter_member_id", "entity_id", "store_id"],
        },
        {
          conname: "fk_invitation_request_inviter_entity",
          parent: "entity_member",
          columns: ["inviter_member_id", "entity_id"],
          referenced: ["id", "entity_id"],
        },
        {
          conname: "fk_invitation_request_store_entity",
          parent: "store",
          columns: ["store_id", "entity_id"],
          referenced: ["id", "entity_id"],
        },
      ].map((fk) => ({ ...fk, confdeltype: "r", confupdtype: "r" })),
    );
    expect(
      (
        await app.query(
          `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND
        (tablename='invitation_request' OR indexname='uq_invitation_id_inviter_entity_store') ORDER BY indexname`,
        )
      ).rows.map((r) => r.indexname),
    ).toEqual([
      "ix_invitation_request_invitation_id",
      "pk_invitation_request",
      "uq_invitation_id_inviter_entity_store",
      "uq_invitation_request_inviter_client",
    ]);
    expect(
      (
        await app.query(
          `SELECT indexname FROM pg_indexes WHERE tablename='invitation' AND indexname IN
       ('pk_invitation','uq_invitation_token_hash','uq_invitation_inviter_member_id_client_request_id') ORDER BY indexname`,
        )
      ).rows,
    ).toHaveLength(3);
  });

  it("A/B 可绑定同卡；规范键不含门店，其他 inviter 可使用同一请求号", async () => {
    const s = await scope(),
      first = await invite(s),
      keyB = randomUUID();
    await bind(first);
    await bind(first, app, keyB);
    expect(await bindings(first.invitationId)).toHaveLength(2);
    await expect(bind(first)).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_invitation_request_inviter_client",
    });
    const second = await invite({ ...s, storeId: await store(s.entityId) });
    await expect(bind(second, app, keyB)).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_invitation_request_inviter_client",
    });
    const different = await invite({ ...s, ...(await member(s.entityId)) });
    await bind(different, app, keyB);
    expect(
      (
        await app.query(
          "SELECT invitation_id FROM invitation_request WHERE client_request_id=$1 ORDER BY invitation_id",
          [keyB],
        )
      ).rows
        .map((r) => r.invitation_id)
        .sort(),
    ).toEqual([first.invitationId, different.invitationId].sort());
  });

  it("同主体异店、同店异 inviter、完整异主体及不存在邀请均不能错绑", async () => {
    const s = await scope(),
      i = await invite(s),
      foreign = await scope();
    const wrong = [
      { ...i, storeId: await store(s.entityId) },
      { ...i, ...(await member(s.entityId)) },
      { ...i, ...foreign },
      { ...i, invitationId: randomUUID() },
    ];
    for (const candidate of wrong)
      await expect(bind(candidate, app, randomUUID())).rejects.toMatchObject({
        code: "23503",
        constraint: "fk_invitation_request_invitation_scope",
      });
    expect(await bindings(i.invitationId)).toEqual([]);
  });

  it.each(["COMMIT", "ROLLBACK"] as const)(
    "两应用连接唯一键等待：首事务 %s 后绑定不分叉",
    async (outcome) => {
      const s = await scope(),
        first = await invite(s),
        candidate = await invite(s),
        key = randomUUID();
      await app.query("BEGIN");
      let pending:
        Promise<{ result: Awaited<ReturnType<typeof bind>> } | { error: unknown }> | undefined;
      try {
        await bind(first, app, key);
        pending = bind(candidate, other, key, true).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        await waitForUniqueLock();
      } finally {
        try {
          await app.query(outcome);
        } finally {
          await pending;
        }
      }
      expect(pending).toBeDefined();
      const settled = await pending!;
      if ("error" in settled) throw settled.error;
      expect(settled.result.rowCount).toBe(outcome === "COMMIT" ? 0 : 1);
      expect(
        (
          await other.query(
            "SELECT invitation_id FROM invitation_request WHERE inviter_member_id=$1 AND client_request_id=$2",
            [s.inviterMemberId, key],
          )
        ).rows,
      ).toEqual([
        { invitation_id: outcome === "COMMIT" ? first.invitationId : candidate.invitationId },
      ]);
    },
  );

  it("新邀请与 A 绑定同事务回滚，其他连接看不到半成品", async () => {
    const s = await scope();
    let i: Invite | undefined;
    await app.query("BEGIN");
    try {
      i = await invite(s);
      await bind(i);
      expect(await bindings(i.invitationId)).toHaveLength(1);
      expect(await bindings(i.invitationId, other)).toEqual([]);
    } finally {
      await app.query("ROLLBACK");
    }
    expect(
      (await other.query("SELECT id FROM invitation WHERE id=$1", [i!.invitationId])).rows,
    ).toEqual([]);
    expect(await bindings(i!.invitationId, other)).toEqual([]);
  });

  it("复用字段编辑和 B 绑定一并回滚，原 A 与整张邀请逐列不变", async () => {
    const i = await invite(await scope());
    await bind(i);
    const before = (
      await other.query("SELECT row_to_json(i)::text AS row FROM invitation i WHERE id=$1", [
        i.invitationId,
      ])
    ).rows;
    const original = await bindings(i.invitationId),
      keyB = randomUUID();
    await app.query("BEGIN");
    try {
      await app.query(
        "UPDATE invitation SET remark_name='新备注',expires_at=$2,updated_at=$3 WHERE id=$1",
        [i.invitationId, new Date(expires.getTime() + 60_000), at],
      );
      await bind(i, app, keyB);
      expect(await bindings(i.invitationId)).toHaveLength(2);
    } finally {
      await app.query("ROLLBACK");
    }
    expect(
      (
        await other.query("SELECT row_to_json(i)::text AS row FROM invitation i WHERE id=$1", [
          i.invitationId,
        ])
      ).rows,
    ).toEqual(before);
    expect(await bindings(i.invitationId)).toEqual(original);
    expect(
      (await other.query("SELECT id FROM invitation_request WHERE client_request_id=$1", [keyB]))
        .rows,
    ).toEqual([]);
  });

  it.each(["shared", "accepted", "revoked", "expired"])(
    "合法 %s 历史事实保留 A/B 原始绑定",
    async (state) => {
      const i = await invite(await scope());
      await bind(i);
      await bind(i, app, randomUUID());
      const before = await bindings(i.invitationId);
      if (state === "shared")
        await app.query("UPDATE invitation SET shared_at=$2,updated_at=$2 WHERE id=$1", [
          i.invitationId,
          at,
        ]);
      if (state === "accepted") {
        const accepted = await member(i.entityId);
        await app.query(
          "UPDATE invitation SET status='accepted',token_enc=NULL,accepted_at=$2,accepted_by_user_id=$3,accepted_member_id=$4,updated_at=$2 WHERE id=$1",
          [i.invitationId, at, accepted.userId, accepted.inviterMemberId],
        );
      }
      if (state === "revoked")
        await app.query(
          "UPDATE invitation SET status='revoked',token_enc=NULL,revoked_at=$2,revoke_actor_type='merchant',revoke_actor_id=$3,revoke_client='weapp',revoke_reason='by_owner',updated_at=$2 WHERE id=$1",
          [i.invitationId, at, i.userId],
        );
      if (state === "expired")
        await app.query(
          "UPDATE invitation SET status='expired',token_enc=NULL,updated_at=$2 WHERE id=$1",
          [i.invitationId, expires],
        );
      expect(await bindings(i.invitationId)).toEqual(before);
      await expect(
        owner.query("DELETE FROM invitation WHERE id=$1", [i.invitationId]),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "fk_invitation_request_invitation_scope",
      });
    },
  );

  it("成员移除、门店归档、主体关闭与账号敏感列清除不删除历史绑定", async () => {
    const i = await invite(await scope());
    await bind(i);
    const before = await bindings(i.invitationId);
    await app.query(
      "UPDATE invitation SET status='expired',token_enc=NULL,updated_at=$2 WHERE id=$1",
      [i.invitationId, expires],
    );
    await app.query(
      "UPDATE entity_member SET status='removed',removed_at=$2,remove_actor_type='system',remove_reason='account_deleted',display_name=NULL,updated_at=$2 WHERE id=$1",
      [i.inviterMemberId, expires],
    );
    await app.query(
      "UPDATE store SET lifecycle='archived',archived_at=$2,archive_actor_type='system',archive_reason='entity_closed',updated_at=$2 WHERE id=$1",
      [i.storeId, expires],
    );
    await app.query("UPDATE entity SET lifecycle='closed',closed_at=$2,updated_at=$2 WHERE id=$1", [
      i.entityId,
      expires,
    ]);
    await app.query(
      "UPDATE merchant_user SET status='deleted',deleted_at=$2,phone_enc=NULL,phone_bidx=NULL,phone_mask=NULL,phone_last4=NULL,display_name=NULL,updated_at=$2 WHERE id=$1",
      [i.userId, expires],
    );
    expect(await bindings(i.invitationId)).toEqual(before);
  });

  it("权限和 owner guard 双层限制只增；readonly 只读且不能写入", async () => {
    const i = await invite(await scope());
    await bind(i);
    expect(await bindings(i.invitationId, readonly)).toEqual(await bindings(i.invitationId));
    await expect(bind(i, readonly, randomUUID())).rejects.toMatchObject({ code: "42501" });
    for (const sql of [
      "UPDATE invitation_request SET created_at=created_at WHERE invitation_id=$1",
      "DELETE FROM invitation_request WHERE invitation_id=$1",
      "TRUNCATE invitation_request",
    ]) {
      const values = sql.includes("$1") ? [i.invitationId] : [];
      await expect(app.query(sql, values)).rejects.toMatchObject({ code: "42501" });
      await expect(readonly.query(sql, values)).rejects.toMatchObject({ code: "42501" });
      await expect(owner.query(sql, values)).rejects.toMatchObject({
        code: "23001",
        message: expect.stringContaining("append-only"),
      });
    }
    expect(await bindings(i.invitationId)).toHaveLength(1);
  });
});
