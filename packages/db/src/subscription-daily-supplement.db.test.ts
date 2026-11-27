import { randomUUID, randomBytes } from "node:crypto";
import type { Client } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { connectTestDatabase, useTestDatabase } from "./testing/index.js";

const db = useTestDatabase("db", { max: 1 });
let owner: Client, app: Client, other: Client;
const entity = randomUUID(),
  term = randomUUID(),
  staff = randomUUID();
beforeAll(async () => {
  await db.url();
  owner = await connectTestDatabase(db.name, { role: null });
  app = await connectTestDatabase(db.name);
  other = await connectTestDatabase(db.name);
  // Only the referenced structural fixture bypasses unrelated source FKs. All supplement tests use origin.
  await owner.query("SET session_replication_role=replica");
  await owner.query(
    `INSERT INTO staff (id,name,phone_enc,phone_bidx,phone_mask,phone_last4,staff_role_key,status,created_at,updated_at)
    VALUES ($1,'fixture','fixture',$2,'138****0000','0000','super_admin','active',now(),now())`,
    [staff, randomBytes(32)],
  );
  await owner.query("SET session_replication_role=origin");
}, 120_000);
afterAll(async () => {
  await Promise.all([owner?.end(), app?.end(), other?.end()]);
});
async function event() {
  const id = randomUUID();
  await owner.query("SET session_replication_role=replica");
  try {
    await owner.query(
      `INSERT INTO subscription_event (id,entity_id,subscription_term_id,type,occurred_at,biz_date,actor_type,created_at)
      VALUES ($1,$2,$3,'activated',now(),CURRENT_DATE,'system',now())`,
      [id, entity, term],
    );
  } finally {
    await owner.query("SET session_replication_role=origin");
  }
  return id;
}
async function insert(
  eventId: string,
  client = app,
  scope = entity,
  hash = "a".repeat(64),
  authorizer = staff,
) {
  return client.query(
    `INSERT INTO subscription_event_daily_supplement
    (id,event_id,entity_id,subscription_term_id,event_fingerprint,payload,payload_hash,evidence,evidence_hash,strategy,source_sha,baseline_sha,authorized_by_staff_id,operator,reason,created_at)
    VALUES ($1,$2,$3,$4,$5,'{}',$5,'{}',$5,'legacy_activation_v1',$6,$6,$7,'operator','authorized repair',now()) RETURNING id`,
    [randomUUID(), eventId, scope, term, hash, "b".repeat(40), authorizer],
  );
}
it("origin 下绑定真实原事件三元组及授权员工；损坏指纹拒绝", async () => {
  const id = await event();
  expect((await app.query("SHOW session_replication_role")).rows[0].session_replication_role).toBe(
    "origin",
  );
  await expect(insert(id, app, randomUUID())).rejects.toMatchObject({ code: "23503" });
  await expect(insert(id, app, entity, "a".repeat(64), randomUUID())).rejects.toMatchObject({
    code: "23503",
  });
  await expect(insert(id, app, entity, "bad-hash")).rejects.toMatchObject({ code: "23514" });
  await insert(id);
  expect(
    (await app.query("SELECT payload FROM subscription_event WHERE id=$1", [id])).rows,
  ).toEqual([{ payload: null }]);
});
it("同事件并发仅追加一条；应用与属主均不能修改或删除恢复凭据", async () => {
  for (let round = 0; round < 3; round++) {
    const id = await event();
    const results = await Promise.allSettled([insert(id, app), insert(id, other)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "23505" },
    });
    for (const client of [app, owner]) {
      const code = client === app ? "42501" : "23001";
      await expect(
        client.query(
          "UPDATE subscription_event_daily_supplement SET reason='changed' WHERE event_id=$1",
          [id],
        ),
      ).rejects.toMatchObject({ code });
      await expect(
        client.query("DELETE FROM subscription_event_daily_supplement WHERE event_id=$1", [id]),
      ).rejects.toMatchObject({ code });
    }
    await expect(
      owner.query("UPDATE subscription_event SET payload='{}' WHERE id=$1", [id]),
    ).rejects.toMatchObject({ code: "23001" });
    expect(
      (
        await app.query("SELECT id FROM subscription_event_daily_supplement WHERE event_id=$1", [
          id,
        ])
      ).rowCount,
    ).toBe(1);
  }
  await expect(owner.query("TRUNCATE subscription_event_daily_supplement")).rejects.toMatchObject({
    code: "23001",
  });
});
