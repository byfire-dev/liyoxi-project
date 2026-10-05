// 验收第 1、2 条（任务书 W1-06 第 7 节）：发起人审批被拒；守卫顺序与各分支，逐条一例。
// 全文件共用一个带种子的库：每条用例自己造商家与员工，互不依赖。
import { describe, expect, it } from "vitest";

import { sampleSystemContext } from "../testing/index.js";

import { refusal, SLOW, useApprovalWorld } from "./__fixtures__/world.js";
import { ApprovalError } from "./errors.js";

const world = useApprovalWorld();
const T = { timeout: SLOW };

/** 提交之后、还没决定时的痕迹：一行历史、一行审计、一条事件 */
const SUBMITTED = { transitions: 1, audits: 1, events: ["approval.submitted"] };

describe("发起人不得审批（验收 1）", () => {
  it(
    "发起人通过、驳回自己发起的单：403 APPROVAL_SELF_FORBIDDEN，审批单仍 pending，四处都不多一行",
    T,
    async () => {
      const { sample, input } = world;
      const finance = await world.person();
      const { approvalId } = await sample.submit(
        finance.identity,
        input.pointsAdjust(await world.merchant()),
      );

      const approve = sample.approve(finance.identity, {
        approvalId,
        staff: finance.staff,
        lockVersion: 0,
      });
      expect((await refusal(approve)).error).toBe("APPROVAL_SELF_FORBIDDEN");
      const reject = sample.reject(finance.identity, {
        approvalId,
        staff: finance.staff,
        note: "不批",
      });
      expect((await refusal(reject)).error).toBe("APPROVAL_SELF_FORBIDDEN");

      const trace = await sample.trace(approvalId);
      expect(trace).toMatchObject({ status: "pending", lockVersion: 0, ...SUBMITTED });
      expect(trace.domain).toMatchObject({ revalidated: 0, approved: 0, rejected: 0 });
    },
  );

  it("超级管理员也不例外", T, async () => {
    const { sample, input } = world;
    const admin = await world.person({ role: "super_admin" });
    const { approvalId } = await sample.submit(
      admin.identity,
      input.pointsAdjust(await world.merchant()),
    );
    const approve = sample.approve(admin.identity, {
      approvalId,
      staff: admin.staff,
      lockVersion: 0,
    });
    expect((await refusal(approve)).error).toBe("APPROVAL_SELF_FORBIDDEN");
    expect(await sample.trace(approvalId)).toMatchObject({ status: "pending", ...SUBMITTED });

    // 换一位超级管理员就能批：兜底审批人
    const other = await world.person({ role: "super_admin" });
    await sample.approve(other.identity, { approvalId, staff: other.staff, lockVersion: 0 });
    expect((await sample.trace(approvalId)).status).toBe("approved");
  });
});

