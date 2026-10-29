import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { AdminDeliveryPlanDetailSchema, DeliveryTicketDetailSchema } from "@liyoxi/contract";
import { scopeOf } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { createIdentityContext } from "../kernel/index.js";
import { sampleStaffContext, useSeededDatabase } from "../testing/index.js";
import { draft, harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { ticketProductionActions } from "./views.js";

const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(() => h?.unbind());
const productionActions = [
  "sample-create",
  "episode-register",
  "inspect-episodes",
  "inspect-package",
];
const onlyProduction = (actions: string[]) => actions.filter((a) => productionActions.includes(a));
async function snapshot(id: string) {
  return {
    ticket: await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } }),
    audit: await h.prisma.auditLog.count(),
    events: await h.prisma.outboxEvent.count(),
    history: await h.prisma.statusTransition.count(),
    samples: await h.prisma.sample.count(),
    episodes: await h.prisma.episodeOutput.count(),
    qc: await h.prisma.qcRecord.count(),
  };
}

async function nonLeadEditor() {
  const row = await h.make.staff({ staffRoleKey: "editor", isLead: false });
  return {
    row,
    staff: await sampleStaffContext(h.prisma, row.id),
    ctx: createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" } }),
  };
}

describe("制作表单由服务端下发操作入口", { timeout: 60000 }, () => {
  it("真实 GET 在样片、制作、待交付三步给出不同入口且零业务写入", async () => {
    const o = await h.order(true),
      a = await h.staff(),
      id = o.deliveryTicketIds[0]!;
    for (const [step, actions] of [
      ["sample_making", ["sample-create"]],
      ["batch_compose", ["episode-register", "inspect-episodes", "inspect-package"]],
      ["delivering", ["episode-register", "inspect-episodes"]],
    ] as const) {
      // 只读投影测试的阶段前提；写侧生产迁移仍只走 flow，主链另有真实验收。
      await h.prisma.deliveryTicket.update({
        where: { id },
        data: { step, editorId: a.staff.staff.id },
      });
      const before = await snapshot(id);
      const view = DeliveryTicketDetailSchema.parse(await h.delivery.get(a.staff, id));
      expect(onlyProduction(view.actions)).toEqual(actions);
      expect(await snapshot(id)).toEqual(before);
    }
  });

  it("其他剪辑师、暂停、已交付事实分别隐藏不能执行的入口", async () => {
    const o = await h.order(true),
      actor = await nonLeadEditor(),
      other = await nonLeadEditor(),
      id = o.deliveryTicketIds[0]!;
    // This predicate fixture grants read/QC separately so ownership, pause and delivered facts
    // remain independently exercised. The default own-task scope is covered below unchanged.
    const permissions = new Set([...actor.staff.permissions, "delivery.episode.qc" as const]);
    const a = {
      ...actor,
      staff: {
        ...actor.staff,
        permissions,
        dataScope: "all" as const,
        moduleLevels: { ...actor.staff.moduleLevels, delivery: "e" as const },
        scope: scopeOf(actor.staff.staff, { dataScope: "all" }, [], permissions),
      },
    };
    await h.prisma.deliveryTicket.update({
      where: { id },
      data: { step: "sample_making", editorId: other.row.id },
    });
    expect(onlyProduction((await h.delivery.get(a.staff, id)).actions)).toEqual([]);
    await expect(
      h.delivery.sampleCreate(a.ctx, a.staff, id, { fileId: o.account.id, adSlots: [] }),
    ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    await h.prisma.deliveryTicket.update({
      where: { id },
      data: { step: "batch_compose", pauseCount: 1, pausedAt: h.clock.now() },
    });
    expect(onlyProduction((await h.delivery.get(a.staff, id)).actions)).toEqual([]);
    await expect(
      h.delivery.episodeRegister(a.ctx, a.staff, id, {
        items: [{ episodeNo: 1, fileId: o.account.id }],
      }),
    ).rejects.toMatchObject({ error: "TICKET_ON_HOLD" });
    await h.prisma.deliveryTicket.update({
      where: { id },
      data: {
        step: "delivering",
        pauseCount: 0,
        pausedAt: null,
        editorId: a.row.id,
        deliveredAt: h.clock.now(),
      },
    });
    expect(onlyProduction((await h.delivery.get(a.staff, id)).actions)).toEqual([
      "inspect-episodes",
    ]);
    await expect(
      h.delivery.episodeRegister(a.ctx, a.staff, id, {
        items: [{ episodeNo: 1, fileId: o.account.id }],
      }),
    ).rejects.toMatchObject({ error: "EPISODE_REGISTER_NOT_ALLOWED" });
  });

  it("超级管理员可代他人登记，真实GET下发代登记入口且不更改负责人", async () => {
    const o = await h.order(true),
      actor = await h.staff(),
      owner = await nonLeadEditor(),
      id = o.deliveryTicketIds[0]!;
    for (const [step, expected] of [
      ["sample_making", ["sample-create"]],
      ["batch_compose", ["episode-register", "inspect-episodes", "inspect-package"]],
      ["delivering", ["episode-register", "inspect-episodes"]],
    ] as const) {
      await h.prisma.deliveryTicket.update({
        where: { id },
        data: { step, editorId: owner.row.id },
      });
      const before = await snapshot(id);
      expect(onlyProduction((await h.delivery.get(actor.staff, id)).actions)).toEqual(expected);
      expect(await snapshot(id)).toEqual(before);
    }
  });

  it("有读权限但缺少操作权限或只有查看等级时，真实 GET 不给制作入口", async () => {
    const o = await h.order(true),
      a = await h.staff(),
      id = o.deliveryTicketIds[0]!;
    await h.prisma.deliveryTicket.update({ where: { id }, data: { step: "batch_compose" } });
    const none: StaffContext = { ...a.staff, permissions: new Set() };
    expect(onlyProduction((await h.delivery.get(none, id)).actions)).toEqual([]);
    const readonly: StaffContext = {
      ...a.staff,
      moduleLevels: { ...a.staff.moduleLevels, delivery: "v" },
    };
    expect(onlyProduction((await h.delivery.get(readonly, id)).actions)).toEqual([]);
    const qcOnly: StaffContext = { ...a.staff, permissions: new Set(["delivery.episode.qc"]) };
    expect(onlyProduction((await h.delivery.get(qcOnly, id)).actions)).toEqual([
      "inspect-episodes",
      "inspect-package",
    ]);
  });

  it("暂停或查看等级在任意阶段、编辑归属与权限子集中均不能获得制作入口", async () => {
    const a = await nonLeadEditor();
    fc.assert(
      fc.property(
        fc.constantFrom(
          "assigning",
          "plan_confirm",
          "sample_making",
          "batch_compose",
          "delivering",
          "archived",
          "terminated",
        ),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (step, foreignEditor, delivered, hasPermissions) => {
          const staff = hasPermissions ? a.staff : { ...a.staff, permissions: new Set<never>() };
          const t = {
            step,
            pauseCount: 1,
            editorId: foreignEditor ? "other-editor" : a.row.id,
            deliveredAt: delivered ? h.clock.now() : null,
          };
          expect(ticketProductionActions(t, staff)).toEqual([]);
          expect(
            ticketProductionActions(
              { ...t, pauseCount: 0 },
              { ...staff, moduleLevels: { ...staff.moduleLevels, delivery: "v" } },
            ),
          ).toEqual([]);
        },
      ),
    );
  });

  it("草稿保存入口区分权限与推送；确认后两项关闭，读不改版本", async () => {
    const o = await h.order(true),
      a = await h.staff();
    const editOnly: StaffContext = { ...a.staff, permissions: new Set(["delivery.plan.edit"]) };
    expect((await h.delivery.adminPlan(editOnly, o.deliveryPlanId)).actions).toEqual([
      "draft-replace",
    ]);
    expect(
      (
        await h.delivery.adminPlan(
          { ...editOnly, moduleLevels: { ...editOnly.moduleLevels, delivery: "v" } },
          o.deliveryPlanId,
        )
      ).actions,
    ).toEqual([]);
    await h.delivery.replaceDraft(a.ctx, a.staff, o.deliveryPlanId, {
      draftLockVersion: 0,
      content: draft(o),
    });
    await h.delivery.push(a.ctx, a.staff, o.deliveryPlanId, { draftLockVersion: 1 });
    await h.delivery.confirm(o.viewer, o.deliveryPlanId, { versionNo: 1 });
    const before = await h.prisma.deliveryPlan.findUniqueOrThrow({
      where: { id: o.deliveryPlanId },
    });
    const view = AdminDeliveryPlanDetailSchema.parse(
      await h.delivery.adminPlan(a.staff, o.deliveryPlanId),
    );
    expect(view.actions).toEqual([]);
    expect(
      await h.prisma.deliveryPlan.findUniqueOrThrow({ where: { id: o.deliveryPlanId } }),
    ).toEqual(before);
    await expect(
      h.delivery.replaceDraft(a.ctx, a.staff, o.deliveryPlanId, {
        draftLockVersion: 1,
        content: draft(o),
      }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
  });

  it("只有本人工单范围的编辑仍读不到其他工单，新增 actions 不扩大读取范围", async () => {
    const o = await h.order(true),
      editor = await h.staff("editor"),
      id = o.deliveryTicketIds[0]!;
    await expect(h.delivery.get(editor.staff, id)).rejects.toMatchObject({ error: "NOT_FOUND" });
    await h.prisma.deliveryTicket.update({
      where: { id },
      data: { step: "sample_making", editorId: editor.row.id },
    });
    expect(onlyProduction((await h.delivery.get(editor.staff, id)).actions)).toEqual([
      "sample-create",
    ]);
  });
});
