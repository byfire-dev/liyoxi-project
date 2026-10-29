import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { assemble, defineRegistration, implementKeyed } from "../assembly/index.js";
import { createIdentityContext } from "../actor.js";
import type { Tx } from "../tx.js";
import { STAFF_WORK_OWNERS, staffWorkPort, staffWorkSourcesOf } from "./staff-work.js";
import type {
  StaffWorkItem,
  StaffWorkOwner,
  StaffWorkReassignment,
  StaffWorkSource,
} from "./staff-work.js";

const tx = {} as Tx;
const fromStaffId = "01900000-0000-7000-8000-000000000001";
const toStaffId = "01900000-0000-7000-8000-000000000002";
const now = new Date("2026-10-30T04:00:00.000Z");
const ad: StaffWorkItem = {
  source: "ad_editor",
  subjectType: "ad",
  subjectId: "01900000-0000-7000-8000-000000000003",
  label: "广告制作",
  entityId: "01900000-0000-7000-8000-000000000004",
  storeId: null,
  reassignOwner: "ad",
  locks: [{ table: "ad", id: "01900000-0000-7000-8000-000000000003" }],
};
const delivery: StaffWorkItem = {
  ...ad,
  source: "ticket_editor",
  subjectType: "delivery_ticket",
  subjectId: "01900000-0000-7000-8000-000000000005",
  reassignOwner: "delivery",
  locks: [{ table: "delivery_ticket", id: "01900000-0000-7000-8000-000000000005" }],
};
const input = (items: readonly StaffWorkItem[]): StaffWorkReassignment => ({
  fromStaffId,
  toStaffId,
  items,
  now,
  ctx: createIdentityContext({ actor: { type: "staff", id: fromStaffId, client: "admin" } }),
});
const idle: StaffWorkSource = { listOpen: async () => [], reassign: async () => [] };
function assembly(
  options: { omit?: StaffWorkOwner; ad?: StaffWorkSource; delivery?: StaffWorkSource } = {},
) {
  const entries = STAFF_WORK_OWNERS.filter((owner) => owner !== options.omit).map((owner) =>
    implementKeyed(staffWorkPort, owner, owner === "delivery" ? (options.delivery ?? idle) : idle),
  );
  if (options.ad) entries.push(implementKeyed(staffWorkPort, "ad", options.ad));
  return assemble({
    appEnv: "test",
    entry: "api",
    registrations: [
      defineRegistration("lyxtest_staff_work", {
        ports: [staffWorkPort],
        portImplementations: entries,
      }),
    ],
  });
}

