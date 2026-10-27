import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";

import {
  assertTestDatabaseName,
  connectTestDatabase,
  dropTestDatabase,
  recordTestUsage,
  renameTestDatabase,
  testDatabaseName,
  testDatabaseUrl,
} from "./testing/index.js";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const oldMigrations = [
  "20261005000000_init",
  "20261005060000_grants",
  "20261007230600_analytics_partition_capability",
  "20261008162000_notification_fanout",
  "20261008183700_analytics_partition_retirement",
];
const migration = "20261011125031_invitation_request";
// 独立期望来自本轮仓库目录；后续新增迁移也必须由官方deploy实际执行。
const currentMigrations = readdirSync(join(pkg, "prisma/migrations"), { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory() ? [entry.name] : []))
  .sort();
const manifest = createRequire(import.meta.url).resolve("prisma/package.json");
const cli = join(
  dirname(manifest),
  (JSON.parse(readFileSync(manifest, "utf8")) as { bin: { prisma: string } }).bin.prisma,
);

// 官方 deploy 只认这个临时副本的固定五条旧迁移；不改仓库原迁移或公共支架。
function oldPackage(dir: string) {
  const copy = join(dir, "db");
  mkdirSync(join(copy, "prisma/migrations"), { recursive: true });
  for (const path of [
    "prisma/schema.prisma",
    "prisma/migrations/migration_lock.toml",
    "prisma.config.ts",
    "package.json",
  ])
    cpSync(join(pkg, path), join(copy, path));
  for (const name of oldMigrations)
    cpSync(join(pkg, "prisma/migrations", name), join(copy, "prisma/migrations", name), {
      recursive: true,
    });
  symlinkSync(join(pkg, "node_modules"), join(copy, "node_modules"), "dir");
  return copy;
}
function deploy(cwd: string, databaseUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "migrate", "deploy"], {
      cwd,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`邀请旧库官方 deploy 失败，退出码 ${code}：${output}`)),
    );
  });
}

