import { beforeAll, describe, expect, it } from "vitest";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import type { FakeStorage, SignedInStaff } from "@liyoxi/services/testing";
import type {
  UploadBatchDetail,
  UploadBatchItemView,
  BatchUploadCredentials,
} from "@liyoxi/contract";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi();
let app: TestApi;
let db: Awaited<ReturnType<typeof handle.db.prisma>>;
let make: ReturnType<typeof createFactories>;
let owner: SignedInStaff, other: SignedInStaff, limited: SignedInStaff, editor: SignedInStaff;
let dramaId: string, itemId: string;
let storage: FakeStorage;
let peer = 0;
const base = "/api/v1/admin/upload-batches";
const itemBase = "/api/v1/admin/upload-batch-items";
const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
function request(
  path: string,
  body: unknown = {},
  staff = owner,
  key: string | null = uuidv7(),
  method = "POST",
) {
  return app.request(path, {
    method,
    json: body,
    headers: { ...staff.headers, ...(key === null ? {} : { "Idempotency-Key": key }) },
    peer: `198.19.139.${++peer}`,
  });
}
const draft = (name = "第1集.mp4", size = "8") => ({
  clientToken: uuidv7(),
  originalName: name,
  sizeBytes: size,
});
const masterBody = (files = [draft()], scope: "full" | "partial" = "partial") => ({
  purpose: "drama_master",
  targetId: dramaId,
  scope,
  files,
});
const create = (files = [draft()], scope: "full" | "partial" = "partial", staff = owner) =>
  request(base, masterBody(files, scope), staff).then(data<UploadBatchDetail>);
beforeAll(async () => {
  app = await handle.start();
  db = await handle.db.prisma();
  await runSeed({ tx: app.runtime.tx, clock: app.clock });
  make = createFactories({ db, clock: app.clock });
  owner = await signInAsStaff(db, { roleKey: "super_admin", now: app.clock.now() });
  other = await signInAsStaff(db, { roleKey: "super_admin", now: app.clock.now() });
  limited = await signInAsStaff(db, { roleKey: "finance", now: app.clock.now() });
  editor = await signInAsStaff(db, { roleKey: "editor", now: app.clock.now() });
  const drama = await make.drama({ totalEpisodes: 20 });
  dramaId = drama.id;
  for (let episodeNo = 1; episodeNo <= 20; episodeNo++)
    await make.dramaEpisode({ dramaId, episodeNo });
  const item = await make.orderItem({
    phase: "producing",
    dramaId,
    episodeCount: 20,
    dramaSnapshot: { dramaId, title: "虚构二十集" },
  });
  itemId = item.id;
  await make.deliveryTicket({
    orderItemId: itemId,
    step: "batch_compose",
    editorId: editor.staff.id,
  });
  storage = app.runtime.providers.storage as FakeStorage;
}, 180_000);

