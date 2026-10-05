// 参数定义的自测（任务书 W0-18 第 7 节第 1、2 条）：登记的键都有定义、默认值合定义、
// 文档写了默认值的键与文档相同；校验函数逐类型有正例与反例。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PARAM_KEYS, PARAM_KEYS_BY_GROUP } from "@liyoxi/contract/config/params";
import type { ParamKey } from "@liyoxi/contract/config/params";
import { PLACEMENT_SLOT } from "@liyoxi/contract/enums";
import { describe, expect, it } from "vitest";

import {
  checkParamDefs,
  checkParamPairs,
  int,
  PARAM_DEFS,
  PARAM_GROUP_TITLES,
  PARAM_PAIR_RULES,
  paramDef,
  PLACEMENT_SLOTS,
  SLA_UNITS,
  validateParamValue,
} from "./index.js";
import type { DefinedParamKey, ParamDef, ParamValue } from "./index.js";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");
const quoted = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

/** 文档里某个标记之后的第一张表，去掉表头两行，拆成单元格 */
function tableAfter(text: string, marker: string): string[][] {
  const lines = text.split("\n");
  const from = lines.findIndex((line) => line.includes(marker));
  const start = lines.findIndex((line, index) => index > from && line.startsWith("|"));
  const rows: string[][] = [];
  for (let index = start; index < lines.length && lines[index]!.startsWith("|"); index += 1) {
    rows.push(
      lines[index]!.trim()
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  }
  return rows.slice(2);
}

const registered = PARAM_KEYS.map((item) => item.key as string);
const defined = PARAM_DEFS.map((def) => def.key as string);
/** 07 第 7 节待回写的参数键：W0-09b 登记进契约 */
const pendingRows = tableAfter(read("docs/07-api-contract.md"), "## 7. 待回写清单").filter(
  (cells) => cells[0] === "参数",
);
const pending = pendingRows.flatMap((cells) => quoted(cells[1]!));
const def = (key: string): ParamDef => {
  const found = paramDef(key);
  if (!found) throw new Error(`没有定义：${key}`);
  return found;
};

describe("定义表自检", () => {
  it("登记的键都有定义，定义不重复，默认值都合自己的定义", () => {
    expect(checkParamDefs()).toEqual([]);
    expect(new Set(defined).size).toBe(defined.length);
  });

  it("定义的键 ⊇ 登记的键；多出来的只能是 07 第 7 节待回写的键", () => {
    expect(pending).toHaveLength(7);
    expect(registered.filter((key) => !defined.includes(key))).toEqual([]);
    const extra = defined.filter((key) => !registered.includes(key));
    expect(extra.filter((key) => !pending.includes(key))).toEqual([]);
    // 待回写的 7 个键都有定义：登记合进来之后不缺
    expect(pending.filter((key) => !defined.includes(key))).toEqual([]);
  });

  it("少一条定义：报“参数缺定义”并指出是哪个键（验收 1）", () => {
    expect(checkParamDefs([...registered, "sla.no_such_key"])).toEqual([
      { key: "sla.no_such_key", problem: "参数缺定义" },
    ]);
    const withoutOne = (PARAM_DEFS as readonly ParamDef[]).filter((d) => d.key !== "work.start");
    expect(checkParamDefs(registered, withoutOne)).toEqual([
      { key: "work.start", problem: "参数缺定义" },
    ]);
  });

  it("类型上也拦：登记的键少了定义，类型检查不过", () => {
    type Missing<Registered extends string> = Exclude<Registered, DefinedParamKey>;
    const complete: [Missing<ParamKey>] extends [never] ? true : false = true;
    const incomplete: [Missing<ParamKey | "sla.no_such_key">] extends [never] ? true : false =
      false;
    expect([complete, incomplete]).toEqual([true, false]);
  });

  it("定义重复、默认值不合定义：各报一条", () => {
    const bad = int("x.bad_default", "坏默认值", { default: 99, min: 1, max: 5 });
    const twice = int("x.twice", "重复", { default: 1, min: 1, max: 5 });
    expect(checkParamDefs([], [bad, twice, twice])).toEqual([
      { key: "x.bad_default", problem: "默认值不合定义：要在 1–5 之间" },
      { key: "x.twice", problem: "定义重复" },
    ]);
  });

  it("每条定义：显示名不空；整数有范围；枚举的默认值在取值之内", () => {
    for (const item of PARAM_DEFS as readonly ParamDef[]) {
      expect(item.label, item.key).not.toBe("");
      if (item.type === "int" || item.type === "int_list") {
        expect(item.min, item.key).toBeLessThanOrEqual(item.max!);
      }
      if (item.type === "enum") expect(item.options, item.key).toContain(item.default);
      if (item.type === "json") expect(typeof item.check, item.key).toBe("function");
    }
  });

  it("分组都有显示名；广告位的取值与契约的枚举相同", () => {
    for (const group of Object.keys(PARAM_KEYS_BY_GROUP)) {
      expect(PARAM_GROUP_TITLES[group], group).toBeTruthy();
    }
    expect([...PLACEMENT_SLOTS]).toEqual([...PLACEMENT_SLOT.values]);
  });
});

describe("默认值与文档相同", () => {
  const rows = tableAfter(read("docs/data-model/14-config-data.md"), "**参数键的归属**");
  const cells = rows.map((row) => row[1]!).join("\n");

  it("14 分组 第 2.3 节写成“键（默认 N）”“键（N）”的整数", () => {
    const found = [...cells.matchAll(/`([a-z0-9_.]+)`（(?:默认 )?(\d+)[，）]/g)];
    expect(found.length).toBeGreaterThanOrEqual(8);
    for (const [, key, value] of found) {
      expect(def(key!).default, key).toBe(Number(value));
    }
  });

  it("14 分组 第 2.3 节写成“键（N `单位`）”的时限策略", () => {
    const found = [...cells.matchAll(/`(sla\.[a-z0-9_.]+)`（(\d+) `([a-z_]+)`/g)];
    expect(found.length).toBeGreaterThanOrEqual(12);
    for (const [, key, amount, unit] of found) {
      expect(def(key!).default, key).toEqual({ amount: Number(amount), unit });
    }
  });

  it("14 分组 第 2.3 节的其余几处：工作时段、布尔、带文字说明的默认值", () => {
    expect(cells).toContain("`work.start`（09:00）、`work.end`（18:00）");
    expect([def("work.start").default, def("work.end").default]).toEqual(["09:00", "18:00"]);
    expect(cells).toContain("`refund.require_distinct_executor`（boolean，默认 false");
    expect(def("refund.require_distinct_executor").default).toBe(false);
    expect(cells).toContain("`sla.review.invoice_request`（无默认值，未配置即不计时）");
    expect(def("sla.review.invoice_request").default).toBeNull();
    expect(cells).toContain("`package.link_ttl_days`（成片下载授权的有效天数，1–30，默认 7");
    expect(def("package.link_ttl_days")).toMatchObject({ default: 7, min: 1, max: 30 });
    expect(cells).toContain("`service.reopen_window_days`（已解决后可重新打开的天数，默认 7");
    expect(def("service.reopen_window_days").default).toBe(7);
    // 审核类“各 1 work_days”
    for (const key of [
      "sla.review.channel_account",
      "sla.review.launch_link",
      "sla.review.store_asset",
      "sla.review.refund_approve",
      "sla.review.refund_execute",
      "sla.review.transfer_proof",
    ]) {
      expect(def(key).default, key).toEqual({ amount: 1, unit: "work_days" });
    }
  });

  it("07 第 7 节写了默认值的三个键", () => {
    const note = (key: string): string => pendingRows.find((row) => row[1]!.includes(key))![2]!;
    expect(def("ad.duration_options").default).toEqual(
      // 文档里是 { opening: [3, 5], ending: [5, 10] }：键没加引号，补上再解析
      JSON.parse(quoted(note("ad.duration_options"))[0]!.replace(/(\w+):/g, '"$1":')),
    );
    expect(note("ad.revision_screenshot_max")).toMatch(/^1（/);
    expect(def("ad.revision_screenshot_max").default).toBe(1);
    expect(note("catalog.search.industry_fallback")).toMatch(/^开（/);
    expect(def("catalog.search.industry_fallback").default).toBe(true);
    expect(def("notify.test_recipients").sensitivePaths).toEqual(["phone", "wxOpenid"]);
  });
});

describe("validateParamValue：逐类型", () => {
  const bp: ParamDef = { ...int("x.bp", "比例", { default: 0, min: 0, max: 10_000 }), type: "bp" };
  const text: ParamDef = {
    key: "x.text",
    type: "text",
    label: "文字",
    unit: null,
    default: "甲",
    snapshotOn: "read",
    maxLength: 4,
  };

  it.each<[string, ParamDef, unknown[], unknown[]]>([
    ["int", def("remind.copyright.days"), [30, 90, 180], [29, 181, 90.5, "90", [90], true]],
    ["bp", bp, [0, 10_000], [-1, 10_001, 0.5]],
    [
      "int_list",
      def("remind.offline.days"),
      [[30, 7, 1, 0], [0], [90, 60, 30, 7, 1, 0]],
      [[], [7, 30], [7, 7], [91], [-1], [30, 7, 5, 3, 2, 1, 0], [1.5], "30,7", 30],
    ],
    ["time_hm", def("work.start"), ["00:00", "09:00", "23:59"], ["24:00", "9:00", "09:60", 900]],
    ["bool", def("qc.episode.four_eyes"), [true, false], [0, "true"]],
    ["enum", def("inbox.scope"), ["current_store", "all_stores"], ["all", 1]],
    ["text", text, ["甲", "甲乙丙丁"], ["", "  ", "甲乙丙丁戊", 1]],
    [
      "sla_policy",
      def("sla.ticket.assign"),
      [
        { amount: 120, unit: "work_minutes" },
        { amount: 1, unit: "natural_days" },
        { amount: 1080, unit: "same_day_cutoff" },
        { amount: 1440, unit: "same_day_cutoff" },
      ],
      [
        { amount: 0, unit: "work_days" },
        { amount: 1.5, unit: "work_days" },
        { amount: 1, unit: "weeks" },
        { amount: 1441, unit: "same_day_cutoff" },
        { amount: 1, unit: "work_days", extra: true },
        { amount: 1 },
        [1, "work_days"],
        "1 work_days",
      ],
    ],
    [
      "sla_policy（限定单位与范围）",
      def("sla.review.qualification"),
      [
        { amount: 1, unit: "work_days" },
        { amount: 5, unit: "work_days" },
      ],
      [
        { amount: 6, unit: "work_days" },
        { amount: 60, unit: "work_minutes" },
      ],
    ],
    [
      "json：下架核查口径",
      def("takedown.check_mode"),
      [
        { mode: "evidence" },
        { mode: "sampled", sampleBp: 1 },
        { mode: "sampled", sampleBp: 10000 },
      ],
      [
        { mode: "sampled" },
        { mode: "sampled", sampleBp: 0 },
        { mode: "sampled", sampleBp: 10001 },
        { mode: "evidence", sampleBp: 1 },
        { mode: "all" },
        "evidence",
      ],
    ],
    [
      "json：广告时长选项",
      def("ad.duration_options"),
      [{ opening: [3, 5], ending: [5, 10] }, { opening: [5] }],
      [{}, { banner: [3] }, { opening: [] }, { opening: [0] }, { opening: [3, 3] }, { opening: 3 }],
    ],
    [
      "json：开放的植入形式",
      def("content.placement.open_slots"),
      [["opening"], ["opening", "ending", "corner", "mid_roll"]],
      [[], ["banner"], ["opening", "opening"], "opening"],
    ],
    [
      "json：测试接收人",
      def("notify.test_recipients"),
      [
        [],
        [{ staffId: "019a0000-0000-7000-8000-000000000001", phone: "13800000000" }],
        [{ staffId: "019a0000-0000-7000-8000-000000000001", wxOpenid: "oAbC-123_x" }],
      ],
      [
        [{ staffId: "不是 uuid" }],
        [{ staffId: "019a0000-0000-7000-8000-000000000001", phone: "1380000" }],
        [{ staffId: "019a0000-0000-7000-8000-000000000001", note: "多了键" }],
        [
          { staffId: "019a0000-0000-7000-8000-000000000001" },
          { staffId: "019a0000-0000-7000-8000-000000000001" },
        ],
        {},
      ],
    ],
    [
      "json：发票号码规则",
      def("invoice.no_rules"),
      [{ electronic: ["^[0-9]{20}$"], paper: ["^[0-9]{8}$"] }],
      [
        { electronic: [], paper: ["^[0-9]{8}$"] },
        { electronic: ["[0-9]{20}"], paper: ["^[0-9]{8}$"] },
        { electronic: ["^([0-9]{20}$"], paper: ["^[0-9]{8}$"] },
        { electronic: ["^[0-9]{20}$"] },
      ],
    ],
    [
      "json：授权方主体",
      def("platform.legal_entity"),
      [null, { name: "某某文化传媒有限公司", creditCode: "91510100MA6CXXXX0X" }],
      [{ name: "", creditCode: "91510100MA6CXXXX0X" }, { name: "某某", creditCode: "123" }, {}],
    ],
  ])("%s", (_, definition, good, bad) => {
    for (const value of good) {
      expect(validateParamValue(definition, value), JSON.stringify(value)).toBeNull();
    }
    for (const value of bad) {
      expect(validateParamValue(definition, value), JSON.stringify(value)).toEqual(
        expect.any(String),
      );
    }
  });

  it("null：只有默认值是 null 的键接受", () => {
    expect(validateParamValue(def("invoice.apply_within_days"), null)).toBeNull();
    expect(validateParamValue(def("payment.wechat.advise_transfer_above_fen"), null)).toBeNull();
    expect(validateParamValue(def("sla.review.invoice_request"), null)).toBeNull();
    expect(validateParamValue(def("work.start"), null)).toBe("不能为空");
  });

  it("时限策略的单位只有五种", () => {
    expect(SLA_UNITS).toHaveLength(5);
    for (const item of (PARAM_DEFS as readonly ParamDef[]).filter((d) => d.type === "sla_policy")) {
      for (const unit of item.units ?? []) expect(SLA_UNITS, item.key).toContain(unit);
    }
  });
});

describe("成对的规则与值的类型", () => {
  it("起要早于止；没给全的不查；规则里的键都有定义", () => {
    expect(checkParamPairs({ "work.start": "09:00", "work.end": "18:00" })).toEqual([]);
    expect(checkParamPairs({ "work.start": "18:00", "work.end": "18:00" })).toEqual([
      "上班时刻要早于下班时刻",
    ]);
    expect(
      checkParamPairs({ "notify.window.start": "22:00", "notify.window.end": "21:00" }),
    ).toEqual(["发送时段的开始要早于结束"]);
    expect(checkParamPairs({ "work.start": "19:00" })).toEqual([]);
    for (const rule of PARAM_PAIR_RULES) {
      expect(def(rule.start).type).toBe("time_hm");
      expect(def(rule.end).type).toBe("time_hm");
    }
    // 默认值自己满足成对的规则
    const defaults = Object.fromEntries(
      (PARAM_DEFS as readonly ParamDef[]).map((d) => [d.key, d.default]),
    );
    expect(checkParamPairs(defaults)).toEqual([]);
  });

  it("ParamValue<键>：值的类型跟着定义走，默认值为 null 的键可空（编译期）", () => {
    const start: ParamValue<"work.start"> = "09:00";
    const days: ParamValue<"remind.offline.days"> = [30, 7];
    const scope: ParamValue<"inbox.scope"> = "all_stores";
    const within: ParamValue<"invoice.apply_within_days"> = null;
    const policy: ParamValue<"sla.review.invoice_request"> = null;
    // @ts-expect-error 有默认值的键读不到 null
    const never: ParamValue<"work.end"> = null;
    // @ts-expect-error 枚举之外的取值
    const wrong: ParamValue<"inbox.scope"> = "everything";
    expect([start, days, scope, within, policy, never, wrong]).toHaveLength(7);
  });
});
