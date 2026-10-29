// 对照脚本的自测（任务书 W0-12 第 7 节第 5 条）：解析规则逐条有正例、反例；真实文档上 0 差异；
// 改坏的数据（迁移表一侧、文档一侧、清单）各报得出来。
import { describe, expect, it } from "vitest";

import {
  CHAINS,
  NO_GUARD,
  SAME,
  findChain,
  type Chain,
  type TransitionRow,
} from "../src/machines/index.js";

import {
  NO_HISTORY_MARK,
  backticked,
  checkMachines,
  compareChain,
  declaredTables,
  eventCodesIn,
  layoutOf,
  loadDocSources,
  nearestAssignment,
  parseDocRow,
  parseKernelMachineTable,
  registryProblems,
  splitRow,
  statesIn,
  tableAround,
  type DocSources,
} from "./machines-check.js";

const sources = loadDocSources();

const chainAt = (column: string): Chain => {
  const [machine, stateField] = column.split(".");
  const found = findChain(machine!, stateField!);
  if (!found) throw new Error(`没有 ${column}`);
  return found;
};

/** 换掉一条链的行 */
const withRows = (
  column: string,
  change: (rows: readonly TransitionRow[]) => readonly TransitionRow[],
): Chain => {
  const original = chainAt(column);
  return { ...original, rows: change(original.rows) };
};

/** 改某一行（按 ref 与事件码找） */
const patchRow = (
  column: string,
  ref: string,
  event: string,
  patch: Partial<TransitionRow>,
): Chain =>
  withRows(column, (rows) => {
    const hit = rows.filter((row) => row.ref === ref && row.event === event);
    if (hit.length !== 1) throw new Error(`${column} 里 ${ref} ${event} 应恰好一行`);
    return rows.map((row) => (row === hit[0] ? { ...row, ...patch } : row));
  });

/** 改分组文档的某一行（只在内存里） */
const withDocLine = (
  groupId: string,
  line: number,
  change: (text: string) => string,
): DocSources => {
  const group = sources.groups.get(groupId)!;
  const lines = [...group.lines];
  const before = lines[line - 1]!;
  lines[line - 1] = change(before);
  if (lines[line - 1] === before) throw new Error(`${groupId}:${line} 没有改到`);
  return { ...sources, groups: new Map([...sources.groups, [groupId, { ...group, lines }]]) };
};

describe("解析：单元格", () => {
  it("拆行：去掉首尾竖线；转义的竖线不拆", () => {
    expect(splitRow("| a | `b` c |  | d |")).toEqual(["a", "`b` c", "", "d"]);
    expect(splitRow("| a \\| b | c |")).toEqual(["a \\| b", "c"]);
  });

  it("反引号里的记号，按出现的先后", () => {
    expect(backticked("`active`（clerk）、`removed`；没有引号的 active 不算")).toEqual([
      "active",
      "removed",
    ]);
    expect(backticked("—")).toEqual([]);
  });

  it("状态：反引号括起且属于本列枚举的才算；去重", () => {
    const states = ["pending_payment", "pending_confirmation", "paid"];
    expect(statesIn("`pending_payment`（`awaiting_proof` / `proof_rejected`）", states)).toEqual([
      "pending_payment",
    ]);
    expect(statesIn("`paid` /（`proof_submitted`）", states)).toEqual(["paid"]);
    expect(statesIn("`paid`、`paid`", states)).toEqual(["paid"]);
    expect(statesIn("步骤 1～9", states)).toEqual([]);
    // 没有反引号的不算
    expect(statesIn("paid", states)).toEqual([]);
  });

  it("事件码：带点的优先；括号参数去掉；不合写法的不算", () => {
    expect(eventCodesIn("首次手机号登录（`merchant_user.register`）；按号码建号")).toEqual([
      "merchant_user.register",
    ]);
    expect(eventCodesIn("`ticket.hold(reason, ref)`")).toEqual(["ticket.hold"]);
    // 有带点的：不带点的记号（轮次名、别的表的状态、差异类型）都不算事件码
    expect(eventCodesIn("`initial` 轮次提交（`qualification.submit`）")).toEqual([
      "qualification.submit",
    ]);
    expect(eventCodesIn("工单进入 `awaiting_launch`（`package.pushed`）")).toEqual([
      "package.pushed",
    ]);
    // 没有带点的：取不带点的（审批单、客服工单的事件码就是一段）
    expect(eventCodesIn("`submit` 提交")).toEqual(["submit"]);
    // 一格写了几个事件码
    expect(
      eventCodesIn("老板移除（`entity_member.remove`）、本人退出（`entity_member.leave`）"),
    ).toEqual(["entity_member.remove", "entity_member.leave"]);
    // 大写、带空格、带路径的都不是事件码
    expect(eventCodesIn("收款入账 `applyPayment`；`POST /m/entities`；`mode = release`")).toEqual(
      [],
    );
    expect(eventCodesIn("回复、内部备注、商家补充说明")).toEqual([]);
  });
});

