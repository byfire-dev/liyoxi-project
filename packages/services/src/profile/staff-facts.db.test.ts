import { Prisma } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../kernel/index.js";
import { decryptField, encryptField } from "../security/index.js";
import {
  sampleStaffContext,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";
import { harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";

const db = useSeededDatabase("services", { label: "stafffacts", max: 1 });
const tables = [
  "merchant_user",
  "entity",
  "entity_member",
  "store",
  "store_profile",
  "billing_account",
  "wecom_contact",
  "assignment_history",
  "audit_log",
  "status_transition",
  "outbox_event",
];
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120_000);
const snapshot = () => snapshotTables(h.prisma, tables);

describe("W2-11员工事实真实聚合两组风险", { timeout: 60_000 }, () => {
  it("仅实际active老板与当前经理的未移除企微关系为true，scope404、零写且不暴露标识/手机号", async () => {
    const own = await h.make.merchant(),
      wrongUser = await h.make.merchantUser(),
      manager = await h.make.staff({ staffRoleKey: "delivery_manager" }),
      wrongStaff = await h.make.staff({ staffRoleKey: "delivery_manager" }),
      admin = await sampleStaffContext(
        h.prisma,
        (await h.make.staff({ staffRoleKey: "super_admin" })).id,
      ),
      narrow = await sampleStaffContext(h.prisma, wrongStaff.id);
    await h.prisma.store.update({
      where: { id: own.store.id },
      data: { deliveryManagerId: manager.id },
    });
    const externalIds: string[] = [],
      ciphertexts: string[] = [];
    let sequence = 1;
    async function contact(userId: string, staffId: string, removed = false) {
      const external = `lyxtest-private-contact-${uuidv7()}`;
      const externalUseridEnc = encryptField(
        TEST_KEYRING,
        "wecom_contact.external_userid_enc",
        external,
      );
      externalIds.push(external);
      ciphertexts.push(externalUseridEnc);
      return h.prisma.wecomContact.create({
        data: {
          id: uuidv7(),
          merchantUserId: userId,
          staffId,
          externalUseridEnc,
          externalUseridBidx: Buffer.alloc(32, sequence++),
          unionid: `lyxtest-private-union-${sequence}`,
          addedAt: h.clock.now(),
          removedAt: removed ? h.clock.now() : null,
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
    }
    await contact(wrongUser.id, manager.id);
    await contact(own.user.id, wrongStaff.id);
    await contact(own.user.id, manager.id, true);
    const read = () => h.profile.admin.get(admin, own.store.id);
    const fullPhone = decryptField(TEST_KEYRING, "merchant_user.phone_enc", own.user.phoneEnc!);
    function privateFieldsAbsent(dto: Awaited<ReturnType<typeof read>>) {
      const serialized = JSON.stringify(dto);
      expect(serialized).not.toContain(fullPhone);
      for (const privateValue of [...externalIds, ...ciphertexts])
        expect(serialized).not.toContain(privateValue);
      expect(serialized).not.toMatch(/externalUserid|external_userid|unionid|phoneEnc|phoneBidx/);
      expect(dto.owner?.phoneMask).toBe(own.user.phoneMask);
    }

    let before = await snapshot();
    const unmatched = await read();
    expect(unmatched.isWecomAdded).toBe(false);
    privateFieldsAbsent(unmatched);
    await expect(h.profile.admin.get(narrow, own.store.id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    expect(await snapshot()).toEqual(before);

    const exact = await contact(own.user.id, manager.id);
    before = await snapshot();
    const matched = await read();
    expect(matched.isWecomAdded).toBe(true);
    privateFieldsAbsent(matched);
    expect(await snapshot()).toEqual(before);

    await h.prisma.store.update({ where: { id: own.store.id }, data: { deliveryManagerId: null } });
    before = await snapshot();
    expect((await read()).isWecomAdded).toBe(false);
    expect(await snapshot()).toEqual(before);

    await h.prisma.store.update({
      where: { id: own.store.id },
      data: { deliveryManagerId: manager.id },
    });
    await h.prisma.entityMember.update({
      where: { id: own.owner.id },
      data: {
        status: "removed",
        removedAt: h.clock.now(),
        removeReason: "owner_transfer",
        removeActorType: "system",
      },
    });
    before = await snapshot();
    const noActiveOwner = await read();
    expect(noActiveOwner).toMatchObject({ owner: null, isWecomAdded: false });
    expect(
      (await h.prisma.wecomContact.findUniqueOrThrow({ where: { id: exact.id } })).removedAt,
    ).toBeNull();
    expect(await snapshot()).toEqual(before);
  });

  it("仅exact来源/门店/当前接收人的未结义务生效，due相等不逾期、过1ms逾期且换经理使旧义务无效", async () => {
    const own = await h.make.merchant(),
      sibling = await h.make.store({ entityId: own.entity.id }),
      from = await h.make.staff({ staffRoleKey: "delivery_manager" }),
      manager = await h.make.staff({ staffRoleKey: "delivery_manager" }),
      other = await h.make.staff({ staffRoleKey: "delivery_manager" }),
      admin = await sampleStaffContext(
        h.prisma,
        (await h.make.staff({ staffRoleKey: "super_admin" })).id,
      ),
      due = h.clock.now(),
      createdAt = new Date(due.getTime() - 3_600_000);
    await h.prisma.store.update({
      where: { id: own.store.id },
      data: { deliveryManagerId: manager.id },
    });
    const sla = {
      policy: "manager.first_contact",
      amount: 1,
      unit: "natural_hours",
      calendarVersion: 0,
      computedAt: createdAt.toISOString(),
    };
    const assignment = (extra: Partial<Prisma.AssignmentHistoryUncheckedCreateInput> = {}) =>
      h.prisma.assignmentHistory.create({
        data: {
          id: uuidv7(),
          batchId: uuidv7(),
          source: "store_manager",
          subjectType: "store",
          subjectId: own.store.id,
          fromStaffId: from.id,
          toStaffId: manager.id,
          reasonCode: "reassigned",
          actorType: "system",
          contactDueAt: due,
          slaSnapshot: sla,
          createdAt,
          updatedAt: createdAt,
          ...extra,
        },
      });
    const exact = await assignment();
    // 较新历史必须被各事实守卫排除；多态ID碰撞也不能被当作门店联系义务。
    await assignment({ contactedAt: due, contactedByStaffId: manager.id, createdAt: due });
    await assignment({ contactVoidedAt: due, createdAt: due });
    await assignment({ toStaffId: other.id, createdAt: due });
    await assignment({ subjectId: sibling.id, createdAt: due });
    await assignment({
      source: "ticket_editor",
      subjectType: "delivery_ticket",
      contactDueAt: null,
      slaSnapshot: Prisma.DbNull,
      createdAt: due,
    });
    await assignment({
      subjectType: "drama_order",
      contactDueAt: null,
      slaSnapshot: Prisma.DbNull,
      createdAt: due,
    });
    const read = () => h.profile.admin.get(admin, own.store.id);

    let before = await snapshot();
    expect((await read()).managerContact).toEqual({
      assignmentHistoryId: exact.id,
      contactDueAt: due.toISOString(),
      isOverdue: false,
    });
    expect(await snapshot()).toEqual(before);
    h.clock.advance(1);
    before = await snapshot();
    expect((await read()).managerContact).toEqual({
      assignmentHistoryId: exact.id,
      contactDueAt: due.toISOString(),
      isOverdue: true,
    });
    expect(await snapshot()).toEqual(before);

    await h.prisma.store.update({
      where: { id: own.store.id },
      data: { deliveryManagerId: from.id },
    });
    before = await snapshot();
    expect((await read()).managerContact).toBeNull();
    expect(
      await h.prisma.assignmentHistory.findUniqueOrThrow({ where: { id: exact.id } }),
    ).toMatchObject({
      contactedAt: null,
      contactVoidedAt: null,
      contactDueAt: due,
      toStaffId: manager.id,
    });
    expect(await snapshot()).toEqual(before);
  });
});
