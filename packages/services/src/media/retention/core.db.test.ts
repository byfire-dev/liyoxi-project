import { createSessionMutexConnectionFactory } from "@liyoxi/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as audit from "../../audit/index.js";
import { createEvents } from "../../events/index.js";
import {
  createIdempotencyContext,
  createIdentityContext,
  createSessionMutex,
  createTxRunner,
  uuidv7,
} from "../../kernel/index.js";
import { failed } from "../../providers/types.js";
import type { ObjectRef } from "../../providers/types.js";
import {
  assembleForTest,
  configTestStaffBriefs,
  createClock,
  createFactories,
  createFakeProviders,
  sampleStaffContext,
  signInAsStaff,
  useSeededDatabase,
} from "../../testing/index.js";
import { createMedia } from "../index.js";
import type { Media } from "../index.js";
import type { RetentionActor } from "./options.js";

const db = useSeededDatabase("services", { label: "retcore", max: 1 });
const clock = createClock(),
  fake = createFakeProviders({ clock });
let prisma: Awaited<ReturnType<typeof db.prisma>>,
  make: ReturnType<typeof createFactories>,
  media: Media;
let mutex: ReturnType<typeof createSessionMutex>, actor: RetentionActor;
let tx: ReturnType<typeof createTxRunner>;
const notices: unknown[] = [];
const DAY = 86_400_000;
const restoreBody = { reason: "隔离测试申请恢复文件" };
const eraseBody = (id: string, category = "poster") => ({
  reason: "隔离测试受理个人信息彻删申请",
  confirm: { fileId: id, category },
});
const idem = (op: "restore" | "erase", id: string, body: unknown, key = uuidv7()) => ({
  idem: createIdempotencyContext({
    mode: "required",
    scope: `admin.file.${op}`,
    actor: actor.identity.actor,
    key,
    request: { method: "POST", pathParams: { fileId: id }, body, storeId: null },
  }),
});
const refOf = (file: { bucket: string; objectKey: string }): ObjectRef => ({
  bucket: file.bucket as ObjectRef["bucket"],
  key: file.objectKey,
});
function gate() {
  let open!: () => void;
  const ready = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { ready, open };
}
beforeAll(async () => {
  prisma = await db.prisma();
  make = createFactories({ db: prisma, clock });
  tx = createTxRunner({ prisma, appEnv: "test" });
  const assembly = assembleForTest({ entry: "api" });
  mutex = createSessionMutex({
    connect: createSessionMutexConnectionFactory({ connectionString: await db.url() }),
    maxConcurrent: 1,
    probeMs: 50,
  });
  fake.storage.capabilities.versioning = true;
  media = createMedia({
    tx,
    clock,
    assembly,
    storage: fake.storage,
    events: createEvents({ tx, clock, assembly }),
    retention: {
      sessionMutex: mutex,
      alerts: {
        raise: async (input) => {
          notices.push(input);
        },
      },
      staffBriefs: configTestStaffBriefs,
    },
  });
  const signed = await signInAsStaff(prisma, { roleKey: "super_admin", now: clock.now() });
  actor = {
    identity: createIdentityContext({
      actor: { type: "staff", id: signed.staff.id, client: "admin" },
    }),
    staff: await sampleStaffContext(prisma, signed.staff.id, { stepUpAt: clock.now() }),
    meta: {
      requestId: "lyxtest-retention",
      sessionId: signed.sessionId,
      authMethod: "password+totp",
      ip: "192.0.2.76",
      userAgent: "lyxtest retention",
    },
  };
}, 120_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await mutex?.close();
});

async function file(input: Parameters<typeof make.fileObject>[0] = {}, deleted = true, age = DAY) {
  const old = new Date(clock.now().getTime() - age - DAY),
    at = new Date(clock.now().getTime() - age);
  const row = await make.fileObject({
    originalName: "虚构文件.jpg",
    storedAt: old,
    createdAt: old,
    status: deleted ? "deleted" : "stored",
    deletedAt: deleted ? at : null,
    purgeAfter: deleted ? at : null,
    sizeBytes: 8n,
    declaredSize: 8n,
    ...input,
  });
  fake.storage.put(refOf(row), new Uint8Array(8), row.mime ?? "image/jpeg");
  if (deleted) expect((await fake.storage.delete(refOf(row))).ok).toBe(true);
  return row;
}
async function hidden(row: { bucket: string; objectKey: string }) {
  expect(await fake.storage.head(refOf(row))).toMatchObject({ ok: true, value: { exists: false } });
}

