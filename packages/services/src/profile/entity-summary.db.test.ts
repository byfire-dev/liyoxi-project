import { beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { createFactories, snapshotTables, useSeededDatabase } from "../testing/index.js";
import { complete, harness, submit } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { readEntityStoreProfileFacts } from "./index.js";

const db = useSeededDatabase("services", { max: 1 });
const SLOW = 120_000;
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, SLOW);
const TABLES = [
  "store",
  "store_profile",
  "qualification_submission",
  "approval_request",
  "dict_item",
  "file_ref",
  "audit_log",
  "status_transition",
  "outbox_event",
];
const EMPTY = {
  lastDecidedAt: null,
  reviewDueAt: null,
  openQualificationSubmissionId: null,
  address: { city: null, district: null, detail: null },
  copiedFromStoreId: null,
};
const read = (entityId: string, storeIds: readonly string[]) =>
  h.tx.run((tx) => readEntityStoreProfileFacts(tx, { entityId, storeIds }));

// 只构造符合原 CHECK/FK 的历史轮次，不宣称 new_store/change 写侧已经公开交付。
async function round(
  tx: Tx,
  store: { id: string; entityId: string },
  userId: string,
  kind: "initial" | "new_store" | "change",
  closed = false,
  approvalStore = store,
  hasDeadline = true,
) {
  const now = h.clock.now();
  const approval = await tx.approvalRequest.create({
    data: {
      id: uuidv7(),
      kind: "qualification",
      category: "review",
      subjectType: "store",
      subjectId: approvalStore.id,
      entityId: approvalStore.entityId,
      storeId: approvalStore.id,
      roundNo: 1,
      status: closed ? "withdrawn" : "pending",
      summarySnapshot: { title: "摘要历史事实" },
      submitActorType: "merchant",
      submitActorId: userId,
      submitClient: "weapp",
      submittedAt: now,
      ...(hasDeadline
        ? { dueAt: new Date(now.getTime() + 60_000), slaSnapshot: { minutes: 1 } }
        : {}),
      decidedAt: closed ? now : null,
      dedupeKey: `qualification:${store.id}`,
      createdAt: now,
      updatedAt: now,
    },
  });
  return tx.qualificationSubmission.create({
    data: {
      id: uuidv7(),
      entityId: store.entityId,
      storeId: store.id,
      kind,
      roundNo: 1,
      claimedEntityType: kind === "initial" ? "enterprise" : null,
      proposedStoreName: "虚构门店",
      proposedIndustryCode: "C900",
      proposedCategoryCode: "C901",
      proposedAddressSnapshot: { detail: "测试地址" },
      changedFields: kind === "change" ? ["docs"] : [],
      declarationConfirmedAt: now,
      declarationVersion: "1",
      approvalRequestId: approval.id,
      submittedAt: now,
      submittedByUserId: userId,
      closedAt: closed ? now : null,
      outcome: closed ? "withdrawn" : null,
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    },
  });
}

it(
  "空目标不查询也不冒称主体存在；缺档门店有完整nullable投影",
  async () => {
    await h.tx.run(async (tx) => {
      const query = vi.spyOn(tx.store, "findMany");
      try {
        expect(await readEntityStoreProfileFacts(tx, { entityId: uuidv7(), storeIds: [] })).toEqual(
          new Map(),
        );
        expect(query).not.toHaveBeenCalled();
      } finally {
        query.mockRestore();
      }
    });
    const world = await h.owner();
    expect(await read(world.entity.id, [world.store.id])).toEqual(
      new Map([[world.store.id, EMPTY]]),
    );
  },
  SLOW,
);

it.each(["foreign", "missing"] as const)(
  "%s 门店使整批NOT_FOUND，无部分摘要",
  async (kind) => {
    const world = await h.owner(),
      foreign = await h.owner();
    const id = kind === "foreign" ? foreign.store.id : uuidv7();
    await expect(read(world.entity.id, [world.store.id, id])).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
  },
  SLOW,
);

it(
  "真实公开提交前草稿排除，提交后返回实际审批到期与本轮ID",
  async () => {
    const world = await h.owner();
    const ready = await complete(h, world.viewer);
    expect((await read(world.entity.id, [world.store.id])).get(world.store.id)).toMatchObject({
      reviewDueAt: null,
      openQualificationSubmissionId: null,
    });
    await submit(h, world.viewer, ready.submissionId);
    const submission = await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: ready.submissionId },
    });
    const approval = await h.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: submission.approvalRequestId! },
    });
    expect(approval.dueAt).not.toBeNull();
    const before = await snapshotTables(h.prisma, TABLES);
    expect((await read(world.entity.id, [world.store.id])).get(world.store.id)).toMatchObject({
      openQualificationSubmissionId: ready.submissionId,
      reviewDueAt: approval.dueAt!.toISOString(),
    });
    expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
  },
  SLOW,
);

it.each(["initial", "new_store", "change"] as const)(
  "%s 只选已提交未关闭轮次，旧关闭轮次不污染",
  async (kind) => {
    const world = await h.owner();
    const closedStore = await h.make.store({ entityId: world.entity.id });
    const pending = await h.tx.run((tx) => round(tx, world.store, world.user.id, kind));
    await h.tx.run((tx) => round(tx, closedStore, world.user.id, kind, true));
    const result = await read(world.entity.id, [world.store.id, closedStore.id]);
    expect(result.get(world.store.id)).toEqual({
      ...EMPTY,
      openQualificationSubmissionId: pending.id,
      reviewDueAt: new Date(h.clock.now().getTime() + 60_000).toISOString(),
    });
    expect(result.get(closedStore.id)).toEqual(EMPTY);
  },
  SLOW,
);