describe("解析：表格", () => {
  it("表头：认三种叫法；守卫一栏可以带后缀；多出的栏不碍事", () => {
    expect(layoutOf(["当前状态", "事件", "新状态", "守卫", "触发者"])).toEqual({
      kind: "columns",
      from: 0,
      event: 1,
      to: 2,
      guard: 3,
    });
    expect(layoutOf(["#", "当前步骤", "事件", "新步骤", "守卫", "触发者"])).toMatchObject({
      from: 1,
      event: 2,
      to: 3,
      guard: 4,
    });
    expect(layoutOf(["当前阶段", "事件", "新阶段", "守卫与写入"])).toMatchObject({ guard: 3 });
    expect(layoutOf(["触发", "可能的变化", "触发者"])).toEqual({
      kind: "derived",
      event: 0,
      change: 1,
    });
  });

  it("表头：别的表不认（子状态表、推导条件表、定时器表）", () => {
    expect(layoutOf(["当前", "事件", "新值", "说明"])).toBeNull();
    expect(layoutOf(["推导条件", "状态"])).toBeNull();
    expect(layoutOf(["定时器", "去重键", "登记", "触发时间", "取消"])).toBeNull();
  });

  const doc = [
    "前言", // 1
    "", // 2
    "| 当前状态 | 事件 | 新状态 | 守卫 |", // 3
    "| --- | --- | --- | --- |", // 4
    "| — | `x.create` | `a` | — |", // 5
    "| `a` | `x.go` | `b` | 有 |", // 6
    "", // 7
    "说明：事件名 `x.note`。", // 8
  ];

  it("某一行所在的表格：只认数据行", () => {
    expect(tableAround(doc, 5)).toEqual({ headerLine: 3, dataLines: [5, 6] });
    expect(tableAround(doc, 6)).toEqual({ headerLine: 3, dataLines: [5, 6] });
    // 表头、分隔行、表格之外的行都不是数据行
    expect(tableAround(doc, 3)).toBeNull();
    expect(tableAround(doc, 4)).toBeNull();
    expect(tableAround(doc, 8)).toBeNull();
    expect(tableAround(doc, 1)).toBeNull();
  });

  it("往上找最近的“键 = 值”：带反引号、单引号都认；一行几处取最后一处", () => {
    const lines = [
      "**状态机**（`machine = entity`；两个状态列）",
      "生命周期（`state_field = lifecycle`）：",
      "| 表 |",
      "认证结论（`state_field = 'verification_status'`；machine = `store`，state_field = `status`）",
      "| 表 |",
    ];
    expect(nearestAssignment(lines, 3, "machine")).toBe("entity");
    expect(nearestAssignment(lines, 3, "state_field")).toBe("lifecycle");
    expect(nearestAssignment(lines, 5, "machine")).toBe("store");
    expect(nearestAssignment(lines, 5, "state_field")).toBe("status");
    expect(nearestAssignment(["没有"], 1, "machine")).toBeNull();
  });

  it("只在同一小节里找：隔着标题的不算", () => {
    const lines = [
      "`machine = entity`，`state_field = lifecycle`",
      "### 2.2 别的表",
      "说明",
      "| 表 |",
    ];
    expect(nearestAssignment(lines, 4, "machine")).toBeNull();
    expect(nearestAssignment(lines, 1, "machine")).toBe("entity");
  });
});

