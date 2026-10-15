import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestStaffAuth } from "@liyoxi/services/testing";
import { createTestStaffAuth, useSeededDatabase } from "@liyoxi/services/testing";
import { runStaffReissueActivation } from "../src/cli/staff-reissue-activation-command.js";
const SLOW = 180_000;
const db = useSeededDatabase("worker", { label: "reissue" });
const dir = mkdtempSync(join(tmpdir(), "lyx-staff-reissue-"));
const bytes = (n: number) => Buffer.alloc(32, n).toString("base64");
function file(name: string, data: unknown) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(data), { mode: 0o600 });
  return p;
}
const files = {
  DATA_KEYS_FILE: file("data.json", { current: "t1", keys: { t1: bytes(0x74) } }),
  BIDX_KEYS_FILE: file("bidx.json", { phone: bytes(0x75), uscc: bytes(0x76) }),
  AUTH_KEYS_FILE: file("auth.json", {
    ticket: bytes(0x71),
    device: bytes(0x72),
    mfa: { current: "t1", keys: { t1: bytes(0x73) } },
  }),
};
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let source: Record<string, string | undefined>,
  staffId: string,
  staffNo: number,
  oldCode: string,
  auth: TestStaffAuth;
beforeAll(async () => {
  const p = await db.prisma();
  auth = createTestStaffAuth(p);
  const b = await auth.staff.bootstrap({ name: "首位管理员", phone: "13900024001" });
  staffId = b.staffId;
  staffNo = b.staffNo;
  oldCode = b.activationCode;
  source = {
    APP_ENV: "test",
    DATABASE_URL: await db.url(),
    REDIS_URL: process.env.REDIS_URL,
    ...files,
  };
}, SLOW);
async function run(argv: string[], env = source) {
  const out: string[] = [],
    err: string[] = [];
  const exit = await runStaffReissueActivation({
    argv,
    source: env,
    out: (x) => out.push(x),
    err: (x) => err.push(x),
  });
  return { exit, out, err, text: [...out, ...err].join("\n") };
}
const args = () => ["--staff-id", staffId, "--confirm-staff-no", String(staffNo)];
describe("staff_reissue_activation / 过期首管理员受限补发CLI", { timeout: SLOW }, () => {
  it("缺参数/未知参数不打开运行时；未显式prod允许在连接前拒绝", async () => {
    expect((await run([])).exit).toBe(1);
    expect((await run(["--not-owned"])).exit).toBe(1);
    const databaseFile = join(dir, "database.url"),
      redisFile = join(dir, "redis.url");
    writeFileSync(databaseFile, source.DATABASE_URL!, { mode: 0o600 });
    writeFileSync(redisFile, source.REDIS_URL!, { mode: 0o600 });
    const prod = await run(args(), {
      ...source,
      APP_ENV: "prod",
      DATABASE_URL: undefined,
      REDIS_URL: undefined,
      DATABASE_URL_FILE: databaseFile,
      REDIS_URL_FILE: redisFile,
    });
    expect(prod.exit).toBe(1);
    expect(prod.out).toEqual([]);
    expect(prod.text).toContain("生产补发必须显式授权");
  });
  it("确认工号错误拒绝、不泄露配置或激活码，保持旧行", async () => {
    const before = await (await db.prisma()).staffActivation.count();
    const bad = await run(["--staff-id", staffId, "--confirm-staff-no", String(staffNo + 1)]);
    expect(bad.exit).toBe(1);
    expect(bad.out).toEqual([]);
    expect(await (await db.prisma()).staffActivation.count()).toBe(before);
    for (const secret of [source.DATABASE_URL!, source.DATA_KEYS_FILE!, "13900024001"]) {
      expect(bad.text).not.toContain(secret);
    }
  });
  it("真实bootstrap历史且未激活过期才补发，8码只输出一次24h，第二次未过期拒绝", async () => {
    const p = await db.prisma();
    await p.staffActivation.updateMany({
      where: { staffId, usedAt: null, revokedAt: null },
      data: {
        createdAt: new Date("2019-12-31T00:00:00Z"),
        expiresAt: new Date("2020-01-01T00:00:00Z"),
      },
    });
    const first = await run(args());
    expect(first.exit, first.text).toBe(0);
    const code = /激活码：([A-Z0-9]{8})/.exec(first.text)?.[1];
    expect(code).toBeDefined();
    expect(first.text.split(code!)).toHaveLength(2);
    const row = await p.staffActivation.findFirstOrThrow({
      where: { staffId, usedAt: null, revokedAt: null },
    });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(86_400_000);
    expect((await run(args())).exit).toBe(1);
    expect(
      await p.auditLog.count({
        where: { action: "sys.staff.reissue_activation_code", targetId: staffId },
      }),
    ).toBe(1);
    auth.clock.set(new Date(row.createdAt.getTime() + 1));
    await expect(
      auth.staff.activate({ phone: "13900024001", activationCode: oldCode }),
    ).rejects.toMatchObject({ error: "AUTH_FAILED" });
    expect(
      await auth.staff.activate({ phone: "13900024001", activationCode: code! }),
    ).toMatchObject({ next: "set_password" });
  });
});
