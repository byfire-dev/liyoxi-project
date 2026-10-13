import { beforeAll, describe, expect, it } from "vitest";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import {
  QualificationSubmissionDetailSchema,
  StoreHeaderSchema,
  AdminStoreListSchema,
  ManagerAssignResultSchema,
} from "@liyoxi/contract";
import { complete, harness, submit, ownedFile } from "./admin-profile-fixtures.js";
import type { Harness } from "./admin-profile-fixtures.js";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
const handle = useTestApi();
let api: TestApi, h: Harness, admin: SignedInStaff, cs: SignedInStaff, manager: SignedInStaff;
let peer = 0;
const operations = [
  "admin.store.list",
  "admin.store.get",
  "admin.store.assignDeliveryManager",
  "admin.qualificationSubmission.get",
  "admin.qualificationSubmission.approve",
  "admin.qualificationSubmission.reject",
] as const;
beforeAll(async () => {
  api = await handle.start();
  h = harness(api, await handle.db.prisma());
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  admin = await signInAsStaff(h.prisma, { roleKey: "super_admin" });
  cs = await signInAsStaff(h.prisma, { roleKey: "cs" });
  manager = await signInAsStaff(h.prisma, { roleKey: "delivery_manager" });
}, 120000);
async function req(path: string, json?: unknown, staff = admin, key = uuidv7()) {
  return api.request(`/api/v1/admin/${path}`, {
    method: json === undefined ? "GET" : "POST",
    ...(json === undefined ? {} : { json }),
    headers: { ...staff.headers, "Idempotency-Key": key },
    peer: `198.19.8.${++peer}`,
  });
}
async function data(r: Response) {
  expect(r.status, await r.clone().text()).toBe(200);
  return ((await r.json()) as { data: unknown }).data;
}
async function error(r: Response, status: number, symbol: string) {
  expect(r.status, await r.clone().text()).toBe(status);
  expect(await r.json()).toMatchObject({ error: symbol });
}
async function pending() {
  const owner = await h.owner();
  const ready = await complete(h, owner.viewer);
  await submit(h, owner.viewer, ready.submissionId);
  return { ...owner, ...ready };
}
describe("后台档案六接口", { timeout: 60000 }, () => {
  it("六条实际挂载；读侧脱敏、完整筛选和GET无写，M1未开放筛选明确400", async () => {
    for (const op of operations)
      expect(HANDLERS.some((v) => v.route.operationId === op)).toBe(true);
    const p = await pending();
    const before = await h.prisma.storeProfile.findUniqueOrThrow({
      where: { storeId: p.store.id },
    });
    const list = AdminStoreListSchema.parse(
      await data(
        await req(
          `stores?q=测试门店&regionCode=110101&industryCode=C900&categoryCode=C901&qualificationStatus=pending&isManagerUnassigned=true&entityId=${p.entity.id}&sort=-registeredAt`,
        ),
      ),
    );
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      storeId: p.store.id,
      subscription: { status: "none" },
      points: { spendablePoints: 0 },
      totalPaidFen: 0,
    });
    const header = StoreHeaderSchema.parse(await data(await req(`stores/${p.store.id}`)));
    expect(header.owner?.merchantUserId).toBe(p.user.id);
    expect(header.managerOpenWork.dramaOrderCount).toBe(0);
    const detail = QualificationSubmissionDetailSchema.parse(
      await data(await req(`qualification-submissions/${p.submissionId}`)),
    );
    expect(detail.docs[0]).toMatchObject({
      fileId: expect.any(String),
      ocrStatus: "unavailable",
      fieldChecks: [{ code: "C11", field: "ocr", result: "manual" }],
      isCorrected: false,
    });
    expect(JSON.stringify(detail)).not.toContain(p.number);
    expect(JSON.stringify(detail)).not.toContain("张测试");
    expect(detail.approval.lockVersion).toBe(0);
    expect(detail.lockVersion).toBeGreaterThan(0);
    expect(
      await h.prisma.storeProfile.findUniqueOrThrow({ where: { storeId: p.store.id } }),
    ).toEqual(before);
    for (const query of [
      "sort=-lastOrderAt",
      "sourceType=natural",
      "subscriptionStatus=none",
      "planId=" + uuidv7(),
      "expiresWithinDays=7",
      `deliveryManagerId=${manager.staff.id}&isManagerUnassigned=true`,
    ])
      await error(await req("stores?" + query), 400, "VALIDATION_FAILED");
  });
  it("真实权限、范围404、版本先于缺回显，override追加权限先于版本", async () => {
    const p = await pending();
    const path = `qualification-submissions/${p.submissionId}`;
    await error(await req(path, undefined, manager), 404, "NOT_FOUND");
    await error(await req(`stores/${p.store.id}`, undefined, manager), 404, "NOT_FOUND");
    await error(
      await req(path + "/approve", { lockVersion: 99, mode: "override" }, cs),
      403,
      "PERMISSION_DENIED",
    );
    await error(await req(path + "/approve", { lockVersion: 99 }), 409, "VERSION_CONFLICT");
    await error(await req(path + "/approve", { lockVersion: 0 }), 409, "CONFIRM_MISMATCH");
    await error(
      await req(path + "/reject", { reasonCodes: ["R01"], note: "请补传" }),
      409,
      "CONFIRM_MISMATCH",
    );
    await error(
      await req(path + "/approve", {
        lockVersion: 0,
        mode: "override",
        overrideReason: "人工比对后确认需要放行",
        confirm: { roundNo: 1 },
      }),
      409,
      "STATE_NOT_ALLOWED",
    );
    await error(
      await req(path + "/reject", {
        reasonCodes: ["R01"],
        note: "请补传",
        isFinal: true,
        confirm: { roundNo: 1 },
      }),
      409,
      "CONFIRM_MISMATCH",
    );
    expect(
      (
        await h.prisma.qualificationSubmission.findUniqueOrThrow({
          where: { id: p.submissionId },
          include: { approvalRequest: true },
        })
      ).approvalRequest?.status,
    ).toBe("pending");
  });
  it("通过原DTO幂等重放；单次历史/事件/审计；已决优先拒绝", async () => {
    const p = await pending(),
      key = uuidv7(),
      body = { lockVersion: 0, confirm: { roundNo: 1 }, confirmChecks: ["license"] };
    const path = `qualification-submissions/${p.submissionId}/approve`;
    const first = QualificationSubmissionDetailSchema.parse(
      await data(await req(path, body, admin, key)),
    );
    expect(first.approval.status).toBe("approved");
    expect(first.approval.decidedBy?.staffId).toBe(admin.staff.id);
    expect(first.store.qualificationStatus).toBe("verified");
    expect(first.confirmChecks).toEqual(["license"]);
    expect(first.docs[0]?.isEffective).toBe(true);
    expect(await data(await req(path, body, admin, key))).toEqual(first);
    await error(await req(path, { lockVersion: 99 }), 409, "APPROVAL_NOT_PENDING");
    for (const id of [p.store.id, p.entity.id, first.approval.approvalId])
      expect(await h.prisma.statusTransition.count({ where: { subjectId: id } })).toBe(2);
    for (const [eventType, aggregateId] of [
      ["approval.approved", first.approval.approvalId],
      ["store.qualification.approved", p.store.id],
    ])
      expect(await h.prisma.outboxEvent.count({ where: { eventType, aggregateId } })).toBe(1);
    expect(
      await h.prisma.auditLog.count({ where: { storeId: p.store.id, category: "review" } }),
    ).toBe(3);
  });
  it("驳回点名证照，补传重新送审后通过，两轮历史保留", async () => {
    const p = await pending();
    const rejectBody = {
      reasonCodes: ["R01"],
      note: "证照模糊请补传",
      rejectedDocIds: [p.docId],
      confirm: { roundNo: 1 },
    };
    const rejectKey = uuidv7();
    const rejected = QualificationSubmissionDetailSchema.parse(
      await data(
        await req(
          `qualification-submissions/${p.submissionId}/reject`,
          rejectBody,
          admin,
          rejectKey,
        ),
      ),
    );
    expect(
      await data(
        await req(
          `qualification-submissions/${p.submissionId}/reject`,
          rejectBody,
          admin,
          rejectKey,
        ),
      ),
    ).toEqual(rejected);
    expect(rejected.docs[0]?.verdict).toBe("rejected");
    expect(rejected.store.qualificationStatus).toBe("rejected");
    const draft = await h.profile.updateQualification(p.viewer, {
      lockVersion: null,
      declarationConfirmed: true,
      declarationVersion: "1",
    });
    const file = await ownedFile(h, p.viewer, "kyc_license");
    const created = await h.profile.createDocument(p.viewer, {
      docType: "business_license",
      fileId: file.id,
    });
    await h.profile.updateDocument(p.viewer, created.doc.qualificationDocId, {
      lockVersion: created.lockVersion,
      fields: {
        name: "补传主体",
        uscc: p.number,
        principal: "张测试",
        principalRole: "legal_rep",
        subjectType: "enterprise",
        validFrom: "2020-01-01",
        validTo: "long_term",
        address: "测试地址",
      },
    });
    const id = draft.openRound!.qualificationSubmissionId;
    await submit(h, p.viewer, id);
    await error(
      await req(`qualification-submissions/${id}/approve`, {
        lockVersion: 0,
        confirm: { roundNo: 1 },
      }),
      409,
      "CONFIRM_MISMATCH",
    );
    const approved = QualificationSubmissionDetailSchema.parse(
      await data(
        await req(`qualification-submissions/${id}/approve`, {
          lockVersion: 0,
          confirm: { roundNo: 2 },
        }),
      ),
    );
    expect(approved.isResubmit).toBe(true);
    expect(approved.entity.name).toBe("补传主体");
    for (const subjectId of [p.store.id, p.entity.id])
      expect(await h.prisma.statusTransition.count({ where: { subjectId } })).toBe(4);
    expect(
      (await h.prisma.qualificationSubmission.findUniqueOrThrow({ where: { id: p.submissionId } }))
        .outcome,
    ).toBe("rejected");
  });
  it("归档店后台首次指派成功、幂等只一次审计；两个员工并发只一胜", async () => {
    const p = await h.owner();
    await h.prisma.store.update({
      where: { id: p.store.id },
      data: {
        lifecycle: "archived",
        archivedAt: h.clock.now(),
        archiveReason: "by_owner",
        archiveActorType: "merchant",
        archiveActorId: p.user.id,
        archiveClient: "weapp",
      },
    });
    const key = uuidv7(),
      body = { toStaffId: manager.staff.id, note: "安排存量事项" },
      path = `stores/${p.store.id}/assign-delivery-manager`;
    const result = ManagerAssignResultSchema.parse(await data(await req(path, body, admin, key)));
    expect(result.synced).toEqual({ dramaOrderCount: 0, deliveryTicketCount: 0 });
    expect(await data(await req(path, body, admin, key))).toEqual(result);
    const audit = await h.prisma.auditLog.findMany({
      where: { storeId: p.store.id, category: "manager_assign" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ reasonText: "安排存量事项", meta: { synced: result.synced } });
    const r = await req(path, body);
    await error(r, 409, "STORE_MANAGER_ASSIGNED");
    const next = await h.owner(),
      other = await signInAsStaff(h.prisma, { roleKey: "delivery_manager" });
    const results = await Promise.all(
      [manager, other].map((s) =>
        req(`stores/${next.store.id}/assign-delivery-manager`, { toStaffId: s.staff.id }),
      ),
    );
    expect(results.map((v) => v.status).sort()).toEqual([200, 409]);
    expect(
      await h.prisma.auditLog.count({
        where: { storeId: next.store.id, category: "manager_assign" },
      }),
    ).toBe(1);
  });
  it("指派的路由权限和接收人原因保留真实守卫", async () => {
    const { store } = await h.owner();
    await error(
      await req(
        `stores/${store.id}/assign-delivery-manager`,
        { toStaffId: manager.staff.id },
        manager,
      ),
      403,
      "PERMISSION_DENIED",
    );
    const editor = await h.make.staff({ staffRoleKey: "editor" });
    const response = await req(`stores/${store.id}/assign-delivery-manager`, {
      toStaffId: editor.id,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "ASSIGNEE_INVALID",
      details: { staffId: editor.id, reason: "role_mismatch" },
    });
    const lead = await signInAsStaff(h.prisma, { roleKey: "delivery_manager", isLead: true });
    const outside = await h.make.staff({ staffRoleKey: "delivery_manager", staffGroupId: null });
    const out = await req(
      `stores/${store.id}/assign-delivery-manager`,
      { toStaffId: outside.id },
      lead,
    );
    expect(out.status).toBe(409);
    expect(await out.json()).toMatchObject({
      error: "ASSIGNEE_INVALID",
      details: { reason: "out_of_scope" },
    });
  });
  it("相同信用代码并发决定唯一成功，失败方轮次/审批仍pending", async () => {
    const a = await pending(),
      b = await h.owner(),
      ready = await complete(h, b.viewer, a.number);
    await submit(h, b.viewer, ready.submissionId);
    const responses = await Promise.all(
      [a.submissionId, ready.submissionId].map((id) =>
        req(`qualification-submissions/${id}/approve`, { lockVersion: 0, confirm: { roundNo: 1 } }),
      ),
    );
    expect(responses.map((v) => v.status).sort()).toEqual([200, 409]);
    const failed = responses.findIndex((v) => v.status === 409);
    await error(responses[failed]!, 409, "USCC_TAKEN");
    const round = await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: [a.submissionId, ready.submissionId][failed]! },
      include: { approvalRequest: true },
    });
    expect(round.closedAt).toBeNull();
    expect(round.approvalRequest?.status).toBe("pending");
  });
});