describe("invitation_request 旧五迁移库升级", () => {
  it(
    "全部五种历史事实原列不变、A 精确回填，重跑 deploy 无待迁移",
    { timeout: 240_000 },
    async () => {
      expect(currentMigrations.slice(0, oldMigrations.length + 1)).toEqual([
        ...oldMigrations,
        migration,
      ]);
      const name = testDatabaseName("db", { label: "invreqmig" });
      assertTestDatabaseName(name);
      const url = testDatabaseUrl(name, { role: null });
      const maintenance = new URL(url);
      maintenance.pathname = "/postgres";
      maintenance.search = "";
      const admin = new pg.Client({ connectionString: maintenance.toString() });
      const dir = mkdtempSync(join(tmpdir(), "lyx-invitation-upgrade-"));
      let app: pg.Client | undefined,
        created = false,
        passed = false;
      const cleanupErrors: unknown[] = [];
      try {
        await admin.connect();
        await admin.query(`CREATE DATABASE "${name}"`);
        created = true;
        recordTestUsage("database", name);
        await deploy(oldPackage(dir), url);
        app = await connectTestDatabase(name);
        const inspect = await connectTestDatabase(name, { role: null });
        try {
          expect(
            (
              await inspect.query(
                "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name",
              )
            ).rows.map((row) => row.migration_name),
          ).toEqual(oldMigrations);
        } finally {
          await inspect.end();
        }
        expect(
          (await app.query("SELECT to_regclass('public.invitation_request') AS relation")).rows,
        ).toEqual([{ relation: null }]);
        expect((await app.query("SHOW session_replication_role")).rows).toEqual([
          { session_replication_role: "origin" },
        ]);
        const at = new Date("2026-10-10T10:00:00.123Z"),
          expires = new Date(at.getTime() + 86_400_000);
        const entityId = randomUUID(),
          storeId = randomUUID(),
          inviterId = randomUUID(),
          acceptedId = randomUUID();
        const inviterUser = randomUUID(),
          acceptedUser = randomUUID();
        for (const id of [inviterUser, acceptedUser])
          await app.query(
            `INSERT INTO merchant_user (id,status,source_type,phone_enc,phone_bidx,phone_mask,phone_last4,last_active_at,created_at,updated_at)
           VALUES ($1,'active','organic','fixture-cipher',$2,'138****0000','0000',$3,$3,$3)`,
            [id, randomBytes(32), at],
          );
        await app.query(
          `INSERT INTO entity (id,lifecycle,verification_status,source_type,created_by_user_id,created_at,updated_at)
         VALUES ($1,'active','unsubmitted','organic',$2,$3,$3)`,
          [entityId, inviterUser, at],
        );
        await app.query(
          "INSERT INTO store (id,entity_id,lifecycle,created_at,updated_at) VALUES ($1,$2,'active',$3,$3)",
          [storeId, entityId, at],
        );
        for (const [id, userId, role] of [
          [inviterId, inviterUser, "owner"],
          [acceptedId, acceptedUser, "clerk"],
        ])
          await app.query(
            "INSERT INTO entity_member (id,entity_id,merchant_user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',$5,$5)",
            [id, entityId, userId, role, at],
          );
        // shared 是 pending + shared_at；终态按原 CHECK 补齐关联字段并清 token_enc。
        for (const fact of ["pending", "shared", "accepted", "revoked", "expired"]) {
          await app.query(
            `INSERT INTO invitation
            (id,entity_id,store_id,role,inviter_member_id,token_hash,token_enc,remark_name,target_phone_bidx,
             status,shared_at,expires_at,accepted_at,accepted_by_user_id,accepted_member_id,
             revoked_at,revoke_actor_type,revoke_actor_id,revoke_client,revoke_reason,
             client_request_id,created_at,updated_at)
           VALUES ($1,$2,$3,'clerk',$4,$5,$6,'升级夹具',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)`,
            [
              randomUUID(),
              entityId,
              storeId,
              inviterId,
              randomBytes(32),
              ["pending", "shared"].includes(fact) ? "fixture-token" : null,
              randomBytes(32),
              fact === "shared" ? "pending" : fact,
              fact === "shared" ? at : null,
              expires,
              fact === "accepted" ? at : null,
              fact === "accepted" ? acceptedUser : null,
              fact === "accepted" ? acceptedId : null,
              fact === "revoked" ? at : null,
              fact === "revoked" ? "merchant" : null,
              fact === "revoked" ? inviterUser : null,
              fact === "revoked" ? "weapp" : null,
              fact === "revoked" ? "by_owner" : null,
              randomUUID(),
              at,
            ],
          );
        }
        const before = (
          await app.query("SELECT row_to_json(i)::text AS row FROM invitation i ORDER BY id")
        ).rows;
        expect(before).toHaveLength(5);
        const expected = (
          await app.query(
            `SELECT id,inviter_member_id,client_request_id,id AS invitation_id,entity_id,store_id,created_at
         FROM invitation ORDER BY id`,
          )
        ).rows;
        await deploy(pkg, url);
        expect(
          (await app.query("SELECT row_to_json(i)::text AS row FROM invitation i ORDER BY id"))
            .rows,
        ).toEqual(before);
        expect((await app.query("SELECT * FROM invitation_request ORDER BY id")).rows).toEqual(
          expected,
        );
        expect(await deploy(pkg, url)).toContain("No pending migrations to apply.");
        expect((await app.query("SELECT * FROM invitation_request ORDER BY id")).rows).toEqual(
          expected,
        );
        expect(
          (await app.query("SELECT row_to_json(i)::text AS row FROM invitation i ORDER BY id"))
            .rows,
        ).toEqual(before);
        const finalInspect = await connectTestDatabase(name, { role: null });
        try {
          expect(
            (
              await finalInspect.query(
                "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name",
              )
            ).rows.map((row) => row.migration_name),
          ).toEqual(currentMigrations);
        } finally {
          await finalInspect.end();
        }
        passed = true;
      } finally {
        for (const cleanup of [
          () => app?.end(),
          () => admin.end(),
          () => rmSync(dir, { recursive: true, force: true }),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (created && passed) {
          try {
            await dropTestDatabase(name);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (created && !passed) {
          let kept = `${name}_k${Date.now().toString(36)}`;
          try {
            await renameTestDatabase(name, kept);
          } catch {
            kept = name;
          }
          console.warn(`邀请旧库升级失败，保留测试库：${kept}（看完用 pnpm test:db:prune 清理）`);
        }
        if (cleanupErrors.length > 0 && !passed)
          console.warn("邀请旧库清理未全部完成；保留原升级失败原因");
      }
      if (cleanupErrors.length > 0)
        throw new AggregateError(cleanupErrors, "邀请升级测试资源未完整收尾");
    },
  );
});
