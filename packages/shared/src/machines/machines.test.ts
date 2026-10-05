// 迁移表的自测（任务书 W0-12 第 7 节第 3、4 条）。
//
//   1. 汇总与声明：一个模块一个文件、自动收集；与契约登记的状态机、状态列一一对应；状态取值就是契约的枚举。
//   2. 表驱动：照分组文档手写的合法、非法样例；再对每条链穷举（当前状态或新建）×（事件码）×（目标状态），
//      查表函数放行的恰好是表里声明的，其余全部拒绝。
//
// 迁移表与分组文档是否逐行一致不在这里查：那是 pnpm machines:check（scripts/machines-check.ts）。

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enumByColumn } from "@liyoxi/contract/enums";
import { STATE_MACHINES, STATE_MACHINE_NAMES } from "@liyoxi/contract/registry";
import { describe, expect, it } from "vitest";

import {
  ADMIN_FORCE_EVENT,
  CHAINS,
  CHAINS_BY_MODULE,
  SAME,
  chainOf,
  checkTransition,
  eventsOf,
  expandChain,
  findChain,
  findTransitions,
  initialStates,
  isForcedRow,
  terminalStates,
  type Chain,
} from "./index.js";

const machinesDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(machinesDir, "../../../..");

/** 不是迁移表的文件：声明形态、查表函数、入口 */
const NOT_MODULE_FILES = new Set(["define.ts", "lookup.ts", "index.ts"]);
const moduleFiles = readdirSync(machinesDir)
  .filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !NOT_MODULE_FILES.has(name),
  )
  .map((name) => name.slice(0, -3))
  .sort();

describe("一个模块一个文件，汇总自动收集", () => {
  it("目录里的模块文件与入口收的一一对应", () => {
    expect(Object.keys(CHAINS_BY_MODULE).sort()).toEqual(moduleFiles);
  });

  it("文件名是 services 的模块名（infra/ci/layers.json）", () => {
    const { modules } = JSON.parse(
      readFileSync(join(repoRoot, "infra/ci/layers.json"), "utf8"),
    ) as { modules: Record<string, string> };
    expect(moduleFiles.filter((name) => !(name in modules))).toEqual([]);
  });

  it("每个文件至少声明一条链；导出的都是链", async () => {
    for (const name of moduleFiles) {
      const exported = (await import(
        pathToFileURL(join(machinesDir, `${name}.ts`)).href
      )) as Record<string, unknown>;
      expect(Object.values(exported), name).toEqual(CHAINS_BY_MODULE[name]);
      expect(CHAINS_BY_MODULE[name]!.length, name).toBeGreaterThan(0);
    }
  });
});

describe("与契约的登记一一对应（06 第 3.2 节；01 分组 第 3.2 节）", () => {
  const registered = STATE_MACHINE_NAMES.flatMap((machine) =>
    STATE_MACHINES[machine].map((stateField) => `${machine}.${stateField}`),
  );

  it("契约登记的每个（状态机, 状态列）恰有一条链，没有多出来的", () => {
    expect(CHAINS.map((item) => item.column).sort()).toEqual([...registered].sort());
  });

  it("状态取值就是契约里绑定这一列的枚举，同一份数组", () => {
    for (const item of CHAINS) {
      expect(item.column).toBe(`${item.machine}.${item.stateField}`);
      expect(enumByColumn(item.column)?.values, item.column).toBe(item.states);
    }
  });

  it("按状态机与状态列取链", () => {
    expect(chainOf("entity", "lifecycle").column).toBe("entity.lifecycle");
    expect(chainOf("entity", "verification_status").column).toBe("entity.verification_status");
    expect(findChain("entity", "status")).toBeUndefined();
    expect(findChain("no_such_table", "status")).toBeUndefined();
    // @ts-expect-error 状态列不是这张表登记的
    expect(() => chainOf("staff", "lifecycle")).toThrow(/没有 staff\.lifecycle 的迁移表/);
  });
});