describe("通过（规定 5、8）", () => {
  it(
    "财务通过积分调整：状态、决定列、锁版本、历史、审计（ops 流）、事件、回调各一次",
    T,
    async () => {
      const { sample, input, prisma } = world;
      const requester = await world.person({ role: "cs" });
      const finance = await world.person();
      const submitted = await sample.submit(
        requester.identity,
        input.pointsAdjust(await world.merchant()),
      );
      expect(submitted.requestNo).toMatch(/^TZ\d{11}$/);

      const decided = await sample.approve(finance.identity, {
        approvalId: submitted.approvalId,
        staff: finance.staff,
        lockVersion: 0,
        note: " 已核对 ",
        confirmChecks: ["amount_checked"],
      });
      expect(decided).toMatchObject({ status: "approved", lockVersion: 1 });

      const row = await prisma.approvalRequest.findUniqueOrThrow({
        where: { id: submitted.approvalId },
      });
      expect(row).toMatchObject({
        status: "approved",
        decidedByStaffId: finance.id,
        isDecidedBySystem: false,
        decisionNote: "已核对",
        confirmChecks: ["amount_checked"],
        requesterStaffId: requester.id,
        submitClient: "admin",
        lockVersion: 1,
      });
      expect(row.decidedAt).toEqual(decided.decidedAt);
      const trace = await sample.trace(submitted.approvalId);
      expect(trace).toMatchObject({
        transitions: 2,
        audits: 2,
        events: ["approval.submitted", "approval.approved"],
        domain: { status: "applied", revalidated: 1, approved: 1 },
      });
      const audits = await prisma.auditLog.findMany({
        where: { targetId: submitted.approvalId },
        orderBy: { id: "asc" },
      });
      expect(audits.map((audit) => [audit.stream, audit.category, audit.action])).toEqual([
        ["ops", "approval", "approval.request.submit"],
        ["ops", "approval", "approval.request.approve"],
      ]);
    },
  );

  it("终态上再决定、再撤回：409 APPROVAL_NOT_PENDING，details 带状态与决定时间", T, async () => {
    const { sample, input } = world;
    const requester = await world.person({ role: "cs" });
    const finance = await world.person();
    const { approvalId } = await sample.submit(
      requester.identity,
      input.pointsAdjust(await world.merchant()),
    );
    const decided = await sample.approve(finance.identity, {
      approvalId,
      staff: finance.staff,
      lockVersion: 0,
    });

    const attempts = [
      () => sample.approve(finance.identity, { approvalId, staff: finance.staff, lockVersion: 1 }),
      () => sample.reject(finance.identity, { approvalId, staff: finance.staff, note: "晚了" }),
      () => sample.withdraw(requester.identity, { approvalId, staff: requester.staff }),
      // 发起人自己来也是先回“不在审”：守卫顺序里它排在最前
      () =>
        sample.approve(requester.identity, { approvalId, staff: requester.staff, lockVersion: 1 }),
    ];
    for (const attempt of attempts) {
      expect(await refusal(attempt())).toEqual({
        error: "APPROVAL_NOT_PENDING",
        details: { status: "approved", decidedAt: decided.decidedAt.toISOString() },
      });
    }
    expect(await sample.trace(approvalId)).toMatchObject({
      status: "approved",
      transitions: 2,
      audits: 2,
    });
  });

  it("没有决定权限点、已被禁用：403 PERMISSION_DENIED", T, async () => {
    const { sample, input, prisma } = world;
    const requester = await world.person({ role: "cs" });
    const { approvalId } = await sample.submit(
      requester.identity,
      input.pointsAdjust(await world.merchant()),
    );

    const cs = await world.person({ role: "cs" });
    const noPermission = sample.approve(cs.identity, {
      approvalId,
      staff: cs.staff,
      lockVersion: 0,
    });
    expect((await refusal(noPermission)).error).toBe("PERMISSION_DENIED");

    // 上下文是禁用之前建的（还带着权限点）：以锁住的员工行为准
    const finance = await world.person();
    await prisma.staff.update({
      where: { id: finance.id },
      data: { status: "disabled", disabledAt: new Date(), disabledReason: "resigned" },
    });
    const disabled = sample.reject(finance.identity, {
      approvalId,
      staff: finance.staff,
      note: "不批",
    });
    expect((await refusal(disabled)).error).toBe("PERMISSION_DENIED");
    expect(await sample.trace(approvalId)).toMatchObject({ status: "pending", ...SUBMITTED });
  });

  it("补偿延长只限发起人所在组的主管，且对象在他的数据范围内；超级管理员兜底", T, async () => {
    const { sample, input } = world;
    const groupId = await world.group("delivery_manager");
    const member = await world.person({ role: "delivery_manager", groupId });
    const lead = await world.person({ role: "delivery_manager", groupId, isLead: true });
    const peer = await world.person({ role: "delivery_manager", groupId });
    const otherLead = await world.person({
      role: "delivery_manager",
      groupId: await world.group("delivery_manager"),
      isLead: true,
    });
    const mine = await world.merchant({ managerId: member.id });
    const { approvalId } = await sample.submit(member.identity, input.extend(mine));

    // 同组的普通成员没有“仅主管”的权限点；别的组的主管不是发起人所在组的
    for (const person of [peer, otherLead]) {
      const attempt = sample.approve(person.identity, {
        approvalId,
        staff: person.staff,
        lockVersion: 0,
      });
      expect((await refusal(attempt)).error).toBe("PERMISSION_DENIED");
    }
    await sample.approve(lead.identity, { approvalId, staff: lead.staff, lockVersion: 0 });
    expect((await sample.trace(approvalId)).status).toBe("approved");

    // 对象不在范围内：门店的交付经理不在这位主管的组里
    const elsewhere = await world.merchant({ managerId: otherLead.id });
    const outside = await sample.submit(member.identity, input.extend(elsewhere));
    const outOfScope = sample.approve(lead.identity, {
      approvalId: outside.approvalId,
      staff: lead.staff,
      lockVersion: 0,
    });
    expect((await refusal(outOfScope)).error).toBe("PERMISSION_DENIED");
    const admin = await world.person({ role: "super_admin" });
    await sample.approve(admin.identity, {
      approvalId: outside.approvalId,
      staff: admin.staff,
      lockVersion: 0,
    });
    expect((await sample.trace(outside.approvalId)).status).toBe("approved");
  });

  it("角色队列（账号核验）不套数据范围：发布专员能决定不归他的门店的那一张", T, async () => {
    const { sample, input } = world;
    const publisher = await world.person({ role: "publisher" });
    const merchant = await world.merchant();
    const { approvalId } = await sample.submit(merchant.identity, input.channelAccount(merchant));
    await sample.approve(publisher.identity, {
      approvalId,
      staff: publisher.staff,
      lockVersion: 0,
    });
    expect(await sample.trace(approvalId)).toMatchObject({ status: "approved", audits: 2 });
  });

  it("通过时 lockVersion 不符：409 VERSION_CONFLICT，details 带最新值；驳回不校验", T, async () => {
    const { sample, input } = world;
    const requester = await world.person({ role: "cs" });
    const finance = await world.person();
    const { approvalId } = await sample.submit(
      requester.identity,
      input.pointsAdjust(await world.merchant()),
    );
    const stale = sample.approve(finance.identity, {
      approvalId,
      staff: finance.staff,
      lockVersion: 3,
    });
    expect(await refusal(stale)).toEqual({
      error: "VERSION_CONFLICT",
      details: { lockVersion: 0 },
    });
    expect(await sample.trace(approvalId)).toMatchObject({ status: "pending", ...SUBMITTED });
    await sample.reject(finance.identity, { approvalId, staff: finance.staff, note: "依据不足" });
    expect((await sample.trace(approvalId)).status).toBe("rejected");
  });

  it(
    "revalidate 认为前提已变：409 PRECONDITION_CHANGED，处理器写的东西全部回滚，审批单保持 pending",
    T,
    async () => {
      const { sample, input } = world;
      const requester = await world.person({ role: "cs" });
      const finance = await world.person();
      const { approvalId } = await sample.submit(
        requester.identity,
        input.pointsAdjust(await world.merchant()),
      );
      const changed = sample.approve(finance.identity, {
        approvalId,
        staff: finance.staff,
        lockVersion: 0,
        args: { changed: true },
      });
      expect((await refusal(changed)).error).toBe("PRECONDITION_CHANGED");
      const trace = await sample.trace(approvalId);
      expect(trace).toMatchObject({ status: "pending", lockVersion: 0, ...SUBMITTED });
      // 样例的 revalidate 先给领域行记了一笔再抛错：回滚后那一笔不在
      expect(trace.domain).toMatchObject({ revalidated: 0, approved: 0 });
    },
  );

  it("系统决定（免审批）：不查权限与发起人，没有审批人，is_decided_by_system 为真", T, async () => {
    const { sample, input, prisma } = world;
    const requester = await world.person({ role: "cs" });
    const { approvalId } = await sample.submit(
      requester.identity,
      input.orderCancel(await world.merchant()),
    );
    await sample.approve(sampleSystemContext("cancel.auto_execute"), { approvalId });
    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
    expect(row).toMatchObject({
      status: "approved",
      decidedByStaffId: null,
      isDecidedBySystem: true,
    });
  });

  it("审核带清单结论：模板要是当前启用的那一版，不通过的条目要有说明", T, async () => {
    const { sample, input, prisma } = world;
    const cs = await world.person({ role: "cs" });
    const merchant = await world.merchant();
    const { approvalId } = await sample.submit(merchant.identity, input.qualification(merchant));
    const template = await prisma.checklistTemplate.findFirstOrThrow({
      where: { status: "active" },
    });
    const base = { approvalId, staff: cs.staff, lockVersion: 0 };
    const result = [{ key: "k1", result: "pass" as const }];

    const retired = sample.approve(cs.identity, {
      ...base,
      checklist: { code: template.code, versionNo: template.versionNo + 100, result },
    });
    expect((await refusal(retired)).error).toBe("PRECONDITION_CHANGED");
    const noNote = sample.approve(cs.identity, {
      ...base,
      checklist: {
        code: template.code,
        versionNo: template.versionNo,
        result: [{ key: "k1", result: "fail" }],
      },
    });
    expect((await refusal(noNote)).error).toBe("VALIDATION_FAILED");

    await sample.approve(cs.identity, {
      ...base,
      checklist: { code: template.code, versionNo: template.versionNo, result },
    });
    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
    expect(row).toMatchObject({
      status: "approved",
      checklistCode: template.code,
      checklistVersionNo: template.versionNo,
      checklistResult: result,
    });
  });
});