it(
  "地址采用真实停用字典，缺词回落编码；去重批量且不读完整档案",
  async () => {
    const world = await h.owner();
    const source = await h.make.store({ entityId: world.entity.id });
    const cityCode = `C${uuidv7().replaceAll("-", "").slice(-15)}`,
      districtCode = `D${uuidv7().replaceAll("-", "").slice(-15)}`;
    await h.prisma.dictItem.create({
      data: {
        id: uuidv7(),
        dictTypeKey: "region",
        code: cityCode,
        name: `停用${uuidv7().slice(-6)}`,
        isEnabled: false,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const name = (
      await h.prisma.dictItem.findUniqueOrThrow({
        where: { dictTypeKey_code: { dictTypeKey: "region", code: cityCode } },
      })
    ).name;
    await h.prisma.storeProfile.create({
      data: {
        storeId: world.store.id,
        entityId: world.entity.id,
        lastDecidedAt: h.clock.now(),
        cityCode,
        districtCode,
        addressDetail: "真实历史地址",
        copiedFromStoreId: source.id,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    await h.tx.run(async (tx) => {
      const profileQuery = vi.spyOn(tx.storeProfile, "findMany"),
        dictQuery = vi.spyOn(tx.dictItem, "findMany");
      try {
        const ids = Object.freeze([world.store.id, world.store.id, source.id]);
        const result = await readEntityStoreProfileFacts(tx, {
          entityId: world.entity.id,
          storeIds: ids,
        });
        expect(result.size).toBe(2);
        expect(result.get(world.store.id)).toEqual({
          ...EMPTY,
          lastDecidedAt: h.clock.now().toISOString(),
          address: {
            city: { code: cityCode, name },
            district: { code: districtCode, name: districtCode },
            detail: "真实历史地址",
          },
          copiedFromStoreId: source.id,
        });
        expect(profileQuery).toHaveBeenCalledTimes(1);
        expect(dictQuery).toHaveBeenCalledTimes(1);
        expect(profileQuery.mock.calls[0]?.[0]?.select).toEqual({
          storeId: true,
          lastDecidedAt: true,
          cityCode: true,
          districtCode: true,
          addressDetail: true,
          copiedFromStoreId: true,
        });
        expect(ids).toEqual([world.store.id, world.store.id, source.id]);
      } finally {
        profileQuery.mockRestore();
        dictQuery.mockRestore();
      }
    });
  },
  SLOW,
);

it(
  "合法归档门店仍返回历史摘要，不按当前生命周期丢失证据",
  async () => {
    const world = await h.owner();
    const store = await h.make.store({
      entityId: world.entity.id,
      lifecycle: "archived",
      archivedAt: h.clock.now(),
      archiveActorType: "merchant",
      archiveActorId: world.user.id,
      archiveClient: "weapp",
      archiveReason: "by_owner",
    });
    await h.prisma.storeProfile.create({
      data: {
        storeId: store.id,
        entityId: world.entity.id,
        addressDetail: "归档前历史",
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    expect((await read(world.entity.id, [store.id])).get(store.id)).toEqual({
      ...EMPTY,
      address: { city: null, district: null, detail: "归档前历史" },
    });
  },
  SLOW,
);

it(
  "审批归属不一致明确INTERNAL，不返回其他门店期限",
  async () => {
    const world = await h.owner(),
      other = await h.owner();
    // 原单列 FK 允许该历史错配，读口必须显式核实际 subject/entity/store；不改 CHECK。
    await h.tx.run((tx) => round(tx, world.store, world.user.id, "initial", false, other.store));
    await expect(read(world.entity.id, [world.store.id])).rejects.toMatchObject({
      error: "INTERNAL",
    });
  },
  SLOW,
);

it(
  "实际审批允许空期限时仍返回当前轮次，不能误判没有在审",
  async () => {
    const world = await h.owner();
    const pending = await h.tx.run((tx) =>
      round(tx, world.store, world.user.id, "new_store", false, world.store, false),
    );
    expect((await read(world.entity.id, [world.store.id])).get(world.store.id)).toEqual({
      ...EMPTY,
      openQualificationSubmissionId: pending.id,
    });
  },
  SLOW,
);

it(
  "复用callerTx新档案与轮次，读取零写且外层回滚全撤销",
  async () => {
    const world = await h.owner();
    const before = await snapshotTables(h.prisma, TABLES),
      abort = new Error("摘要事务回滚");
    await expect(
      h.tx.run(async (tx) => {
        const make = createFactories({ db: tx, clock: h.clock });
        const store = await make.store({ entityId: world.entity.id });
        await tx.storeProfile.create({
          data: {
            storeId: store.id,
            entityId: world.entity.id,
            addressDetail: "未提交地址",
            createdAt: h.clock.now(),
            updatedAt: h.clock.now(),
          },
        });
        const pending = await round(tx, store, world.user.id, "new_store");
        const inside = await snapshotTables(tx, TABLES);
        expect(
          (
            await readEntityStoreProfileFacts(tx, {
              entityId: world.entity.id,
              storeIds: [store.id],
            })
          ).get(store.id),
        ).toMatchObject({
          address: { detail: "未提交地址" },
          openQualificationSubmissionId: pending.id,
        });
        expect(await snapshotTables(tx, TABLES)).toEqual(inside);
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
  },
  SLOW,
);