describe("行的写法", () => {
  const EVENT_CODE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

  it.each(CHAINS.map((item) => [item.column, item] as const))("%s", (_column, item) => {
    expect(item.rows.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const row of item.rows) {
      const where = `${row.ref} ${row.event}`;
      expect(row.ref, where).toMatch(/^\d{2}:\d+$/);
      expect(row.event, where).toMatch(EVENT_CODE);
      const lists = [row.from, row.to === SAME ? null : row.to].filter((list) => list !== null);
      for (const list of lists) {
        expect(list.length, where).toBeGreaterThan(0);
        expect(new Set(list).size, where).toBe(list.length);
        expect(
          list.filter((state) => !item.states.includes(state)),
          where,
        ).toEqual([]);
      }
      // 新建的行要写明落在哪个状态
      if (row.from === null) expect(row.to, where).not.toBe(SAME);
      // 同一行文档拆出来的几行（ref 相同）事件码或状态不能重复
      const key = JSON.stringify([row.ref, row.from, row.event, row.to]);
      expect(seen.has(key), where).toBe(false);
      seen.add(key);
    }
  });

  it("人工纠偏只在声明了它的链上：事件码固定为 admin.force", () => {
    const forced = CHAINS.filter((item) => item.rows.some(isForcedRow)).map((item) => item.column);
    expect(forced.sort()).toEqual(["delivery_ticket.step", "service_ticket.status"]);
    for (const item of CHAINS) {
      for (const row of item.rows.filter(isForcedRow)) {
        expect(row.event).toBe(ADMIN_FORCE_EVENT);
        expect(row.from, row.ref).not.toBeNull();
        expect(row.to, row.ref).not.toBe(SAME);
      }
    }
  });
});

// ---------- 表驱动：照分组文档手写的样例 ----------

type Sample = {
  column: string;
  from: string | null;
  event: string;
  to?: string;
} & ({ ok: string } | { rejected: string; candidates?: string[] });

