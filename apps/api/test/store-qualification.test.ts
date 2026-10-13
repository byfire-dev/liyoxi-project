import { beforeAll, describe, expect, it } from "vitest";
import { AdminStoreQualificationViewSchema } from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import {
  signInAsStaff,
  sampleStaffContext,
  snapshotTables,
  assertSnapshotsEqual,
} from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { complete, harness, submit } from "./admin-profile-fixtures.js";
import type { Harness } from "./admin-profile-fixtures.js";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi();
let api: TestApi, h: Harness, admin: SignedInStaff, manager: SignedInStaff;
let peer = 0;
const tables = [
  "entity",
  "store",
  "store_profile",
  "qualification_submission",
  "qualification_doc",
  "approval_request",
  "file_ref",
  "audit_log",
  "outbox_event",
];
beforeAll(async () => {
  api = await handle.start();
  h = harness(api, await handle.db.prisma());
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  admin = await signInAsStaff(h.prisma, { roleKey: "super_admin" });
  manager = await signInAsStaff(h.prisma, { roleKey: "delivery_manager" });
}, 120000);
const get = (storeId: string, staff = admin) =>
  api.request(`/api/v1/admin/stores/${storeId}/qualification`, {
    headers: staff.headers,
    peer: `198.19.213.${++peer}`,
  });
async function read(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return AdminStoreQualificationViewSchema.parse(
    ((await response.json()) as { data: unknown }).data,
  );
}
async function pending() {
  const owner = await h.owner();
  const ready = await complete(h, owner.viewer);
  await submit(h, owner.viewer, ready.submissionId);
  return { ...owner, ...ready };
}
async function approve(id: string) {
  const response = await api.request(`/api/v1/admin/qualification-submissions/${id}/approve`, {
    method: "POST",
    headers: { ...admin.headers, "Idempotency-Key": uuidv7() },
    json: { lockVersion: 0, confirm: { roundNo: 1 }, confirmChecks: ["license"] },
    peer: `198.19.213.${++peer}`,
  });
  expect(response.status, await response.clone().text()).toBe(200);
}
describe("W2-11资质页签真实HTTP", { timeout: 60000 }, () => {
  it("admin.store.qualification.get 挂载、模块/当前范围及空档案GET零写", async () => {
    expect(HANDLERS.some((v) => v.route.operationId === "admin.store.qualification.get")).toBe(
      true,
    );
    const owner = await h.owner();
    const before = await snapshotTables(h.prisma, tables);
    expect(await read(await get(owner.store.id))).toMatchObject({
      storeId: owner.store.id,
      qualificationStatus: "unsubmitted",
      effectiveDocs: [],
      rounds: [],
      openRound: null,
      firstSubmittedAt: null,
      firstVerifiedAt: null,
      lastDecidedAt: null,
      isFinalRejected: false,
      isChangeInReview: false,
    });
    expect((await get(owner.store.id, manager)).status).toBe(404);
    expect((await get(uuidv7())).status).toBe(404);
    expect((await get("bad-id")).status).toBe(400);
    expect((await api.request(`/api/v1/admin/stores/${owner.store.id}/qualification`)).status).toBe(
      401,
    );
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
    await h.prisma.store.update({
      where: { id: owner.store.id },
      data: { deliveryManagerId: manager.staff.id },
    });
    expect((await read(await get(owner.store.id, manager))).storeId).toBe(owner.store.id);
    const current = await sampleStaffContext(h.prisma, manager.staff.id);
    await h.prisma.staffRole.update({
      where: { key: "delivery_manager" },
      data: { moduleLevels: { ...current.moduleLevels, merchant: "n" } },
    });
    try {
      expect((await get(owner.store.id, manager)).status).toBe(403);
    } finally {
      await h.prisma.staffRole.update({
        where: { key: "delivery_manager" },
        data: { moduleLevels: current.moduleLevels },
      });
    }
  });

  it("真实提交/通过及变更在审按时间排序，草稿和丢弃不出现，生效证照与历史保持脱敏", async () => {
    const p = await pending();
    const first = await read(await get(p.store.id));
    expect(first.openRound).toMatchObject({
      qualificationSubmissionId: p.submissionId,
      kind: "initial",
      roundNo: 1,
    });
    expect(first.rounds).toHaveLength(1);
    expect(first.rounds[0]).toMatchObject({
      submittedBy: { merchantUserId: p.user.id },
      approval: { status: "pending" },
      approveMode: null,
    });
    await approve(p.submissionId);
    const basic = await h.profile.basic(p.viewer);
    const draft = await h.profile.updateBasic(p.viewer, {
      draft: true,
      lockVersion: basic.lockVersion,
      storeName: "丢弃的待审名称",
      confirmReview: true,
    });
    const draftId = draft.pendingChange!.qualificationSubmissionId;
    expect((await read(await get(p.store.id))).rounds).toHaveLength(1);
    await h.profile.discardQualification(p.viewer, { qualificationSubmissionId: draftId });
    const latest = await h.profile.basic(p.viewer);
    const change = await h.profile.updateBasic(p.viewer, {
      draft: true,
      lockVersion: latest.lockVersion,
      storeName: "变更在审的名称",
      confirmReview: true,
    });
    const changeId = change.pendingChange!.qualificationSubmissionId;
    await submit(h, p.viewer, changeId);
    const before = await snapshotTables(h.prisma, tables);
    const view = await read(await get(p.store.id));
    expect(view).toMatchObject({
      qualificationStatus: "verified",
      isChangeInReview: true,
      openRound: { qualificationSubmissionId: changeId, roundNo: 2 },
    });
    expect(view.rounds.map((v) => v.qualificationSubmissionId)).toEqual([changeId, p.submissionId]);
    expect(view.effectiveDocs.map((v) => v.qualificationDocId)).toEqual([p.docId]);
    expect(view.rounds[1]).toMatchObject({
      outcome: "approved",
      approveMode: "normal",
      approval: { status: "approved" },
    });
    expect(view.firstSubmittedAt).not.toBeNull();
    expect(view.firstVerifiedAt).not.toBeNull();
    const text = JSON.stringify(view);
    for (const secret of [
      p.number,
      "张测试",
      "submittedFieldsEnc",
      "reviewedFieldsEnc",
      "certNoBidx",
      "phoneEnc",
      "https://",
    ])
      expect(text).not.toContain(secret);
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });

  it("新店只共享本主体生效营业执照，外主体不可混入，不创建档案或签图", async () => {
    const p = await pending();
    await approve(p.submissionId);
    const sibling = await h.make.store({
      entityId: p.entity.id,
      isPrimary: false,
      deliveryManagerId: manager.staff.id,
    });
    const other = await pending();
    await approve(other.submissionId);
    const before = await snapshotTables(h.prisma, tables);
    const view = await read(await get(sibling.id, manager));
    expect(view).toMatchObject({
      storeId: sibling.id,
      openRound: null,
      rounds: [],
      isChangeInReview: false,
    });
    expect(view.effectiveDocs.map((v) => v.qualificationDocId)).toEqual([p.docId]);
    expect(view.effectiveDocs[0]).toMatchObject({
      scope: "entity",
      docType: "business_license",
      isEffective: true,
      fieldChecks: expect.any(Array),
      isCorrected: false,
    });
    expect(view.entity.entityId).toBe(p.entity.id);
    expect(JSON.stringify(view)).not.toContain(other.docId);
    expect(await h.prisma.storeProfile.findUnique({ where: { storeId: sibling.id } })).toBeNull();
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });
});