describe("员工在办来源的兼容完整性声明", () => {
  it("任意广告与交付任务混排、重复均只交所属owner，成功结果不丢不增", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ adOwner: fc.boolean(), id: fc.integer({ min: 1, max: 6 }) }), {
          maxLength: 16,
        }),
        async (cases) => {
          const asked = cases.map(({ adOwner, id }) => ({
            ...(adOwner ? ad : delivery),
            subjectId: `01900000-0000-7000-8000-${String(id).padStart(12, "0")}`,
          }));
          const seen: StaffWorkItem[] = [];
          const owner = (key: StaffWorkOwner): StaffWorkSource => ({
            listOpen: async () => [],
            reassign: async (handle, received) => {
              expect(handle).toBe(tx);
              expect(received.items.every((item) => item.reassignOwner === key)).toBe(true);
              seen.push(...received.items);
              return received.items;
            },
          });
          const sources = staffWorkSourcesOf(
            assembly({ ad: owner("ad"), delivery: owner("delivery") }),
            { requiredOwners: ["ad"] },
          );
          const result = await sources.reassign(tx, input(asked));
          const keys = (items: readonly StaffWorkItem[]) =>
            items.map((item) => `${item.source}:${item.subjectType}:${item.subjectId}`).sort();
          expect(keys(seen)).toEqual(keys(asked));
          expect(keys(result)).toEqual([...new Set(keys(asked))]);
        },
      ),
      { seed: 20261030, numRuns: 20 },
    );
  });

  it.each(STAFF_WORK_OWNERS)("原必需来源%s缺失时，空声明也不能绕过读和改派守卫", async (owner) => {
    const sources = staffWorkSourcesOf(assembly({ omit: owner }), { requiredOwners: [] });
    for (const result of [
      sources.read(tx, { staffId: fromStaffId, now }),
      sources.reassign(tx, input([])),
    ])
      await expect(result).rejects.toMatchObject({
        error: "INTERNAL",
        details: { missingSources: [owner] },
      });
  });

  it("未声明ad时兼容既有五来源，且空改派不要求广告来源", async () => {
    const sources = staffWorkSourcesOf(assembly());
    expect(await sources.read(tx, { staffId: fromStaffId, now })).toEqual([]);
    expect(await sources.reassign(tx, input([]))).toEqual([]);
  });

  it("组合根声明ad必需后，缺源在读和空改派时都显式失败", async () => {
    const sources = staffWorkSourcesOf(assembly(), { requiredOwners: ["ad"] });
    await expect(sources.read(tx, { staffId: fromStaffId, now })).rejects.toMatchObject({
      error: "INTERNAL",
      details: { missingSources: ["ad"] },
    });
    await expect(sources.reassign(tx, input([]))).rejects.toMatchObject({
      error: "INTERNAL",
      details: { missingSources: ["ad"] },
    });
  });

  it("未声明ad也不能把广告改派静默跳过，混合输入在任何owner写入前失败", async () => {
    let moved = false;
    const sources = staffWorkSourcesOf(
      assembly({
        delivery: {
          listOpen: async () => [],
          reassign: async () => {
            moved = true;
            return [delivery];
          },
        },
      }),
    );
    await expect(sources.reassign(tx, input([delivery, ad]))).rejects.toMatchObject({
      error: "INTERNAL",
      details: { missingSources: ["ad"] },
    });
    expect(moved).toBe(false);
  });

  it.each([false, true])("已登记广告来源（required=%s）可读且保留原去重", async (required) => {
    const seen: unknown[] = [];
    const sources = staffWorkSourcesOf(
      assembly({
        ad: {
          listOpen: async (handle, query) => {
            seen.push(handle, query);
            return [ad, ad];
          },
          reassign: async () => [],
        },
      }),
      required ? { requiredOwners: ["ad"] } : {},
    );
    const query = { staffId: fromStaffId, now };
    expect(await sources.read(tx, query)).toEqual([ad]);
    expect(seen).toEqual([tx, query]);
  });

  it("混合对象只分派给各自owner，保留原顺序、事务、身份与锁描述，结果仍去重", async () => {
    const calls: { owner: string; tx: Tx; input: StaffWorkReassignment }[] = [];
    const owner = (key: string): StaffWorkSource => ({
      listOpen: async () => [],
      reassign: async (handle, asked) => {
        calls.push({ owner: key, tx: handle, input: asked });
        return asked.items;
      },
    });
    const sources = staffWorkSourcesOf(assembly({ ad: owner("ad"), delivery: owner("delivery") }), {
      requiredOwners: ["ad"],
    });
    const asked = input([ad, delivery, ad]);
    expect(await sources.reassign(tx, asked)).toEqual([delivery, ad]);
    expect(calls.map((c) => c.owner)).toEqual(["delivery", "ad"]);
    expect(calls.map((c) => c.input.items)).toEqual([[delivery], [ad, ad]]);
    for (const call of calls) {
      expect(call.tx).toBe(tx);
      expect(call.input.ctx).toBe(asked.ctx);
      expect(call.input.now).toBe(now);
      expect(call.input.fromStaffId).toBe(fromStaffId);
      expect(call.input.toStaffId).toBe(toStaffId);
    }
    expect(calls[1]!.input.items[0]).toBe(ad);
    expect(calls[1]!.input.items[0]!.locks).toBe(ad.locks);
  });

  it("广告owner重核后未返回对象，不能计为实际已改派", async () => {
    const sources = staffWorkSourcesOf(
      assembly({
        ad: {
          listOpen: async () => [ad],
          reassign: async () => [],
        },
      }),
      { requiredOwners: ["ad"] },
    );
    expect(await sources.reassign(tx, input([ad]))).toEqual([]);
  });

  it("相同业务对象被两个owner认领时仍明确拒绝", async () => {
    const sources = staffWorkSourcesOf(
      assembly({
        ad: { ...idle, listOpen: async () => [ad] },
        delivery: { ...idle, listOpen: async () => [{ ...ad, reassignOwner: "delivery" }] },
      }),
    );
    await expect(sources.read(tx, { staffId: fromStaffId, now })).rejects.toMatchObject({
      error: "INTERNAL",
    });
  });
});