/** 合法的写迁移后的状态；非法的写原因。出处是各分组文档的状态机表，不是从迁移表反推的 */
const SAMPLES: Sample[] = [
  // 02 分组：商家用户
  { column: "merchant_user.status", from: null, event: "merchant_user.register", ok: "active" },
  {
    column: "merchant_user.status",
    from: "active",
    event: "merchant_user.disable",
    ok: "disabled",
  },
  { column: "merchant_user.status", from: "disabled", event: "merchant_user.enable", ok: "active" },
  {
    column: "merchant_user.status",
    from: "active",
    event: "merchant_user.enable",
    rejected: "not_from_state",
  },
  {
    column: "merchant_user.status",
    from: "disabled",
    event: "merchant_user.delete",
    rejected: "not_from_state",
  },
  {
    column: "merchant_user.status",
    from: "deleted",
    event: "merchant_user.enable",
    rejected: "not_from_state",
  },
  {
    column: "merchant_user.status",
    from: "active",
    event: "merchant_user.register",
    rejected: "not_from_state",
  },
  {
    column: "merchant_user.status",
    from: "active",
    event: "staff.disable",
    rejected: "unknown_event",
  },
  {
    column: "merchant_user.status",
    from: "active",
    event: "merchant_user.disable",
    to: "deleted",
    rejected: "target_not_allowed",
    candidates: ["disabled"],
  },
  // 02 分组：主体的两条链互不相干
  { column: "entity.lifecycle", from: "active", event: "entity.close", ok: "closed" },
  { column: "entity.lifecycle", from: "closed", event: "entity.close", rejected: "not_from_state" },
  {
    column: "entity.lifecycle",
    from: "active",
    event: "qualification.submit",
    rejected: "unknown_event",
  },
  {
    column: "entity.verification_status",
    from: "rejected",
    event: "qualification.submit",
    ok: "pending",
  },
  {
    column: "entity.verification_status",
    from: "pending",
    event: "qualification.withdraw",
    rejected: "target_required",
    candidates: ["unsubmitted", "rejected"],
  },
  {
    column: "entity.verification_status",
    from: "pending",
    event: "qualification.withdraw",
    to: "unsubmitted",
    ok: "unsubmitted",
  },
  {
    column: "entity.verification_status",
    from: "pending",
    event: "qualification.withdraw",
    to: "verified",
    rejected: "target_not_allowed",
    candidates: ["unsubmitted", "rejected"],
  },
  {
    column: "entity.verification_status",
    from: "verified",
    event: "qualification.submit",
    rejected: "not_from_state",
  },
  // 02 分组：变更重审不改门店的资质结论，照常写一行
  {
    column: "store.qualification_status",
    from: "verified",
    event: "qualification.change_approve",
    ok: "verified",
  },
  {
    column: "store.qualification_status",
    from: "pending",
    event: "qualification.change_approve",
    rejected: "not_from_state",
  },
  // 02 分组：店员升为老板不改状态
  {
    column: "entity_member.status",
    from: "active",
    event: "entity_member.promote_owner",
    ok: "active",
  },
  {
    column: "entity_member.status",
    from: "removed",
    event: "entity_member.promote_owner",
    rejected: "not_from_state",
  },
  // 03 分组：员工
  {
    column: "staff.status",
    from: null,
    event: "staff.create",
    rejected: "target_required",
    candidates: ["active", "pending"],
  },
  { column: "staff.status", from: null, event: "staff.create", to: "pending", ok: "pending" },
  {
    column: "staff.status",
    from: null,
    event: "staff.create",
    to: "disabled",
    rejected: "target_not_allowed",
    candidates: ["active", "pending"],
  },
  { column: "staff.status", from: null, event: "staff.bootstrap", ok: "active" },
  { column: "staff.status", from: "pending", event: "staff.enable", ok: "active" },
  { column: "staff.status", from: "disabled", event: "staff.enable", ok: "active" },
  { column: "staff.status", from: "active", event: "staff.enable", rejected: "not_from_state" },
  { column: "staff.status", from: "pending", event: "staff.disable", rejected: "not_from_state" },
  { column: "staff.status", from: null, event: "staff.enable", rejected: "not_from_state" },
  // 03 分组：审批单的终态不可逆
  { column: "approval_request.status", from: "pending", event: "approve", ok: "approved" },
  {
    column: "approval_request.status",
    from: "approved",
    event: "withdraw",
    rejected: "not_from_state",
  },
  {
    column: "approval_request.status",
    from: "rejected",
    event: "approve",
    rejected: "not_from_state",
  },
  // 08 分组：付款单
  { column: "billing_order.status", from: "cancelled", event: "billing_order.restore", ok: "paid" },
  {
    column: "billing_order.status",
    from: "paid",
    event: "billing_order.cancel",
    rejected: "not_from_state",
  },
  {
    column: "billing_order.status",
    from: "refunded",
    event: "billing_order.refund",
    rejected: "not_from_state",
  },
  {
    column: "billing_order.status",
    from: "pending_confirmation",
    event: "billing_order.submit_proof",
    rejected: "not_from_state",
  },
  // 08 分组：退款申请没有执行成功不能直接完成；失败回到待执行
  {
    column: "refund_request.status",
    from: "executing",
    event: "refund.fail",
    ok: "pending_execution",
  },
  {
    column: "refund_request.status",
    from: "pending_approval",
    event: "refund.execute",
    rejected: "not_from_state",
  },
  {
    column: "refund_request.status",
    from: "done",
    event: "refund.void",
    rejected: "not_from_state",
  },
  // 09 分组：订单项
  {
    column: "order_item.phase",
    from: "producing",
    event: "ticket.terminate",
    rejected: "target_required",
    candidates: ["refunded", "terminated"],
  },
  {
    column: "order_item.phase",
    from: "live",
    event: "ticket.terminate",
    rejected: "not_from_state",
  },
  { column: "order_item.phase", from: "pending_start", event: "cancel.execute", ok: "cancelled" },
  {
    column: "order_item.phase",
    from: "producing",
    event: "cancel.execute",
    rejected: "not_from_state",
  },
  // 09 分组：已确认的广告不可取消
  { column: "ad.status", from: "confirmed", event: "ad.cancel", rejected: "not_from_state" },
  { column: "ad.status", from: "returned", event: "ad.cancel", ok: "cancelled" },
  {
    column: "ad.status",
    from: "returned",
    event: "ad.resubmit",
    to: "producing",
    ok: "producing",
  },
  // 10 分组：交付工单
  {
    column: "delivery_ticket.step",
    from: null,
    event: "ticket.created",
    to: "plan_confirm",
    ok: "plan_confirm",
  },
  {
    column: "delivery_ticket.step",
    from: null,
    event: "ticket.created",
    to: "ad_prep",
    rejected: "target_not_allowed",
    candidates: ["assigning", "plan_confirm"],
  },
  {
    column: "delivery_ticket.step",
    from: "sample_confirm",
    event: "sample.change_requested",
    rejected: "target_required",
    candidates: ["sample_making", "ad_prep"],
  },
  { column: "delivery_ticket.step", from: "assigning", event: "ticket.hold", ok: "assigning" },
  {
    column: "delivery_ticket.step",
    from: "in_service",
    event: "ticket.hold",
    rejected: "not_from_state",
  },
  {
    column: "delivery_ticket.step",
    from: "launch_verify",
    event: "ticket.terminate",
    ok: "terminated",
  },
  { column: "delivery_ticket.step", from: "in_service", event: "ticket.terminate", ok: "takedown" },
  { column: "delivery_ticket.step", from: "takedown", event: "ticket.terminate", ok: "takedown" },
  {
    column: "delivery_ticket.step",
    from: "archived",
    event: "ticket.terminate",
    rejected: "not_from_state",
  },
  {
    column: "delivery_ticket.step",
    from: "terminated",
    event: "ticket.resume",
    rejected: "not_from_state",
  },
  {
    column: "delivery_ticket.step",
    from: "ad_prep",
    event: "plan.confirmed",
    rejected: "not_from_state",
  },
  // 10 分组：人工纠偏只认白名单里的步骤对
  { column: "delivery_ticket.step", from: "takedown", event: "admin.force", ok: "in_service" },
  { column: "delivery_ticket.step", from: "ad_prep", event: "admin.force", ok: "plan_confirm" },
  {
    column: "delivery_ticket.step",
    from: "delivering",
    event: "admin.force",
    to: "sample_making",
    ok: "sample_making",
  },
  {
    column: "delivery_ticket.step",
    from: "ad_prep",
    event: "admin.force",
    to: "in_service",
    rejected: "target_not_allowed",
    candidates: ["plan_confirm"],
  },
  {
    column: "delivery_ticket.step",
    from: "plan_confirm",
    event: "admin.force",
    rejected: "not_from_state",
  },
  // 10 分组：方案在待确认时再推送仍是待确认
  {
    column: "delivery_plan.status",
    from: "pending_confirm",
    event: "plan.push",
    ok: "pending_confirm",
  },
  {
    column: "delivery_plan.status",
    from: "drafting",
    event: "plan.confirm",
    rejected: "not_from_state",
  },
  // 11 分组：下架任务的升级与违约提醒不改状态
  {
    column: "takedown_task.status",
    from: "pending_merchant",
    event: "takedown.escalate",
    ok: "pending_merchant",
  },
  {
    column: "takedown_task.status",
    from: "checked",
    event: "takedown.escalate",
    rejected: "not_from_state",
  },
  { column: "channel_account.status", from: "abnormal", event: "account.unbind", ok: "unbound" },
  {
    column: "channel_account.status",
    from: "unbound",
    event: "account.unbind",
    rejected: "not_from_state",
  },
  // 12 分组：客服工单
  { column: "service_ticket.status", from: "resolved", event: "reopen", ok: "processing" },
  { column: "service_ticket.status", from: "closed", event: "reopen", rejected: "not_from_state" },
  { column: "service_ticket.status", from: "closed", event: "admin.force", ok: "processing" },
  { column: "service_ticket.status", from: "processing", event: "transfer", ok: "processing" },
  {
    column: "service_ticket.status",
    from: "resolved",
    event: "assign",
    rejected: "not_from_state",
  },
  { column: "service_ticket.status", from: null, event: "register", ok: "processing" },
  // 13 分组：授权书
  {
    column: "license_letter.status",
    from: null,
    event: "license_letter.create",
    to: "effective",
    ok: "effective",
  },
  {
    column: "license_letter.status",
    from: "voided",
    event: "license_letter.go_live",
    rejected: "not_from_state",
  },
];