describe("解析：一行", () => {
  const header = ["当前状态", "事件", "新状态", "守卫", "触发者"];
  const layout = layoutOf(header)!;
  const states = ["pending", "active", "disabled"];
  const parse = (text: string) => parseDocRow(layout, header, text, 7, states);

  it("迁移行：新建、几个当前状态、不变、有无守卫", () => {
    expect(parse("| — | 新增（`staff.create`） | `pending` | 同上 | 超级管理员 |")).toEqual({
      kind: "transition",
      line: 7,
      from: null,
      events: ["staff.create"],
      to: ["pending"],
      guard: true,
    });
    expect(
      parse("| `pending`、`disabled` | `staff.enable` | `active`（待激活） | — | 员工 |"),
    ).toEqual({
      kind: "transition",
      line: 7,
      from: ["pending", "disabled"],
      events: ["staff.enable"],
      to: ["active"],
      guard: false,
    });
    expect(parse("| `active` | `staff.touch` | 不变（from = to） | 有 | 员工 |")).toMatchObject({
      to: SAME,
    });
  });

  it("散文写的状态读成空数组，由对照报出来", () => {
    expect(parse("| 任意状态 | `staff.x` | 提交前的值 | — | 系统 |")).toMatchObject({
      from: [],
      to: [],
    });
  });

  it("终态声明：事件格是“任何”", () => {
    expect(parse("| `disabled` | 任何 | 不变 | — | — |")).toEqual({
      kind: "terminal",
      line: 7,
      states: ["disabled"],
    });
  });

  it("没有事件码的行：写明“不写状态历史”才算数，否则读不出来", () => {
    expect(parse(`| \`active\` | 改备注 | 不变 | 只写审计，${NO_HISTORY_MARK} | 员工 |`)).toEqual({
      kind: "no_history",
      line: 7,
    });
    expect(() => parse("| `active` | 改备注 | 不变 | 只写审计 | 员工 |")).toThrow(
      /没有事件码，也没有写明“不写状态历史”/,
    );
  });

  it("格数与表头不一致：读不出来", () => {
    expect(() => parse("| `active` | `staff.x` | `disabled` | — |")).toThrow(/4 格，表头有 5 格/);
  });

  it("推导表：“→”左右是当前与新状态；“—”是新建；不比守卫", () => {
    const derivedHeader = ["触发", "可能的变化", "触发者"];
    const derived = layoutOf(derivedHeader)!;
    const parseDerived = (text: string) => parseDocRow(derived, derivedHeader, text, 9, states);
    expect(parseDerived("| 确认 `order.submit` | — → `pending`（新建） | 商家 |")).toEqual({
      kind: "transition",
      line: 9,
      from: null,
      events: ["order.submit"],
      to: ["pending"],
      guard: null,
    });
    expect(
      parseDerived("| 重新推导（`order.rederive`） | `pending`、`active` → `disabled` | 系统 |"),
    ).toMatchObject({ from: ["pending", "active"], to: ["disabled"] });
    expect(() =>
      parseDerived("| `order.rederive` | 在 `pending`、`active` 之间变化 | 系统 |"),
    ).toThrow(/恰好有一个“→”/);
  });
});

describe("01 分组 第 3.2 节的表", () => {
  it("并列的状态机与状态列展开成一对一对；括号里的说明不算", () => {
    const lines = [
      "### 3.2 清单",
      "| 分组 | `machine` | `state_field` |",
      "| --- | --- | --- |",
      "| 02 | `entity` | `lifecycle`（生命周期）、`verification_status`（认证结论） |",
      "| 08 | `billing_order`、`refund_request` | `status`（`billing_order` 的 `transfer_state` 是子状态，不写本表） |",
      "### 3.3 别的",
    ];
    expect(parseKernelMachineTable(lines)).toEqual([
      "entity.lifecycle",
      "entity.verification_status",
      "billing_order.status",
      "refund_request.status",
    ]);
  });

  it("找不到这一节、读不出内容：抛错，不当成空清单", () => {
    expect(() => parseKernelMachineTable(["### 3.1 别的", "### 3.3 别的"])).toThrow(
      /找不到第 3\.2 节/,
    );
    expect(() => parseKernelMachineTable(["### 3.2 清单", "没有表", "### 3.3 别的"])).toThrow(
      /读不出内容/,
    );
  });
});

