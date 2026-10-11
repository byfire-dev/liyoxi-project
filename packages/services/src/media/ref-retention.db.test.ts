import { createPrismaClient } from "@liyoxi/db";
import { testDatabaseUrl } from "@liyoxi/db/testing/standalone";
import type { UploadCategory } from "@liyoxi/shared/uploads";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvents } from "../events/index.js";
import { createTxRunner, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  useSeededDatabase,
} from "../testing/index.js";
import { createMedia } from "./index.js";
import type { Media, RefRetentionInput } from "./index.js";

const db = useSeededDatabase("services", { label: "refretention", max: 2 });
const clock = createClock();
const start = new Date("2024-02-29T04:00:00.000Z");
const day = 86_400_000;
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let make: ReturnType<typeof createFactories>;
let tx: ReturnType<typeof createTxRunner>;
let fake: ReturnType<typeof createFakeProviders>;
let media: Media;
let clockReads = 0;
beforeAll(async () => {
  prisma = await db.prisma();
  make = createFactories({ db: prisma, clock });
  tx = createTxRunner({ prisma, appEnv: "test" });
  fake = createFakeProviders({ clock });
  const assembly = assembleForTest({ entry: "worker" });
  const countedClock = {
    now: () => {
      clockReads++;
      return clock.now();
    },
  };
  media = createMedia({
    tx,
    clock: countedClock,
    assembly,
    storage: fake.storage,
    events: createEvents({ assembly, clock: countedClock, tx }),
  });
}, 120_000);
beforeEach(() => {
  clock.set(start);
  fake.storage.resetCalls();
});

async function owner() {
  const user = await make.merchantUser();
  const entity = await make.entity({ createdByUserId: user.id });
  const store = await make.store({ entityId: entity.id });
  return { user, entity, store };
}
async function fileFact(
  o: Awaited<ReturnType<typeof owner>>,
  category: UploadCategory = "profile_image",
  scopeType: "store" | "entity" | "platform" = "store",
) {
  return make.fileObject({
    category,
    bucket: category === "profile_image" ? "asset" : "secure",
    scopeType,
    entityId: scopeType === "platform" ? null : o.entity.id,
    storeId: scopeType === "store" ? o.store.id : null,
    uploadActorType: "merchant",
    uploadActorId: o.user.id,
    uploadClient: "weapp",
  });
}
async function logo() {
  const o = await owner();
  await prisma.storeProfile.create({
    data: { storeId: o.store.id, entityId: o.entity.id, createdAt: start, updatedAt: start },
  });
  const file = await fileFact(o);
  const input: RefRetentionInput = {
    fileId: file.id,
    refType: "store_profile",
    refId: o.store.id,
    role: "logo",
    entityId: o.entity.id,
    storeId: o.store.id,
  };
  await tx.run((t) => media.link(t, input));
  return { ...o, file, input };
}
async function docFact(
  docType: "business_license" | "branch_license" | "industry_permit" = "business_license",
  removed = false,
) {
  const o = await owner();
  const scope = docType === "business_license" ? "entity" : "store";
  const file = await fileFact(
    o,
    docType === "industry_permit" ? "kyc_permit" : "kyc_license",
    scope,
  );
  // 合法原表草稿事实，只验证正式引用释放守卫，不冒称资质 producer。
  const round = await prisma.qualificationSubmission.create({
    data: {
      id: uuidv7(),
      entityId: o.entity.id,
      storeId: o.store.id,
      kind: "initial",
      createdByUserId: o.user.id,
      createdAt: start,
      updatedAt: start,
    },
  });
  const doc = await prisma.qualificationDoc.create({
    data: {
      id: uuidv7(),
      entityId: o.entity.id,
      storeId: o.store.id,
      qualificationSubmissionId: round.id,
      docType,
      scope,
      permitType: docType === "industry_permit" ? "food_business" : null,
      fileId: file.id,
      origin: "uploaded",
      removedAt: removed ? start : null,
      uploadedByUserId: o.user.id,
      createdAt: start,
      updatedAt: start,
    },
  });
  const input: RefRetentionInput = {
    fileId: file.id,
    refType: "qualification_doc",
    refId: doc.id,
    role: "main",
    entityId: o.entity.id,
    storeId: o.store.id,
  };
  await tx.run((t) => media.link(t, input));
  return { ...o, file, input, doc };
}
const read = (input: RefRetentionInput) => tx.run((t) => media.readRefRetention(t, input));
const release = (input: RefRetentionInput, keepUntil: Date) =>
  tx.run((t) => media.release(t, { ...input, keepUntil }));