describe("W3-02 八接口实际生产pipeline", { timeout: 60_000 }, () => {
  it("八operationId真正挂载；真实20集总数、创建同键重放与GET无业务DML", async () => {
    expect(app.api.mountedOperations).toEqual(
      expect.arrayContaining([
        "admin.uploadBatch.create",
        "admin.uploadBatch.get",
        "admin.uploadBatch.start",
        "admin.uploadBatch.refreshCredentials",
        "admin.uploadBatch.cancel",
        "admin.uploadBatch.commit",
        "admin.uploadBatchItem.update",
        "admin.uploadBatchItem.complete",
      ]),
    );
    const body = masterBody(),
      key = uuidv7();
    const first = await data<UploadBatchDetail>(await request(base, body, owner, key));
    expect(first.expectedCount).toBe(20);
    expect(first.counts.total).toBe(1);
    expect(first.coverage.missingEpisodeNos).toEqual([]);
    const replay = await request(base, body, owner, key);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await data<UploadBatchDetail>(replay)).toEqual(first);
    const counts = () =>
      Promise.all([
        db.uploadBatch.count(),
        db.uploadBatchItem.count(),
        db.fileObject.count(),
        db.productionRecord.count(),
        db.fileRef.count(),
        db.mediaJob.count(),
        db.auditLog.count(),
        db.outboxEvent.count(),
      ]);
    const before = await counts();
    const read = await app.request(`${base}/${first.uploadBatchId}`, { headers: owner.headers });
    expect(read.headers.get("Cache-Control")).toBe("no-store");
    expect(await data<UploadBatchDetail>(read)).toEqual(first);
    expect(await counts()).toEqual(before);
  });
  it("required缺key与严格三选一先拒绝；ZIP/空/重名/超限清单零写", async () => {
    await error(await request(base, masterBody(), owner, null), 400, "IDEMPOTENCY_KEY_REQUIRED");
    const batch = await create();
    const item = batch.items[0]!;
    for (const [path, body, method] of [
      [`${base}/${batch.uploadBatchId}/start`, {}, "POST"],
      [`${base}/${batch.uploadBatchId}/cancel`, {}, "POST"],
      [`${base}/${batch.uploadBatchId}/commit`, {}, "POST"],
      [`${itemBase}/${item.uploadBatchItemId}/complete`, {}, "POST"],
      [`${itemBase}/${item.uploadBatchItemId}`, { episodeNo: 2 }, "PATCH"],
    ] as const)
      await error(await request(path, body, owner, null, method), 400, "IDEMPOTENCY_KEY_REQUIRED");
    await error(
      await request(
        `${itemBase}/${item.uploadBatchItemId}`,
        { episodeNo: 2, skip: true },
        owner,
        uuidv7(),
        "PATCH",
      ),
      400,
      "VALIDATION_FAILED",
    );
    const before = await db.uploadBatch.count();
    const files = await db.fileObject.count();
    for (const invalid of [
      [draft("archive.zip")],
      [draft("第1集.mp4", "99999999999999")],
      [draft(), draft()],
    ])
      await error(await request(base, masterBody(invalid)), 400, "BATCH_FILE_INVALID");
    await error(
      await request(base, masterBody([draft("第1集.mp4", "0")])),
      400,
      "VALIDATION_FAILED",
    );
    expect(await db.uploadBatch.count()).toBe(before);
    expect(await db.fileObject.count()).toBe(files);
  });
  it("full缺集不得开始，sequence必须人工接受；集号、跳过、替换使用真条目", async () => {
    const full = await create([draft()], "full");
    expect(full.expectedCount).toBe(20);
    expect(full.coverage.missingEpisodeNos).toHaveLength(19);
    await error(
      await request(`${base}/${full.uploadBatchId}/start`, {}),
      409,
      "BATCH_MATCH_INCOMPLETE",
    );
    const partial = await create([draft("第1集.mp4"), draft("第2集.mp4")]);
    await error(
      await request(
        `${itemBase}/${partial.items[0]!.uploadBatchItemId}`,
        { episodeNo: 2 },
        owner,
        uuidv7(),
        "PATCH",
      ),
      409,
      "BATCH_EPISODE_TAKEN",
    );
    const mapped = await data<UploadBatchDetail>(
      await request(
        `${itemBase}/${partial.items[0]!.uploadBatchItemId}`,
        { episodeNo: 3 },
        owner,
        uuidv7(),
        "PATCH",
      ),
    );
    expect(mapped.items.find((row) => row.fileId === partial.items[0]!.fileId)?.episodeNo).toBe(3);
    const skipped = await data<UploadBatchDetail>(
      await request(
        `${itemBase}/${partial.items[1]!.uploadBatchItemId}`,
        { skip: true },
        owner,
        uuidv7(),
        "PATCH",
      ),
    );
    expect(skipped.counts.skipped).toBe(1);
    const old = skipped.items.find((row) => row.episodeNo === 3)!;
    const replaced = await data<UploadBatchDetail>(
      await request(
        `${itemBase}/${old.uploadBatchItemId}`,
        { replacementFile: draft("第3集.mp4") },
        owner,
        uuidv7(),
        "PATCH",
      ),
    );
    expect(
      replaced.items.find((row) => row.uploadBatchItemId === old.uploadBatchItemId)?.state,
    ).toBe("replaced");
    expect(replaced.items.find((row) => row.state === "pending")?.fileId).not.toBe(old.fileId);
    expect((await db.fileObject.findUniqueOrThrow({ where: { id: old.fileId } })).status).toBe(
      "expired",
    );
    const sequences = await create(
      Array.from({ length: 20 }, (_, index) =>
        draft(`clip-${String.fromCharCode(65 + index)}.mp4`),
      ),
      "full",
    );
    expect(sequences.coverage.needsSequenceConfirm).toBe(true);
    await error(
      await request(`${base}/${sequences.uploadBatchId}/start`, {
        acceptSequenceSuggestion: false,
      }),
      409,
      "BATCH_MATCH_INCOMPLETE",
    );
    expect(
      (
        await data<UploadBatchDetail>(
          await request(`${base}/${sequences.uploadBatchId}/start`, {
            acceptSequenceSuggestion: true,
          }),
        )
      ).state,
    ).toBe("uploading");
  });
  it("none STS每次真实发放/no-store，非本人404/失权403，凭据不进幂等缓存", async () => {
    const batch = await create();
    await data(await request(`${base}/${batch.uploadBatchId}/start`, {}));
    const path = `${base}/${batch.uploadBatchId}/refresh-credentials`;
    const calls = storage.callsOf("issueSts").length;
    await error(await request(path, {}, other, null), 404, "NOT_FOUND");
    await error(await request(path, {}, limited, null), 404, "NOT_FOUND");
    const response = await request(path, {}, owner, null);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const first = await data<BatchUploadCredentials>(response);
    expect(first).toMatchObject({
      prefix: `incoming/b${batch.uploadBatchId}/`,
      chunkSize: 8388608,
      fileParallel: 3,
      chunkParallel: 4,
    });
    const second = await data<BatchUploadCredentials>(await request(path, {}, owner, null));
    expect(second.sts.sessionToken).not.toBe(first.sts.sessionToken);
    expect(storage.callsOf("issueSts")).toHaveLength(calls + 2);
    expect(
      await db.idempotencyRecord.count({
        where: { scope: "admin.uploadBatch.refreshCredentials" },
      }),
    ).toBe(0);
    const revoked = await signInAsStaff(db, { roleKey: "super_admin", now: app.clock.now() });
    const ownBatch = await create([draft()], "partial", revoked);
    await db.staff.update({
      where: { id: revoked.staff.id },
      data: { staffRoleKey: "finance", staffGroupId: null },
    });
    await error(
      await request(`${base}/${ownBatch.uploadBatchId}/start`, {}, revoked),
      403,
      "PERMISSION_DENIED",
    );
    expect(
      (await db.uploadBatch.findUniqueOrThrow({ where: { id: ownBatch.uploadBatchId } })).state,
    ).toBe("matching");
  });
  it("外scope GET藏404、不签STS；只有matching/ready取消，取消同键不重复写", async () => {
    const batch = await create();
    const calls = storage.callsOf("issueSts").length;
    await error(
      await app.request(`${base}/${batch.uploadBatchId}`, { headers: limited.headers }),
      404,
      "NOT_FOUND",
    );
    await error(
      await app.request(`${base}/${uuidv7()}`, { headers: owner.headers }),
      404,
      "NOT_FOUND",
    );
    expect(storage.callsOf("issueSts")).toHaveLength(calls);
    const uploading = await create();
    await data(await request(`${base}/${uploading.uploadBatchId}/start`, {}));
    await error(
      await request(`${base}/${uploading.uploadBatchId}/cancel`, {}),
      409,
      "STATE_NOT_ALLOWED",
    );
    const key = uuidv7();
    const canceled = await data<UploadBatchDetail>(
      await request(`${base}/${batch.uploadBatchId}/cancel`, {}, owner, key),
    );
    expect(canceled.state).toBe("canceled");
    const audits = await db.auditLog.count();
    const replay = await request(`${base}/${batch.uploadBatchId}/cancel`, {}, owner, key);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await data(replay)).toEqual(canceled);
    expect(await db.auditLog.count()).toBe(audits);
  });
  it("真实bad magic确认留下rejected；合法头仅promoting，不伪造ready/体检", async () => {
    const bad = await create();
    await data(await request(`${base}/${bad.uploadBatchId}/start`, {}));
    const badItem = bad.items[0]!;
    storage.put({ bucket: "media", key: badItem.uploadKey! }, new Uint8Array(8), "video/mp4");
    await error(
      await request(`${itemBase}/${badItem.uploadBatchItemId}/complete`, {}),
      400,
      "UPLOAD_REJECTED",
    );
    expect(await db.fileObject.findUniqueOrThrow({ where: { id: badItem.fileId } })).toMatchObject({
      status: "rejected",
      rejectReason: "bad_magic",
      confirmingUntil: null,
    });
    expect(
      await db.uploadBatchItem.findUniqueOrThrow({ where: { id: badItem.uploadBatchItemId } }),
    ).toMatchObject({ state: "rejected" });
    const good = await create();
    await data(await request(`${base}/${good.uploadBatchId}/start`, {}));
    const goodItem = good.items[0]!;
    storage.put({ bucket: "media", key: goodItem.uploadKey! }, mp4, "video/mp4");
    const key = uuidv7();
    const confirmed = await data<UploadBatchItemView>(
      await request(`${itemBase}/${goodItem.uploadBatchItemId}/complete`, {}, owner, key),
    );
    expect(confirmed.fileStatus).toBe("promoting");
    expect(
      await db.mediaJob.findUniqueOrThrow({ where: { dedupeKey: `promote:${goodItem.fileId}` } }),
    ).toMatchObject({
      kind: "promote",
      state: "queued",
      parentType: "upload_batch",
      parentId: good.uploadBatchId,
    });
    const heads = storage.callsOf("head").length;
    const replay = await request(
      `${itemBase}/${goodItem.uploadBatchItemId}/complete`,
      {},
      owner,
      key,
    );
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await data(replay)).toEqual(confirmed);
    expect(storage.callsOf("head")).toHaveLength(heads);
    expect(
      (await db.uploadBatch.findUniqueOrThrow({ where: { id: good.uploadBatchId } })).state,
    ).toBe("uploading");
  });
  it("成片需真实工单当前范围/AI声明，不能调用原片commit；原片未ready不得commit", async () => {
    const body = {
      purpose: "final_release",
      targetId: itemId,
      scope: "full",
      files: [draft()],
      aiUsage: { used: false, tools: [] },
    };
    await error(await request(base, { ...body, aiUsage: null }, editor), 400, "VALIDATION_FAILED");
    const batch = await data<UploadBatchDetail>(await request(base, body, editor));
    expect(batch).toMatchObject({
      expectedCount: 20,
      aiUsage: { declaredBy: editor.staff.id, used: false },
    });
    await error(
      await request(`${base}/${batch.uploadBatchId}/commit`, {}, editor),
      403,
      "PERMISSION_DENIED",
    );
    // A holder with both actual permissions reaches the purpose guard without any fake ready state.
    const adminItem = await make.orderItem({
      phase: "producing",
      dramaId,
      episodeCount: 20,
      dramaSnapshot: { title: "虚构二十集", dramaId },
    });
    await make.deliveryTicket({
      orderItemId: adminItem.id,
      step: "batch_compose",
      editorId: owner.staff.id,
    });
    const final = await data<UploadBatchDetail>(
      await request(base, { ...body, targetId: adminItem.id }),
    );
    await error(
      await request(`${base}/${final.uploadBatchId}/commit`, {}),
      409,
      "BATCH_PURPOSE_MISMATCH",
    );
    const master = await create();
    await error(
      await request(`${base}/${master.uploadBatchId}/commit`, {}),
      409,
      "STATE_NOT_ALLOWED",
    );
  });
});