const chainByColumn = (column: string): Chain => {
  const [machine, stateField] = column.split(".");
  const found = findChain(machine!, stateField!);
  if (!found) throw new Error(`没有 ${column} 的迁移表`);
  return found;
};

describe("非法迁移被拒：照分组文档手写的样例", () => {
  it.each(
    SAMPLES.map((sample) => [
      `${sample.column}：${sample.from ?? "（新建）"} --${sample.event}--> ${sample.to ?? "（不指定）"}`,
      sample,
    ]),
  )("%s", (_title, sample) => {
    const result = checkTransition(chainByColumn(sample.column), sample);
    if ("ok" in sample) {
      expect(result).toMatchObject({ ok: true, to: sample.ok });
    } else {
      expect(result).toMatchObject({ ok: false, reason: sample.rejected });
      if (sample.candidates) expect(result).toMatchObject({ candidates: sample.candidates });
    }
  });

  it("样例里合法、非法两种都有，四种拒绝原因都出现过", () => {
    expect(SAMPLES.filter((sample) => "ok" in sample).length).toBeGreaterThan(20);
    const reasons = new Set(
      SAMPLES.flatMap((sample) => ("rejected" in sample ? [sample.rejected] : [])),
    );
    expect([...reasons].sort()).toEqual([
      "not_from_state",
      "target_not_allowed",
      "target_required",
      "unknown_event",
    ]);
  });
});