describe("真实的迁移表与分组文档：0 差异（验收 1–3）", () => {
  const result = checkMachines();

  it("差异 0", () => {
    expect(result.problems).toEqual([]);
  });

  it("每条链都认领到表格；分组文档这些表格的每一行都归了类", () => {
    for (const [column, report] of result.reports) {
      expect(report.tables.length, column).toBeGreaterThan(0);
      expect(report.transitionRows, column).toBeGreaterThan(0);
    }
    const reports = [...result.reports.values()];
    const total = (pick: (report: (typeof reports)[number]) => number) =>
      reports.reduce((sum, report) => sum + pick(report), 0);
    // 迁移表的行数 = 文档迁移行各自的事件码数 + 人工纠偏按白名单多拆出来的行 + 表外行，所以不少于文档的迁移行数
    const tableRows = CHAINS.reduce((sum, item) => sum + item.rows.length, 0);
    expect(tableRows).toBeGreaterThanOrEqual(total((r) => r.transitionRows));
    expect(total((r) => r.terminalRows)).toBeGreaterThan(0);
    expect(total((r) => r.noHistoryRows)).toBeGreaterThan(0);
  });

  it("文档里写明了归属的状态机表，恰好是每条链一张，都被认领", () => {
    const declared = declaredTables(sources);
    expect(declared.map((table) => table.column).sort()).toEqual(
      CHAINS.map((item) => item.column).sort(),
    );
    for (const table of declared) {
      expect(result.reports.get(table.column)?.tables, table.column).toEqual([table.at]);
    }
  });

  it("表外行只有写在说明里的那些：那一行写着事件码", () => {
    const outside = [...result.reports.values()].flatMap((report) => report.outsideRows);
    expect(outside).toEqual([
      "08:1133 sla.recalculated",
      "10:196 ticket.created",
      "10:1377 reissue.cancelled",
      "10:1375 sla.recalculated",
    ]);
  });
});