describe("驳回（规定 6、8）", () => {
  it("说明必填；审核类由员工驳回至少一项原因，且都是字典里启用的编码", T, async () => {
    const { sample, input, prisma } = world;
    const cs = await world.person({ role: "cs" });
    const merchant = await world.merchant();
    const { approvalId } = await sample.submit(merchant.identity, input.qualification(merchant));
    const base = { approvalId, staff: cs.staff };

    const bad = [
      () => sample.reject(cs.identity, { ...base, note: "  ", reasonCodes: ["R01"] }),
      () => sample.reject(cs.identity, { ...base, note: "证照看不清" }),
      () =>
        sample.reject(cs.identity, { ...base, note: "证照看不清", reasonCodes: ["R01", "NOPE"] }),
    ];
    for (const attempt of bad) expect((await refusal(attempt())).error).toBe("VALIDATION_FAILED");
    expect(await sample.trace(approvalId)).toMatchObject({ status: "pending", ...SUBMITTED });

    await sample.reject(cs.identity, {
      ...base,
      note: "证照看不清",
      reasonCodes: ["R01", "R03", "R01"],
    });
    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
    expect(row).toMatchObject({
      status: "rejected",
      reasonCodes: ["R01", "R03"],
      decisionNote: "证照看不清",
      decidedByStaffId: cs.id,
      submitActorType: "merchant",
      submitClient: "weapp",
      requesterStaffId: null,
    });
    const trace = await sample.trace(approvalId);
    expect(trace).toMatchObject({
      transitions: 2,
      audits: 2,
      events: ["approval.submitted", "approval.rejected"],
      domain: { status: "not_executed", closeReason: "rejected", rejected: 1, revalidated: 0 },
    });
    // 审核类写 activity 流
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { targetId: approvalId, action: "approval.request.reject" },
    });
    expect(audit).toMatchObject({ stream: "activity", category: "review", reasonCode: "R01" });
  });

  it("员工发起的审批驳回时原因可以不选；系统驳回审核也不要求原因", T, async () => {
    const { sample, input, prisma } = world;
    const requester = await world.person({ role: "cs" });
    const finance = await world.person();
    const adjust = await sample.submit(
      requester.identity,
      input.pointsAdjust(await world.merchant()),
    );
    await sample.reject(finance.identity, {
      approvalId: adjust.approvalId,
      staff: finance.staff,
      note: "数额有误",
    });
    expect((await sample.trace(adjust.approvalId)).status).toBe("rejected");

    const merchant = await world.merchant();
    const review = await sample.submit(merchant.identity, input.qualification(merchant));
    await sample.reject(sampleSystemContext("profile.on_qualification_approved"), {
      approvalId: review.approvalId,
      note: "同一信用代码的另一家主体已通过认证",
    });
    const row = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: review.approvalId },
    });
    expect(row).toMatchObject({
      status: "rejected",
      isDecidedBySystem: true,
      decidedByStaffId: null,
      reasonCodes: [],
    });
  });
});