// ---------- 表驱动：逐条链穷举 ----------

const UNKNOWN_EVENT = "lyx_selftest.no_such_event";

describe("非法迁移被拒：逐条链穷举（当前状态或新建）×（事件码）×（目标状态）", () => {
  it.each(CHAINS.map((item) => [item.column, item] as const))("%s", (_column, item) => {
    // 表里声明的三元组：直接读行，不经查表函数
    const declared = new Set<string>();
    for (const row of item.rows) {
      for (const from of row.from ?? [null]) {
        const targets = row.to === SAME ? [from] : row.to;
        for (const to of targets) declared.add(JSON.stringify([from, row.event, to]));
      }
    }
    expect(
      new Set(expandChain(item).map(({ from, event, to }) => JSON.stringify([from, event, to]))),
    ).toEqual(declared);

    let allowed = 0;
    let rejected = 0;
    for (const from of [null, ...item.states]) {
      for (const event of [...eventsOf(item), UNKNOWN_EVENT]) {
        const candidates = item.states.filter((to) =>
          declared.has(JSON.stringify([from, event, to])),
        );
        for (const to of item.states) {
          const result = checkTransition(item, { from, event, to });
          const where = `${from ?? "（新建）"} --${event}--> ${to}`;
          if (candidates.includes(to)) {
            allowed += 1;
            expect(result, where).toMatchObject({ ok: true, to });
            if (result.ok) expect(result.rows.length, where).toBeGreaterThan(0);
          } else {
            rejected += 1;
            expect(result.ok, where).toBe(false);
            if (result.ok) continue;
            const expectedReason =
              event === UNKNOWN_EVENT
                ? "unknown_event"
                : candidates.length === 0
                  ? "not_from_state"
                  : "target_not_allowed";
            expect(result.reason, where).toBe(expectedReason);
            expect([...result.candidates].sort(), where).toEqual([...candidates].sort());
          }
        }
        // 不给目标：候选恰好一个才放行
        const implicit = checkTransition(item, { from, event });
        if (candidates.length === 1)
          expect(implicit).toMatchObject({ ok: true, to: candidates[0] });
        else expect(implicit.ok, `${from ?? "（新建）"} --${event}--> （不指定）`).toBe(false);
        expect(findTransitions(item, from, event).length > 0).toBe(candidates.length > 0);
      }
    }
    expect(allowed).toBe(declared.size);
    // 每条链都有被拒的组合：至少“不存在的事件码”那一列
    expect(rejected).toBeGreaterThanOrEqual((item.states.length + 1) * item.states.length);
  });
});

describe("终态与新建", () => {
  it.each([
    ["merchant_user.status", ["deleted"]],
    ["entity.lifecycle", ["abandoned", "closed"]],
    ["invitation.status", ["accepted", "revoked", "expired"]],
    ["approval_request.status", ["approved", "rejected", "withdrawn"]],
    ["billing_order.status", ["refunded"]],
    ["delivery_ticket.step", ["archived", "terminated"]],
    // closed 只有人工纠偏能带回处理中，仍算终态
    ["service_ticket.status", ["closed"]],
    ["license_letter.status", ["voided"]],
  ])("%s 的终态", (column, expected) => {
    expect(terminalStates(chainByColumn(column))).toEqual(expected);
  });

  it("终态之后没有能改变状态的迁移（人工纠偏除外）", () => {
    for (const item of CHAINS) {
      const terminal = new Set(terminalStates(item));
      const leaving = expandChain(item).filter(
        ({ from, to, row }) =>
          from !== null && terminal.has(from) && to !== from && !isForcedRow(row),
      );
      expect(leaving, item.column).toEqual([]);
    }
  });

  it.each([
    ["staff.status", ["pending", "active"]],
    ["delivery_ticket.step", ["assigning", "plan_confirm"]],
    ["service_ticket.status", ["pending", "processing"]],
    ["payment_exception.status", ["open", "auto_healed"]],
    // 主体的认证结论、门店的资质结论随行建好，没有自己的新建迁移
    ["entity.verification_status", []],
    ["store.qualification_status", []],
  ])("%s 新建时落在哪", (column, expected) => {
    expect(initialStates(chainByColumn(column))).toEqual(expected);
  });
});