describe("改坏的数据：对照报得出来", () => {
  const problemsOf = (chain: Chain, docs: DocSources = sources) =>
    compareChain(chain, docs).problems;

  it("迁移表少一行", () => {
    const broken = withRows("invitation.status", (rows) =>
      rows.filter((row) => row.ref !== "02:789"),
    );
    expect(problemsOf(broken)).toEqual([
      "invitation.status：文档有而迁移表没有：02:789（事件码 invitation.expire）",
    ]);
  });

  it("改一个目标状态；改成不变", () => {
    expect(
      problemsOf(
        patchRow("merchant_user.status", "02:126", "merchant_user.disable", { to: ["deleted"] }),
      ),
    ).toEqual([
      "merchant_user.status：02:126 merchant_user.disable 的新状态：文档 disabled，迁移表 deleted",
    ]);
    expect(
      problemsOf(patchRow("merchant_user.status", "02:126", "merchant_user.disable", { to: SAME })),
    ).toEqual([
      "merchant_user.status：02:126 merchant_user.disable 的新状态：文档 disabled，迁移表 不变",
    ]);
  });

  it("改当前状态；把新建改成从某个状态来", () => {
    expect(
      problemsOf(
        patchRow("merchant_user.status", "02:127", "merchant_user.enable", {
          from: ["disabled", "deleted"],
        }),
      )[0],
    ).toBe(
      "merchant_user.status：02:127 merchant_user.enable 的当前状态：文档 disabled，迁移表 disabled、deleted",
    );
    expect(
      problemsOf(
        patchRow("merchant_user.status", "02:125", "merchant_user.register", {
          from: ["disabled"],
        }),
      ),
    ).toEqual([
      "merchant_user.status：02:125 merchant_user.register 的当前状态：文档 （新建），迁移表 disabled",
    ]);
  });

  it("改事件码；一行文档的几个事件码少登一个", () => {
    expect(
      problemsOf(
        patchRow("merchant_user.status", "02:126", "merchant_user.disable", {
          event: "merchant_user.ban",
        }),
      ),
    ).toEqual([
      "merchant_user.status：02:126 的事件码：文档 merchant_user.disable，迁移表 merchant_user.ban",
    ]);
    const missingOne = withRows("entity_member.status", (rows) =>
      rows.filter((row) => !(row.ref === "02:692" && row.event === "entity_member.leave")),
    );
    expect(problemsOf(missingOne)).toEqual([
      "entity_member.status：02:692 的事件码：文档 entity_member.remove、entity_member.leave、entity_member.cascade_remove，迁移表 entity_member.remove、entity_member.cascade_remove",
    ]);
  });

  it("守卫写反", () => {
    expect(
      problemsOf(
        patchRow("entity.verification_status", "02:542", "qualification.reject", { guard: true }),
      ),
    ).toEqual([
      "entity.verification_status：02:542 qualification.reject 的守卫：文档是“—”，迁移表标的是有",
    ]);
    expect(
      problemsOf(
        patchRow("entity.verification_status", "02:541", "qualification.approve", NO_GUARD),
      ),
    ).toEqual([
      "entity.verification_status：02:541 qualification.approve 的守卫：文档写了守卫，迁移表标的是没有",
    ]);
  });

  it("引用指到不存在的行、指到表格之外又没写事件码的行、写法不对", () => {
    const moved = (ref: string) => patchRow("staff.status", "03:221", "staff.disable", { ref });
    expect(problemsOf(moved("03:999999"))).toContain(
      "staff.status：03:999999 超出了 03-staff-authz-audit.md 的行数",
    );
    expect(problemsOf(moved("03:1"))).toContain(
      "staff.status：03:1 不是状态机表的行，那一行也没有写事件码 `staff.disable`",
    );
    expect(problemsOf(moved("3:221"))).toContain(
      "staff.status：ref 的写法不对（应为“分组:行号”）：3:221",
    );
    // 三种写法都另有一条：文档那一行没人认领了
    for (const ref of ["03:999999", "03:1", "3:221"]) {
      expect(problemsOf(moved(ref))).toContain(
        "staff.status：文档有而迁移表没有：03:221（事件码 staff.disable）",
      );
    }
  });

  it("引用指到别的状态机、别的状态列的表", () => {
    const wrongColumn = patchRow("entity.lifecycle", "02:525", "entity.close", { ref: "02:541" });
    expect(problemsOf(wrongColumn).join("\n")).toMatch(
      /entity\.lifecycle：02:538 的表格前面写的是 machine = entity、state_field = verification_status，不是这条链/,
    );
    const wrongGroup = patchRow("staff.status", "03:221", "staff.disable", { ref: "02:126" });
    expect(problemsOf(wrongGroup)).toEqual([
      "staff.status：各行的 ref 应在同一份分组文档里，现在是 03、02",
    ]);
  });

  it("终态声明的行、写明不写状态历史的行，迁移表里不该有", () => {
    const fromTerminal = withRows("merchant_user.status", (rows) => [
      ...rows,
      {
        ref: "02:130",
        from: ["deleted"],
        event: "merchant_user.revive",
        to: ["active"],
        guard: true,
      },
    ]);
    expect(problemsOf(fromTerminal)).toEqual([
      "merchant_user.status：02:130 是终态声明（事件“任何”），迁移表里不该有它的行",
      "merchant_user.status：02:130 声明 deleted 是终态，迁移表里它还有改变状态的迁移",
    ]);
    const noHistory = withRows("service_ticket.status", (rows) => [
      ...rows,
      { ref: "12:152", from: ["processing"], event: "note", to: SAME, guard: false },
    ]);
    expect(problemsOf(noHistory)).toEqual([
      "service_ticket.status：12:152 写着“不写状态历史”，迁移表里不该有它的行",
    ]);
  });

  it("终态声明被别的行打破", () => {
    const leaving = withRows("invitation.status", (rows) => [
      ...rows.filter((row) => row.ref !== "02:789"),
      {
        ref: "02:789",
        from: ["pending", "accepted"],
        event: "invitation.expire",
        to: ["expired"],
        guard: true,
      },
    ]);
    expect(problemsOf(leaving)).toContain(
      "invitation.status：02:790 声明 accepted 是终态，迁移表里它还有改变状态的迁移",
    );
  });

  it("文档多出一行没人认领；文档一行丢了事件码；文档改了目标状态", () => {
    const group = sources.groups.get("02")!;
    const lines = [...group.lines];
    lines.splice(
      129,
      0,
      "| `disabled` | 注销（`merchant_user.delete_disabled`） | `deleted` | — | 系统 |",
    );
    const extraRow: DocSources = {
      ...sources,
      groups: new Map([...sources.groups, ["02", { ...group, lines }]]),
    };
    // 插入一行之后，后面的行号都往后挪了一位：原来指着第 130 行（终态声明）的没变，新行占了 130
    expect(problemsOf(chainAt("merchant_user.status"), extraRow)).toContain(
      "merchant_user.status：文档有而迁移表没有：02:130（事件码 merchant_user.delete_disabled）",
    );

    const noCode = withDocLine("02", 126, (text) =>
      text.replace("（`merchant_user.disable`）", ""),
    );
    expect(problemsOf(chainAt("merchant_user.status"), noCode)).toContain(
      "merchant_user.status：02:126 读不出来：这一行没有事件码，也没有写明“不写状态历史”",
    );

    const retargeted = withDocLine("02", 126, (text) =>
      text.replace("| `disabled` |", "| `deleted` |"),
    );
    expect(problemsOf(chainAt("merchant_user.status"), retargeted)).toEqual([
      "merchant_user.status：02:126 merchant_user.disable 的新状态：文档 deleted，迁移表 disabled",
    ]);
  });

  it("同一条链在文档里另起一张状态机表、没有行认领它", () => {
    const group = sources.groups.get("02")!;
    const lines = [...group.lines];
    // 接在邀请的状态机表后面（同一小节）：隔一个空行再来一张表
    lines.splice(
      790,
      0,
      "",
      "| 当前状态 | 事件 | 新状态 | 守卫 | 触发者 |",
      "| --- | --- | --- | --- | --- |",
      "| `expired` | 续期（`invitation.renew`） | `pending` | — | 系统 |",
    );
    const extraTable: DocSources = {
      ...sources,
      groups: new Map([...sources.groups, ["02", { ...group, lines }]]),
    };
    expect(
      declaredTables(extraTable).filter((table) => table.column === "invitation.status"),
    ).toEqual([
      { column: "invitation.status", at: "02:784" },
      { column: "invitation.status", at: "02:792" },
    ]);
    expect(checkMachines(CHAINS, extraTable).problems).toContain(
      "invitation.status：02:792 的状态机表没有被迁移表的任何一行认领",
    );
  });

  it("文档把状态写回散文：报出来，不当成“没有差异”", () => {
    const prose = withDocLine("11", 134, (text) =>
      text.replace("任意未解绑状态（`pending_verify`、`available`、`abnormal`）", "任意未解绑状态"),
    );
    expect(problemsOf(chainAt("channel_account.status"), prose)).toContain(
      "channel_account.status：11:134 的当前状态一格没有用反引号写出状态",
    );
  });

  it("人工纠偏：文档写出状态的照比；只写“白名单内”的以迁移表为准", () => {
    expect(
      problemsOf(patchRow("service_ticket.status", "12:162", "admin.force", { to: ["pending"] })),
    ).toEqual(["service_ticket.status：12:162 的新状态：文档 processing，迁移表 pending"]);
    const widened = withRows("delivery_ticket.step", (rows) => [
      ...rows,
      { ref: "10:194", from: ["archived"], event: "admin.force", to: ["takedown"], guard: true },
    ]);
    expect(problemsOf(widened)).toEqual([]);
  });

  it("清单：迁移表少一条链、多一条链；catalogue 少一张表；01 分组的表少一行", () => {
    const fewer = CHAINS.filter((item) => item.column !== "staff.status");
    expect(registryProblems(fewer, sources)).toEqual([
      "契约登记（STATE_MACHINES）有而迁移表没有：staff.status",
    ]);
    const extra = [
      ...CHAINS,
      { ...chainAt("staff.status"), stateField: "lifecycle", column: "staff.lifecycle" },
    ];
    expect(registryProblems(extra, sources)).toEqual([
      "迁移表有而契约登记（STATE_MACHINES）没有：staff.lifecycle",
      "staff.lifecycle：契约里没有绑定这一列的枚举",
    ]);
    const twice = [...CHAINS, chainAt("staff.status")];
    expect(registryProblems(twice, sources)).toEqual(["迁移表里 staff.status 声明了不止一次"]);
    expect(
      registryProblems(CHAINS, {
        ...sources,
        catalogueMachines: sources.catalogueMachines.filter((name) => name !== "drama"),
      }),
    ).toEqual(["契约登记的状态机有而catalogue.json 里 state_machine = true 的表没有：drama"]);
    const kernel = sources.groups.get("01")!;
    const withoutStaff: DocSources = {
      ...sources,
      groups: new Map([
        ...sources.groups,
        [
          "01",
          {
            ...kernel,
            lines: kernel.lines.filter((line) => !line.includes("`staff`、`approval_request`")),
          },
        ],
      ]),
    };
    expect(registryProblems(CHAINS, withoutStaff)).toEqual([
      "契约登记（STATE_MACHINES）有而01 分组 第 3.2 节的表没有：approval_request.status、staff.status",
    ]);
  });

  it("状态取值与契约枚举不同", () => {
    const original = chainAt("staff.status");
    const broken = CHAINS.map((item) =>
      item === original ? { ...item, states: [...item.states, "lyx_selftest_only"] } : item,
    );
    expect(registryProblems(broken, sources)).toEqual([
      "staff.status：状态取值与契约枚举 staff_status 不同",
    ]);
  });
});