describe("W3-06保留核心六组真实DB风险", { timeout: 60_000 }, () => {
  it("恢复窗口严格按桶/真实删除时刻，边界可恢复且同键只审计一次", async () => {
    for (const [bucket, days] of [
      ["secure", 90],
      ["pub", 30],
    ] as const) {
      const row = await file({ bucket }, true, days * DAY),
        key = uuidv7();
      const result = await media.retention.restore(
        actor,
        row.id,
        restoreBody,
        idem("restore", row.id, restoreBody, key),
      );
      expect(result).toMatchObject({ status: "stored", deletedAt: null, purgeAfter: null });
      const calls = fake.storage.calls.filter((c) => c.method === "restoreVersions").length;
      expect(
        await media.retention.restore(
          actor,
          row.id,
          restoreBody,
          idem("restore", row.id, restoreBody, key),
        ),
      ).toEqual(result);
      expect(fake.storage.calls.filter((c) => c.method === "restoreVersions")).toHaveLength(calls);
      expect(
        await prisma.auditLog.count({ where: { targetId: row.id, action: "files.file.restore" } }),
      ).toBe(1);
      const expired = await file({ bucket }, true, days * DAY + 1);
      await expect(
        media.retention.restore(
          actor,
          expired.id,
          restoreBody,
          idem("restore", expired.id, restoreBody),
        ),
      ).rejects.toMatchObject({
        error: "FILE_RESTORE_WINDOW_PASSED",
        details: { deletedAt: expired.deletedAt!.toISOString() },
      });
      await hidden(expired);
    }
  });

  it("移除marker后应答未知和真实settle回滚都补回marker，原错误/历史/审计保持", async () => {
    const original = fake.storage.restoreVersions.bind(fake.storage);
    const unknown = await file();
    vi.spyOn(fake.storage, "restoreVersions").mockImplementationOnce(async (input) => {
      expect((await original(input)).ok).toBe(true);
      return failed("unavailable", "虚构最终HEAD超时");
    });
    await expect(
      media.retention.restore(
        actor,
        unknown.id,
        restoreBody,
        idem("restore", unknown.id, restoreBody),
      ),
    ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
    expect((await prisma.fileObject.findUniqueOrThrow({ where: { id: unknown.id } })).status).toBe(
      "deleted",
    );
    await hidden(unknown);
    expect(await prisma.auditLog.count({ where: { targetId: unknown.id } })).toBe(0);
    vi.restoreAllMocks();
    const rollback = await file(),
      boom = new Error("lyxtest audit settle rollback");
    vi.spyOn(audit, "record").mockRejectedValueOnce(boom);
    await expect(
      media.retention.restore(
        actor,
        rollback.id,
        restoreBody,
        idem("restore", rollback.id, restoreBody),
      ),
    ).rejects.toBe(boom);
    expect(
      (await prisma.fileObject.findUniqueOrThrow({ where: { id: rollback.id } })).deletedAt,
    ).toEqual(rollback.deletedAt);
    await hidden(rollback);
    expect(await prisma.auditLog.count({ where: { targetId: rollback.id } })).toBe(0);
    expect(notices).toEqual([]);
  });

  it("彻删外呼失败停deleting；占用过期同键接续清全版本并只留一次审计", async () => {
    const row = await file({}, false),
      body = eraseBody(row.id),
      key = uuidv7();
    fake.storage.failNext("eraseVersions", { reason: "unavailable" });
    await expect(
      media.retention.erase(actor, row.id, body, idem("erase", row.id, body, key)),
    ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
    expect((await prisma.fileObject.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      "deleting",
    );
    await expect(
      media.retention.restore(actor, row.id, restoreBody, idem("restore", row.id, restoreBody)),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    clock.advance(31_000);
    const result = await media.retention.erase(
      actor,
      row.id,
      body,
      idem("erase", row.id, body, key),
    );
    expect(result).toMatchObject({
      status: "deleted",
      originalName: null,
      restorableUntil: null,
      erasedAt: clock.now().toISOString(),
    });
    await hidden(row);
    expect(
      await fake.storage.restoreVersions({ ...refOf(row), signal: new AbortController().signal }),
    ).toMatchObject({ ok: false, reason: "rejected" });
    expect(
      await media.retention.erase(actor, row.id, body, idem("erase", row.id, body, key)),
    ).toEqual(result);
    expect(
      await prisma.auditLog.count({ where: { targetId: row.id, action: "files.file.erase" } }),
    ).toBe(1);
  });

  it("live/保留期/缺file_ref真实业务Logo均拒绝，合法释放到期裸文件可删", async () => {
    const store = await make.store();
    for (const kind of ["live", "retained", "missing"] as const) {
      const row = await file(
        {
          bucket: "asset",
          category: "profile_image",
          scopeType: "store",
          entityId: store.entityId,
          storeId: store.id,
        },
        false,
      );
      if (kind === "missing")
        await prisma.storeProfile.create({
          data: {
            storeId: store.id,
            entityId: store.entityId,
            logoFileId: row.id,
            createdAt: clock.now(),
            updatedAt: clock.now(),
          },
        });
      else
        await prisma.fileRef.create({
          data: {
            id: uuidv7(),
            fileId: row.id,
            refType: "store_profile",
            refId: store.id,
            role: "logo",
            state: kind === "live" ? "live" : "released",
            releasedAt: kind === "live" ? null : clock.now(),
            keepUntil: kind === "live" ? null : new Date(clock.now().getTime() + DAY),
            createdAt: clock.now(),
            updatedAt: clock.now(),
          },
        });
      const before = fake.storage.calls.filter((c) => c.method === "eraseVersions").length;
      await expect(
        media.retention.erase(
          actor,
          row.id,
          eraseBody(row.id, row.category),
          idem("erase", row.id, eraseBody(row.id, row.category)),
        ),
      ).rejects.toMatchObject({
        error: "FILE_IN_USE",
        details: { refs: [{ refType: "store_profile", refId: store.id }] },
      });
      expect(fake.storage.calls.filter((c) => c.method === "eraseVersions")).toHaveLength(before);
      expect((await prisma.fileObject.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
        "stored",
      );
    }
    const released = await file({}, false);
    await prisma.fileRef.create({
      data: {
        id: uuidv7(),
        fileId: released.id,
        refType: "store_profile",
        refId: uuidv7(),
        role: "logo",
        state: "released",
        releasedAt: new Date(clock.now().getTime() - 31 * DAY),
        keepUntil: new Date(clock.now().getTime() - DAY),
        createdAt: new Date(clock.now().getTime() - 31 * DAY),
        updatedAt: clock.now(),
      },
    });
    expect(
      (
        await media.retention.erase(
          actor,
          released.id,
          eraseBody(released.id),
          idem("erase", released.id, eraseBody(released.id)),
        )
      ).status,
    ).toBe("deleted");
  });

  it("互斥忙时C49区分同键处理中/改体/完成，新键拒绝无占用/外呼", async () => {
    const row = await file(),
      key = uuidv7(),
      entered = gate(),
      release = gate();
    const original = fake.storage.restoreVersions.bind(fake.storage);
    vi.spyOn(fake.storage, "restoreVersions").mockImplementationOnce(async (input) => {
      const result = await original(input);
      entered.open();
      await release.ready;
      return result;
    });
    const first = media.retention.restore(
      actor,
      row.id,
      restoreBody,
      idem("restore", row.id, restoreBody, key),
    );
    try {
      await Promise.race([entered.ready, first]);
      await expect(
        media.retention.restore(
          actor,
          row.id,
          restoreBody,
          idem("restore", row.id, restoreBody, key),
        ),
      ).rejects.toMatchObject({ error: "IDEMPOTENCY_IN_PROGRESS" });
      const changed = { reason: "不同内容的隔离测试恢复理由" };
      await expect(
        media.retention.restore(actor, row.id, changed, idem("restore", row.id, changed, key)),
      ).rejects.toMatchObject({ error: "IDEMPOTENCY_KEY_REUSED" });
      const freshKey = uuidv7();
      await expect(
        media.retention.restore(
          actor,
          row.id,
          restoreBody,
          idem("restore", row.id, restoreBody, freshKey),
        ),
      ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
      expect(
        await prisma.idempotencyRecord.count({
          where: { scope: "admin.file.restore", key: freshKey },
        }),
      ).toBe(0);
      release.open();
      const result = await first;
      const busy = gate(),
        finishBusy = gate();
      const holding = mutex.run("lyxtest:capacity", async () => {
        busy.open();
        await finishBusy.ready;
      });
      try {
        await busy.ready;
        expect(
          await media.retention.restore(
            actor,
            row.id,
            restoreBody,
            idem("restore", row.id, restoreBody, key),
          ),
        ).toEqual(result);
      } finally {
        finishBusy.open();
        await holding;
      }
      expect(
        fake.storage.calls.filter(
          (c) => c.method === "restoreVersions" && (c.input as ObjectRef).key === row.objectKey,
        ),
      ).toHaveLength(1);
      expect(
        await prisma.auditLog.count({ where: { targetId: row.id, action: "files.file.restore" } }),
      ).toBe(1);
    } finally {
      release.open();
      await first.catch(() => undefined);
    }
  });

  it("提交后实际ZIP失效与media_info封面释放，保留原30天且锁序不反转", async () => {
    const source = await file(
      {
        category: "trailer_src",
        bucket: "media",
        ext: "mp4",
        declaredMime: "video/mp4",
        mime: "video/mp4",
      },
      false,
    );
    const zip = await file(
      {
        category: "package_zip",
        bucket: "media",
        ext: "zip",
        declaredMime: "application/zip",
        mime: "application/zip",
      },
      false,
    );
    const list = await file(
      {
        category: "publish_list",
        bucket: "media",
        ext: "txt",
        declaredMime: "text/plain",
        mime: "text/plain",
      },
      false,
    );
    const cover = await file({ category: "video_cover", bucket: "asset" }, false);
    await prisma.mediaInfo.create({
      data: {
        fileId: source.id,
        kind: "image",
        coverFileId: cover.id,
        probeVersion: 1,
        raw: {},
        probedAt: clock.now(),
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    await tx.run((handle) =>
      media.link(handle, {
        fileId: cover.id,
        entityId: null,
        storeId: null,
        refType: "media_info",
        refId: source.id,
        role: "cover",
      }),
    );
    const bundle = await prisma.zipBundle.create({
      data: {
        id: uuidv7(),
        ownerType: "delivery_release",
        ownerId: uuidv7(),
        zipState: "ready",
        zipFileId: zip.id,
        publishListFileId: list.id,
        zipGen: 2,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    for (const row of [source, zip])
      await media.retention.erase(
        actor,
        row.id,
        eraseBody(row.id, row.category),
        idem("erase", row.id, eraseBody(row.id, row.category)),
      );
    const current = await prisma.zipBundle.findUniqueOrThrow({ where: { id: bundle.id } });
    expect(current).toMatchObject({
      zipState: "none",
      zipGen: 3,
      zipFileId: null,
      publishListFileId: null,
    });
    const ref = await prisma.fileRef.findUniqueOrThrow({
      where: {
        fileId_refType_refId_role: {
          fileId: cover.id,
          refType: "media_info",
          refId: source.id,
          role: "cover",
        },
      },
    });
    expect(ref).toMatchObject({
      state: "released",
      releasedAt: clock.now(),
      keepUntil: new Date(clock.now().getTime() + 30 * DAY),
    });
    expect(
      (await prisma.fileObject.findUniqueOrThrow({ where: { id: cover.id } })).purgeAfter,
    ).toEqual(ref.keepUntil);
    expect((await prisma.fileObject.findUniqueOrThrow({ where: { id: list.id } })).status).toBe(
      "stored",
    );
  });
});