async function snapshot(fileId: string) {
  return {
    file: await prisma.fileObject.findUnique({ where: { id: fileId } }),
    refs: await prisma.fileRef.findMany({ where: { fileId }, orderBy: { id: "asc" } }),
    audits: await prisma.auditLog.count(),
    outbox: await prisma.outboxEvent.count(),
    history: await prisma.statusTransition.count(),
  };
}
async function releaseIfNeeded(t: Tx, input: RefRetentionInput, target: Date) {
  const fact = await media.readRefRetention(t, input);
  if (!fact) throw new Error("真实业务引用缺失");
  if (fact.state === "live" || fact.keepUntil.getTime() < target.getTime())
    await media.release(t, { ...input, keepUntil: target });
}

describe("媒体自然键留存事实公口", () => {
  it("live 与 released 日期判别准确，事实仅三列且重复读取业务零写/零 clock/零存储", async () => {
    const f = await logo();
    const live = { state: "live", releasedAt: null, keepUntil: null };
    const before = await snapshot(f.file.id),
      reads = clockReads;
    expect(await read(f.input)).toEqual(live);
    expect(await read(f.input)).toEqual(live);
    expect(await snapshot(f.file.id)).toEqual(before);
    expect(clockReads).toBe(reads);
    const target = new Date(start.getTime() + 180 * day);
    await release(f.input, target);
    const released = await snapshot(f.file.id),
      readsAfterRelease = clockReads;
    expect(await read(f.input)).toEqual({
      state: "released",
      releasedAt: start,
      keepUntil: target,
    });
    expect(await snapshot(f.file.id)).toEqual(released);
    expect(clockReads).toBe(readsAfterRelease);
    expect(fake.storage.calls).toEqual([]);
  });

  it("同文件不同 refType/refId 与同协议不同 role 精确隔离，合法缺引用返回 null 且零写", async () => {
    const f = await logo();
    const mediaId = uuidv7();
    const other = { ...f.input, refType: "store_profile_media", refId: mediaId, role: "main" };
    await prisma.storeProfileMedia.create({
      data: {
        id: mediaId,
        entityId: f.entity.id,
        storeId: f.store.id,
        mediaGroup: "door",
        position: 1,
        fileId: f.file.id,
        mediaKind: "image",
        createActorType: "merchant",
        createActorId: f.user.id,
        createClient: "weapp",
        createdAt: start,
        updatedAt: start,
      },
    });
    await tx.run((t) => media.link(t, other));
    await release(other, new Date(start.getTime() + 180 * day));
    expect(await read(f.input)).toHaveProperty("state", "live");
    expect(await read(other)).toHaveProperty("state", "released");
    const legal = await fileFact(f, "legal_doc", "platform");
    const version = await make.agreementVersion({
      status: "draft",
      sourceFileId: legal.id,
      pdfFileId: legal.id,
    });
    const source = {
      ...f.input,
      fileId: legal.id,
      refType: "agreement_version",
      refId: version.id,
      role: "source",
    };
    const pdf = { ...source, role: "pdf" };
    await tx.run(async (t) => {
      await media.link(t, source);
      await media.link(t, pdf);
      await media.release(t, { ...source, keepUntil: new Date(start.getTime() + 7 * day) });
    });
    expect(await read(source)).toHaveProperty("state", "released");
    expect(await read(pdf)).toHaveProperty("state", "live");
    const before = await snapshot(f.file.id),
      reads = clockReads;
    expect(await read({ ...f.input, refId: uuidv7() })).toBeNull();
    expect(await read({ ...other, refType: "qualification_doc" })).toBeNull();
    expect(await snapshot(f.file.id)).toEqual(before);
    expect(clockReads).toBe(reads);
    expect(fake.storage.calls).toEqual([]);
  });

  it("同主体跨店档案可读，跨主体、无归属与缺文件统一拒绝并保持零写", async () => {
    const f = await logo();
    const sibling = await make.store({ entityId: f.entity.id });
    const foreign = await owner();
    const before = await snapshot(f.file.id),
      reads = clockReads;
    expect(await read({ ...f.input, storeId: sibling.id })).toHaveProperty("state", "live");
    for (const input of [
      { ...f.input, entityId: foreign.entity.id, storeId: foreign.store.id },
      { ...f.input, entityId: null, storeId: null },
      { ...f.input, fileId: uuidv7() },
    ])
      await expect(read(input)).rejects.toMatchObject({ error: "FILE_NOT_AVAILABLE" });
    expect(await snapshot(f.file.id)).toEqual(before);
    expect(clockReads).toBe(reads);
    expect(fake.storage.calls).toEqual([]);
  });

  it.each(["branch_license", "industry_permit"] as const)(
    "%s 不跨门店，主体证照只核主体",
    async (kind) => {
      const f = await docFact(kind);
      const sibling = await make.store({ entityId: f.entity.id });
      const before = await snapshot(f.file.id);
      expect(await read(f.input)).toHaveProperty("state", "live");
      await expect(read({ ...f.input, storeId: sibling.id })).rejects.toMatchObject({
        error: "FILE_NOT_AVAILABLE",
      });
      expect(await snapshot(f.file.id)).toEqual(before);
      const entityDoc = await docFact();
      expect(await read({ ...entityDoc.input, storeId: null })).toHaveProperty("state", "live");
      await expect(read({ ...entityDoc.input, entityId: f.entity.id })).rejects.toMatchObject({
        error: "FILE_NOT_AVAILABLE",
      });
    },
  );

  it("平台文件不依赖主体/门店，非法登记在缺文件前拒绝且零写", async () => {
    const f = await logo();
    const file = await fileFact(f, "legal_doc", "platform");
    const version = await make.agreementVersion({
      agreementKey: "user",
      status: "draft",
      sourceFileId: file.id,
    });
    const input = {
      ...f.input,
      fileId: file.id,
      refType: "agreement_version",
      refId: version.id,
      role: "source",
    };
    await tx.run((t) => media.link(t, input));
    const before = await snapshot(file.id),
      reads = clockReads;
    expect(await read({ ...input, entityId: null, storeId: null })).toHaveProperty("state", "live");
    expect(await read({ ...input, entityId: uuidv7(), storeId: uuidv7() })).toHaveProperty(
      "state",
      "live",
    );
    for (const invalid of [
      { refType: "not_registered" },
      ...["not_registered", "__proto__", "toString", "constructor"].map((role) => ({ role })),
    ])
      await expect(read({ ...input, ...invalid, fileId: uuidv7() })).rejects.toBeInstanceOf(
        TypeError,
      );
    expect(await snapshot(file.id)).toEqual(before);
    expect(clockReads).toBe(reads);
    expect(fake.storage.calls).toEqual([]);
  });

  it("真实永久引用与有效资格证照可读，原 canRelease/永久写守卫仍拒绝且零写", async () => {
    const f = await docFact();
    const payment = await make.billingOrder({ entityId: f.entity.id });
    const receipt = await fileFact(f, "pay_receipt", "entity");
    const proof = await prisma.transferProof.create({
      data: {
        id: uuidv7(),
        entityId: f.entity.id,
        billingOrderId: payment.id,
        uploadNo: 1,
        fileId: receipt.id,
        uploadedByUserId: f.user.id,
        uploadedAt: start,
        reviewStatus: "pending",
        createdAt: start,
        updatedAt: start,
      },
    });
    const permanent = {
      ...f.input,
      fileId: receipt.id,
      refType: "transfer_proof",
      refId: proof.id,
    };
    await tx.run((t) => media.link(t, permanent));
    for (const input of [f.input, permanent]) {
      const before = await snapshot(input.fileId),
        reads = clockReads;
      expect(await read(input)).toHaveProperty("state", "live");
      expect(clockReads).toBe(reads);
      await expect(release(input, new Date(start.getTime() + 7 * day))).rejects.toMatchObject({
        error: "STATE_NOT_ALLOWED",
      });
      expect(await snapshot(input.fileId)).toEqual(before);
    }
    expect(fake.storage.calls).toEqual([]);
  });

  it.each(["stored", "deleting", "deleted"] as const)(
    "%s 与 block 历史事实可读，原 link 不绕过技术守卫",
    async (status) => {
      const f = await logo();
      await release(f.input, new Date(start.getTime() + 180 * day));
      await prisma.fileObject.update({
        where: { id: f.file.id },
        data: { status, deletedAt: status === "deleted" ? start : null, moderationState: "block" },
      });
      const before = await snapshot(f.file.id),
        reads = clockReads;
      expect(await read(f.input)).toHaveProperty("state", "released");
      await expect(tx.run((t) => media.link(t, f.input))).rejects.toMatchObject({
        error: "FILE_NOT_USABLE",
        details: { reason: status === "stored" ? "blocked" : "not_stored" },
      });
      expect(await snapshot(f.file.id)).toEqual(before);
      expect(clockReads).toBe(reads);
      expect(fake.storage.calls).toEqual([]);
    },
  );

  it("原七天释放可升级为 closedAt 加三日历年；更长旧值/同文件最大留存与 live 聚合保留", async () => {
    const f = await docFact("business_license", true);
    const sevenDays = new Date(start.getTime() + 7 * day);
    await release(f.input, sevenDays);
    expect(await read(f.input)).toEqual({
      state: "released",
      releasedAt: start,
      keepUntil: sevenDays,
    });
    const closedTarget = new Date(start);
    closedTarget.setUTCFullYear(closedTarget.getUTCFullYear() + 3);
    expect(closedTarget.toISOString()).toBe("2027-03-01T04:00:00.000Z");
    clock.advance(day);
    await tx.run((t) => releaseIfNeeded(t, f.input, closedTarget));
    expect(await read(f.input)).toEqual({
      state: "released",
      releasedAt: start,
      keepUntil: closedTarget,
    });
    const second = await prisma.qualificationDoc.create({
      data: {
        id: uuidv7(),
        entityId: f.entity.id,
        storeId: f.store.id,
        qualificationSubmissionId: f.doc.qualificationSubmissionId,
        docType: "business_license",
        scope: "entity",
        fileId: f.file.id,
        origin: "carried",
        carriedFromQualificationDocId: f.doc.id,
        removedAt: start,
        uploadedByUserId: f.user.id,
        createdAt: start,
        updatedAt: start,
      },
    });
    const other = { ...f.input, refId: second.id };
    await tx.run((t) => media.link(t, other));
    expect((await snapshot(f.file.id)).file?.purgeAfter).toBeNull();
    const longer = new Date("2028-04-01T04:00:00.000Z");
    await release(other, longer);
    await release(f.input, sevenDays);
    expect(await read(f.input)).toEqual({
      state: "released",
      releasedAt: start,
      keepUntil: closedTarget,
    });
    expect((await snapshot(f.file.id)).file?.purgeAfter).toEqual(longer);
    expect(fake.storage.calls).toEqual([]);
  });

  it.each([7, 180, "three_years"] as const)(
    "已覆盖 %s 目标后推进到目标外，读事实跳过晚到重复与较弱动作且零写",
    async (period) => {
      const f = period === 180 ? await logo() : await docFact("business_license", true);
      const target = new Date(start);
      if (period === "three_years") target.setUTCFullYear(target.getUTCFullYear() + 3);
      else target.setTime(target.getTime() + period * day);
      await tx.run((t) => releaseIfNeeded(t, f.input, target));
      clock.set(new Date(target.getTime() + 365 * day));
      const before = await snapshot(f.file.id),
        reads = clockReads;
      const weakerDays = period === "three_years" ? 180 : 7;
      for (const lateTarget of [target, new Date(start.getTime() + weakerDays * day)])
        await tx.run((t) => releaseIfNeeded(t, f.input, lateTarget));
      expect(await snapshot(f.file.id)).toEqual(before);
      expect(clockReads).toBe(reads);
      expect(fake.storage.calls).toEqual([]);
    },
  );

  it("首次迟消费仍执行原当前 clock 最低七天，稳定历史目标不能绕过原 release", async () => {
    const f = await docFact("business_license", true);
    clock.advance(60 * day);
    await tx.run((t) => releaseIfNeeded(t, f.input, new Date(start.getTime() + 7 * day)));
    expect(await read(f.input)).toEqual({
      state: "released",
      releasedAt: clock.now(),
      keepUntil: new Date(clock.now().getTime() + 7 * day),
    });
  });

  it("真实应有引用缺失由消费者明确失败，不凭 null 伪释放或创建引用", async () => {
    const f = await logo(),
      missing = { ...f.input, refId: uuidv7() };
    const before = await snapshot(f.file.id);
    await expect(tx.run((t) => releaseIfNeeded(t, missing, start))).rejects.toThrow(
      "真实业务引用缺失",
    );
    expect(await snapshot(f.file.id)).toEqual(before);
  });

  it("外层事务可读本次 released，sentinel 失败整笔回滚；下一事务正常释放", async () => {
    const f = await logo(),
      target = new Date(start.getTime() + 180 * day);
    const before = await snapshot(f.file.id);
    await expect(
      tx.run(async (t) => {
        await media.release(t, { ...f.input, keepUntil: target });
        expect(await media.readRefRetention(t, f.input)).toEqual({
          state: "released",
          releasedAt: start,
          keepUntil: target,
        });
        throw new Error("留存外层回滚");
      }),
    ).rejects.toThrow("留存外层回滚");
    expect(await snapshot(f.file.id)).toEqual(before);
    await tx.run((t) => releaseIfNeeded(t, f.input, target));
    expect(await read(f.input)).toHaveProperty("state", "released");
  });

  it("完整文件集预锁可逐项逆序重入，遗漏低 UUID 或回拿低阶业务锁仍由 kernel 拒绝", async () => {
    const first = await logo(),
      second = await logo();
    const inputs = [first.input, second.input].sort((a, b) => a.fileId.localeCompare(b.fileId));
    await tx.run(async (t) => {
      await lockRows(
        t,
        "file_object",
        inputs.map((input) => input.fileId),
      );
      for (const input of [...inputs].reverse())
        expect(await media.readRefRetention(t, input)).toHaveProperty("state", "live");
    });
    await expect(
      tx.run(async (t) => {
        await media.readRefRetention(t, inputs[1]!);
        await media.readRefRetention(t, inputs[0]!);
      }),
    ).rejects.toMatchObject({ kind: "lock_order" });
    await expect(
      tx.run(async (t) => {
        await media.readRefRetention(t, first.input);
        await lockRows(t, "store", [first.store.id]);
      }),
    ).rejects.toMatchObject({ kind: "lock_order" });
  });

  it("两个真实事务：读事实持 update 锁使原 release 等待，同事务再读一致，提交后才完成", async () => {
    const f = await logo(),
      target = new Date(start.getTime() + 180 * day);
    const observer = createPrismaClient({
      connectionString: testDatabaseUrl(db.name, { role: null }),
      max: 1,
    });
    let held!: () => void, unlock!: () => void, entered!: () => void;
    const locked = new Promise<void>((resolve) => {
      held = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let ownerPid = 0,
      waiterPid = 0;
    const holder = tx.run(async (t) => {
      ownerPid = (await t.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      const first = await media.readRefRetention(t, f.input);
      held();
      await gate;
      expect(await media.readRefRetention(t, f.input)).toEqual(first);
    });
    let writer: Promise<void> | undefined;
    try {
      await Promise.race([
        locked,
        holder.then(() => {
          throw new Error("持锁事务提前退出");
        }),
      ]);
      writer = tx.run(async (t) => {
        waiterPid = (await t.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        entered();
        await media.release(t, { ...f.input, keepUntil: target });
      });
      await Promise.race([
        waiting,
        writer.then(() => {
          throw new Error("等锁事务提前退出");
        }),
      ]);
      expect(waiterPid).not.toBe(ownerPid);
      await vi.waitFor(
        async () => {
          const [backend] = await observer.$queryRaw<
            { waiting: boolean; blockers: number[]; query: string }[]
          >`
          SELECT wait_event_type = 'Lock' AS waiting, pg_blocking_pids(pid) AS blockers, query
          FROM pg_stat_activity WHERE pid = ${waiterPid}`;
          expect(backend?.waiting).toBe(true);
          expect(backend?.blockers).toContain(ownerPid);
          expect(backend?.query).toContain('FROM "file_object"');
        },
        { timeout: 3000 },
      );
      unlock();
      await holder;
      await writer;
      expect(await read(f.input)).toEqual({
        state: "released",
        releasedAt: start,
        keepUntil: target,
      });
    } finally {
      unlock();
      await Promise.allSettled([holder, writer]);
      await observer.$disconnect();
    }
    expect(fake.storage.calls).toEqual([]);
  });
});
