import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@liyoxi/db";
import { STAFF_ROLE_DEFAULTS } from "@liyoxi/contract";
import { useSeededDatabase } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { FULL_STAFF_CHECKS, findStaffViolations } from "./full-invariants.js";
import { fullStaffWorld } from "./__fixtures__/full.js";
import type { FullStaffWorld } from "./__fixtures__/full.js";
const SLOW = 180_000;
const db = useSeededDatabase("services", { label: "staffrules" });
let w: FullStaffWorld;
beforeAll(async () => {
  w = await fullStaffWorld(await db.prisma());
}, SLOW);
afterAll(() => w?.scope.close());
const check = (code: (typeof FULL_STAFF_CHECKS)[number]) =>
  w.tx.run((tx) => findStaffViolations(tx, code, w.deps, w.assembly));
const disabled = () => ({
  status: "disabled",
  disabledAt: w.clock.now(),
  disabledReason: "reassigned",
  disabledByStaffId: w.operator.id,
});
async function follow(ownerStaffId: string) {
  const store = await w.make.store();
  return w.prisma.followUp.create({
    data: {
      id: uuidv7(),
      subjectType: "store",
      subjectId: store.id,
      entityId: store.entityId,
      storeId: store.id,
      content: "未结跟进",
      ownerStaffId,
      nextFollowAt: w.clock.now(),
      actorType: "system",
      channel: "system",
      createdAt: w.clock.now(),
      updatedAt: w.clock.now(),
    },
  });
}
describe("staff原I8与全量真实不变量", { timeout: SLOW }, () => {
  it("原I8严格仅登记一份，全12新检查在合法图真实运行", async () => {
    expect(w.assembly.invariants.filter((r) => r.code === "staff.I8")).toHaveLength(1);
    const original = w.assembly.invariant("staff.I8")!;
    expect(await w.tx.run((tx) => original.run!(tx, {}))).toEqual([]);
    for (const code of FULL_STAFF_CHECKS) expect(await check(code), code).toEqual([]);
    for (const code of ["I8", ...FULL_STAFF_CHECKS]) {
      const registered = w.assembly.invariant(`staff.${code}`)!;
      expect(registered.modes, code).toContain("full");
      expect(await w.tx.run((tx) => registered.run!(tx, {}, { now: w.clock.now() })), code).toEqual(
        [],
      );
    }
  });
  it("I2无超级管理员不能豁免，I3分组角色错配，I4接收人角色错配", async () => {
    const row = await w.person("editor"),
      target = await w.person("publisher");
    await w.prisma.staff.update({
      where: { id: w.operator.id },
      data: { ...disabled(), disabledByStaffId: row.id },
    });
    expect(await check("I2")).toMatchObject([{ detail: { problem: "no_active_super_admin" } }]);
    await w.prisma.staff.update({
      where: { id: w.operator.id },
      data: { status: "active", disabledAt: null, disabledReason: null, disabledByStaffId: null },
    });
    const originalGroup = row.staffGroupId;
    await w.prisma.staff.update({
      where: { id: row.id },
      data: { staffGroupId: target.staffGroupId },
    });
    expect(
      (await check("I3")).map((r) => (r.subject && "id" in r.subject ? r.subject.id : undefined)),
    ).toContain(row.id);
    await w.prisma.staff.update({
      where: { id: row.id },
      data: { ...disabled(), staffGroupId: originalGroup, handoverToStaffId: target.id },
    });
    expect(
      (await check("I4")).map((r) => (r.subject && "id" in r.subject ? r.subject.id : undefined)),
    ).toContain(row.id);
    await w.prisma.staff.update({ where: { id: row.id }, data: { handoverToStaffId: null } });
  });
  it("I5默认分组必须唯一，I6非空组须启用主管，I7非法角色配置，I9池角色真实污染", async () => {
    const defaultGroup = await w.prisma.staffGroup.findFirstOrThrow({
      where: { staffRoleKey: "channel_ops", isDefault: true },
    });
    await w.prisma.staffGroup.update({
      where: { id: defaultGroup.id },
      data: { isDefault: false },
    });
    expect(await check("I5")).toMatchObject([{ detail: { problem: "default_group_count" } }]);
    await w.prisma.staffGroup.update({ where: { id: defaultGroup.id }, data: { isDefault: true } });
    const editor = await w.person("content_ops", false);
    expect(
      (await check("I6")).map((r) => (r.subject && "id" in r.subject ? r.subject.id : undefined)),
    ).toContain(editor.staffGroupId);
    const role = await w.prisma.staffRole.findUniqueOrThrow({ where: { key: "finance" } });
    await w.prisma.staffRole.update({
      where: { key: "finance" },
      data: { actions: { "not.registered.permission": { on: true } } },
    });
    expect(
      (await check("I7")).map((r) => (r.subject && "key" in r.subject ? r.subject.key : undefined)),
    ).toContain("finance");
    await w.prisma.staffRole.update({
      where: { key: "finance" },
      data: { actions: role.actions as Prisma.InputJsonValue },
    });
    const p = await w.person("editor");
    await w.prisma.assignmentPoolMember.create({
      data: {
        staffId: p.id,
        pool: "publisher",
        cityCode: "",
        createdAt: w.clock.now(),
        updatedAt: w.clock.now(),
      },
    });
    expect(
      (await check("I9")).map((r) => (r.subject && "id" in r.subject ? r.subject.id : undefined)),
    ).toContain(p.id);
    await w.prisma.assignmentPoolMember.deleteMany({ where: { staffId: p.id } });
    expect(STAFF_ROLE_DEFAULTS).toHaveLength(8);
  });
  it("I1/I13捕获残留；I10真实用最近移交历史而非旧指针，修复仍留告警事实", async () => {
    const from = await w.person("delivery_manager"),
      old = await w.person("delivery_manager"),
      current = await w.person("delivery_manager");
    const f = await follow(from.id);
    await w.prisma.staff.update({
      where: { id: from.id },
      data: { ...disabled(), handoverToStaffId: old.id },
    });
    await w.prisma.assignmentHistory.create({
      data: {
        id: uuidv7(),
        batchId: uuidv7(),
        source: "follow_up_owner",
        subjectType: "follow_up",
        subjectId: f.id,
        fromStaffId: from.id,
        toStaffId: current.id,
        reasonCode: "reassigned",
        actorType: "system",
        createdAt: w.clock.now(),
        updatedAt: w.clock.now(),
      },
    });
    expect(
      (await check("I1")).map((r) => (r.subject && "id" in r.subject ? r.subject.id : undefined)),
    ).toContain(from.id);
    expect(
      (await check("I13")).map((r) => (r.subject && "id" in r.subject ? r.subject.id : undefined)),
    ).toContain(f.id);
    const healed = await check("I10");
    expect(healed).toMatchObject([
      { healed: { action: "reassigned_to_current_handover_recipient" } },
    ]);
    expect((await w.prisma.followUp.findUniqueOrThrow({ where: { id: f.id } })).ownerStaffId).toBe(
      current.id,
    );
    expect(await check("I13")).toEqual([]);
  });
  it("I11旧非最新联系义务不允许；I12真实引用/复合归属，不存在引用拒绝不假零", async () => {
    const from = await w.person("delivery_manager"),
      to = await w.person("delivery_manager");
    const store = await w.make.store();
    const base = {
      batchId: uuidv7(),
      source: "store_manager",
      subjectType: "store",
      subjectId: store.id,
      fromStaffId: from.id,
      toStaffId: to.id,
      reasonCode: "reassigned",
      actorType: "system",
      contactDueAt: new Date(w.clock.now().getTime() + 60_000),
      slaSnapshot: {
        policy: "manager.first_contact",
        amount: 1,
        unit: "natural_hours",
        calendarVersion: 0,
        computedAt: w.clock.now().toISOString(),
      },
      createdAt: w.clock.now(),
      updatedAt: w.clock.now(),
    };
    const first = await w.prisma.assignmentHistory.create({ data: { ...base, id: uuidv7() } });
    await w.prisma.assignmentHistory.create({
      data: { ...base, id: uuidv7(), contactedAt: w.clock.now(), contactedByStaffId: to.id },
    });
    const noDeadlineFollow = await follow(to.id);
    const noDeadline = await w.prisma.assignmentHistory.create({
      data: {
        ...base,
        id: uuidv7(),
        source: "follow_up_owner",
        subjectType: "follow_up",
        subjectId: noDeadlineFollow.id,
        contactDueAt: null,
        slaSnapshot: undefined,
      },
    });
    const contactViolations = (await check("I11")).map((r) =>
      r.subject && "id" in r.subject ? r.subject.id : undefined,
    );
    expect(contactViolations).toContain(first.id);
    expect(contactViolations).not.toContain(noDeadline.id);
    const f = await follow(to.id);
    await w.prisma.followUp.update({
      where: { id: f.id },
      data: { subjectType: "order_item", subjectId: uuidv7() },
    });
    expect(
      (await check("I12")).map((r) => (r.subject && "id" in r.subject ? r.subject.id : undefined)),
    ).toContain(f.id);
  });
});