describe("撤回（规定 7）", () => {
  it("提交人本人可以撤回；别人不行，除非发起人已不是启用状态且他能决定这一张", T, async () => {
    const { sample, input, prisma } = world;
    const requester = await world.person({ role: "cs" });
    const finance = await world.person();
    const own = await sample.submit(requester.identity, input.pointsAdjust(await world.merchant()));
    await sample.withdraw(requester.identity, {
      approvalId: own.approvalId,
      staff: requester.staff,
      note: "填错了",
    });
    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: own.approvalId } });
    expect(row).toMatchObject({
      status: "withdrawn",
      decidedByStaffId: null,
      isDecidedBySystem: false,
      decisionNote: "填错了",
    });
    expect(await sample.trace(own.approvalId)).toMatchObject({
      transitions: 2,
      audits: 2,
      events: ["approval.submitted", "approval.withdrawn"],
      domain: { status: "not_executed", closeReason: "withdrawn", withdrawn: 1 },
    });

    const { approvalId } = await sample.submit(
      requester.identity,
      input.pointsAdjust(await world.merchant()),
    );
    // 发起人还在职：持决定权限点的人也不能代撤
    const early = sample.withdraw(finance.identity, { approvalId, staff: finance.staff });
    expect((await refusal(early)).error).toBe("APPROVAL_WITHDRAW_FORBIDDEN");

    await prisma.staff.update({
      where: { id: requester.id },
      data: { status: "disabled", disabledAt: new Date(), disabledReason: "resigned" },
    });
    // 发起人已禁用：没有决定权限点的人仍不能代撤，有的可以
    const cs = await world.person({ role: "cs" });
    const powerless = sample.withdraw(cs.identity, { approvalId, staff: cs.staff });
    expect((await refusal(powerless)).error).toBe("APPROVAL_WITHDRAW_FORBIDDEN");
    await sample.withdraw(finance.identity, { approvalId, staff: finance.staff });
    expect((await sample.trace(approvalId)).status).toBe("withdrawn");
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { targetId: approvalId, action: "approval.request.withdraw" },
    });
    expect(audit.summary).toContain("代为撤回");
  });

  it("商家撤回自己提交的审核；别的商家、员工不行；对象失效时系统代撤", T, async () => {
    const { sample, input, prisma } = world;
    const merchant = await world.merchant();
    const stranger = await world.merchant();
    const cs = await world.person({ role: "cs" });
    const { approvalId } = await sample.submit(merchant.identity, input.qualification(merchant));
    for (const attempt of [
      () => sample.withdraw(stranger.identity, { approvalId }),
      () => sample.withdraw(cs.identity, { approvalId, staff: cs.staff }),
    ]) {
      expect((await refusal(attempt())).error).toBe("APPROVAL_WITHDRAW_FORBIDDEN");
    }
    await sample.withdraw(merchant.identity, { approvalId });
    expect((await sample.trace(approvalId)).status).toBe("withdrawn");

    const second = await sample.submit(merchant.identity, input.channelAccount(merchant));
    await sample.withdraw(sampleSystemContext("publish.channel_account.unbind"), {
      approvalId: second.approvalId,
    });
    const row = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: second.approvalId },
    });
    expect(row).toMatchObject({
      status: "withdrawn",
      isDecidedBySystem: true,
      decidedByStaffId: null,
    });
  });
});

describe("用错了的地方按内部错误拒掉", () => {
  it(
    "员工操作不给员工上下文、通过不带 lockVersion、商家来决定、不经本模块直接迁移",
    T,
    async () => {
      const { sample, input } = world;
      const requester = await world.person({ role: "cs" });
      const finance = await world.person();
      const merchant = await world.merchant();
      const { approvalId } = await sample.submit(requester.identity, input.pointsAdjust(merchant));

      await expect(
        sample.approve(finance.identity, { approvalId, lockVersion: 0 }),
      ).rejects.toThrow(ApprovalError);
      await expect(
        sample.approve(finance.identity, { approvalId, staff: finance.staff }),
      ).rejects.toThrow(ApprovalError);
      await expect(sample.approve(merchant.identity, { approvalId })).rejects.toThrow(
        ApprovalError,
      );
      const bypass = sample.tx.run((tx) =>
        sample.flow.transition(tx, finance.identity, {
          machine: "approval_request",
          stateField: "status",
          id: approvalId,
          event: "approve",
          set: { decided_at: new Date(), decided_by_staff_id: finance.id },
          audit: {
            stream: "ops",
            category: "approval",
            action: "lyxtest.approval.bypass",
            summary: "绕过",
          },
          emit: { none: true, primary: "approval.approved" },
        }),
      );
      await expect(bypass).rejects.toMatchObject({ name: "ApprovalError", reason: "bypass" });
      expect(await sample.trace(approvalId)).toMatchObject({ status: "pending", ...SUBMITTED });
    },
  );
});
