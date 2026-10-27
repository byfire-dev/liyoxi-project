// 种子数据的自测，不连库（任务书 W0-21 第 7 节第 4 条）：数据合契约的结构、合库里的约束、彼此引用得上。
import {
  AGREEMENT_CONSENT_SCENE,
  BILLING_PARAM_KEY,
  CHECKLIST_TEMPLATE_CODE,
  ChecklistItemsSchema,
  dictExtSchema,
  FLAGS,
  HEAT_TIER,
  isFlagValueOfType,
  NOTIFY_SCENES,
  REJECT_REASON_SCENES,
  SITE_CONFIG_SCHEMAS,
} from "@liyoxi/contract";
import { describe, expect, it } from "vitest";

import {
  BILLING_PARAM_SEEDS,
  cyclePricesOf,
  INITIAL_CYCLES,
  PLAN_SEEDS,
  POINT_PACK_SEEDS,
  PRICE_TIER_SEEDS,
} from "./billing/index.js";
import {
  CHECKLIST_TEMPLATE_SEEDS,
  DICT_ITEM_SEEDS,
  DICT_TYPE_SEEDS,
  SITE_CONFIG_SEEDS,
  SYSTEM_DICT_ITEMS,
} from "./config/index.js";
import { AGREEMENT_SEEDS } from "./docs/index.js";
import {
  SCENE_BINDINGS,
  sceneBindingOf,
  SMS_TEMPLATE_SEEDS,
  WX_TEMPLATE_SLOT_SEEDS,
} from "./notify/index.js";
import { calendarDaysOf, HOLIDAY_ARRANGEMENTS, seededCalendarYears } from "./sla/index.js";

const repeated = (values: readonly string[]): string[] => [
  ...new Set(values.filter((value, index) => values.indexOf(value) !== index)),
];
const itemsOf = (typeKey: string) => DICT_ITEM_SEEDS.filter((item) => item.dictTypeKey === typeKey);

describe("字典类型与初始项", () => {
  it("22 类：键不重复、写法合约束；顺序发号的前缀各不相同；系统枚举不可新增、不可停用", () => {
    expect(DICT_TYPE_SEEDS).toHaveLength(22);
    expect(repeated(DICT_TYPE_SEEDS.map((type) => type.typeKey))).toEqual([]);
    const prefixes = DICT_TYPE_SEEDS.flatMap((type) => (type.code ? [type.code.prefix] : []));
    expect(repeated(prefixes)).toEqual([]);
    for (const type of DICT_TYPE_SEEDS) {
      expect(type.typeKey, type.typeKey).toMatch(/^[a-z][a-z0-9_]{1,23}$/);
      expect(type.maxDepth === 1, type.typeKey).toBe(type.structure === "flat");
      if (type.code) expect(type.code.prefix, type.typeKey).toMatch(/^[A-Z]{1,4}$/);
      if (type.isSystem) {
        expect(type.canCreate, type.typeKey).toBe(false);
        expect(type.disablePolicy, type.typeKey).toBe("never");
        expect(type.code, type.typeKey).toBeNull();
      }
    }
    expect(DICT_TYPE_SEEDS.filter((type) => type.isSystem).map((type) => type.typeKey)).toEqual([
      "plan_tier",
      "point_type",
    ]);
    expect(DICT_TYPE_SEEDS.find((type) => type.typeKey === "region")?.canCreate).toBe(false);
  });

  it("初始项：编码与名称合约束，同级不重名，上级排在前面，层级不超限，扩展属性过契约的结构", () => {
    const typeOf = new Map(DICT_TYPE_SEEDS.map((type) => [type.typeKey, type]));
    const seen = new Set<string>();
    for (const item of DICT_ITEM_SEEDS) {
      const label = `${item.dictTypeKey}/${item.code}`;
      const type = typeOf.get(item.dictTypeKey);
      expect(type, label).toBeDefined();
      expect(item.code, label).toMatch(/^[A-Za-z0-9_-]{1,16}$/);
      expect([...item.name].length, label).toBeGreaterThanOrEqual(1);
      expect([...item.name].length, label).toBeLessThanOrEqual(20);
      expect([...(item.description ?? "")].length, label).toBeLessThanOrEqual(40);
      expect(dictExtSchema(item.dictTypeKey).safeParse(item.ext).success, label).toBe(true);
      if (item.parentCode !== null) {
        expect(seen.has(`${item.dictTypeKey}/${item.parentCode}`), label).toBe(true);
        expect(type?.maxDepth, label).toBeGreaterThanOrEqual(2);
      }
      seen.add(label);
    }
    expect(repeated(DICT_ITEM_SEEDS.map((item) => `${item.dictTypeKey}/${item.code}`))).toEqual([]);
    expect(
      repeated(
        DICT_ITEM_SEEDS.map((item) => `${item.dictTypeKey}/${item.parentCode ?? ""}/${item.name}`),
      ),
    ).toEqual([]);
  });

  it("驳回原因：七个场景都有项，编码从 R01 连着排；重名的“其他”带上场景名", () => {
    const items = itemsOf("reject_reason");
    expect(items.map((item) => item.code)).toEqual(
      items.map((_, index) => `R${String(index + 1).padStart(2, "0")}`),
    );
    const byScene = (scene: string) => items.filter((item) => item.ext.scene === scene);
    expect(REJECT_REASON_SCENES.map((scene) => byScene(scene).length)).toEqual([
      5, 6, 7, 3, 4, 5, 4,
    ]);
    expect(byScene("store_review").at(-1)?.name).toBe("其他（资质审核）");
    expect(byScene("link_verify").map((item) => item.name)).toContain("声明了原创");
  });

  it("工单类型 K01–K10：取消与退款是售后类且优先级高，投诉建议通知主管；固定编码的两项在", () => {
    const tickets = itemsOf("ticket_type");
    expect(tickets.map((item) => item.code)).toEqual(
      Array.from({ length: 10 }, (_, index) => `K${String(index + 1).padStart(2, "0")}`),
    );
    expect(
      tickets.filter((item) => item.ext.isAfterSales === true).map((item) => item.name),
    ).toEqual(["取消与退款"]);
    expect(tickets.find((item) => item.code === "K08")?.ext.defaultPriority).toBe("high");
    expect(tickets.filter((item) => item.ext.notifyLead === true).map((item) => item.code)).toEqual(
      ["K09"],
    );
    expect(itemsOf("permit_type").map((item) => item.code)).toEqual(["food_business"]);
    expect(itemsOf("asset_tag").map((item) => [item.code, item.ext.dimension])).toEqual([
      ["brand_story", "content"],
    ]);
    expect(SYSTEM_DICT_ITEMS.filter((item) => item.dictTypeKey === "plan_tier")).toHaveLength(3);
    expect(itemsOf("plan_tier").map((item) => item.code)).toEqual(
      PLAN_SEEDS.map((plan) => plan.code),
    );
  });
});

describe("清单模板、站点配置、开关", () => {
  it("9 个编码各一套，条目过契约的结构且至少一条", () => {
    expect(CHECKLIST_TEMPLATE_SEEDS.map((seed) => seed.code)).toEqual([
      ...CHECKLIST_TEMPLATE_CODE.values,
    ]);
    for (const seed of CHECKLIST_TEMPLATE_SEEDS) {
      expect(ChecklistItemsSchema.safeParse(seed.items).success, seed.code).toBe(true);
      expect(seed.items.length, seed.code).toBeGreaterThan(0);
    }
    const count = (code: string) =>
      CHECKLIST_TEMPLATE_SEEDS.find((seed) => seed.code === code)?.items.length;
    expect([count("qc.sample"), count("qc.episode"), count("launch.verify")]).toEqual([6, 5, 5]);
    // 向商家展示的样片质检结果是 4 项
    expect(
      CHECKLIST_TEMPLATE_SEEDS[0]?.items.filter((entry) => entry.merchantVisible),
    ).toHaveLength(4);
  });

  it("两份站点配置的初始版过契约的结构", () => {
    expect(SITE_CONFIG_SEEDS.map((seed) => seed.configKey)).toEqual(["mall", "home_recommend"]);
    for (const seed of SITE_CONFIG_SEEDS) {
      const parsed = SITE_CONFIG_SCHEMAS[seed.configKey].safeParse(seed.content);
      expect(parsed.success, seed.configKey).toBe(true);
    }
  });

  it("开关登记的默认值合自己的值类型", () => {
    for (const flag of FLAGS) {
      expect(isFlagValueOfType(flag.valueType, flag.defaultValue), flag.key).toBe(true);
    }
  });
});

describe("通知：槽位、短信模板、场景的通道绑定", () => {
  it("12 个槽位标题不重复，9 个短信模板只有验证码一个是验证码类", () => {
    expect(WX_TEMPLATE_SLOT_SEEDS).toHaveLength(12);
    expect(repeated(WX_TEMPLATE_SLOT_SEEDS.map((slot) => slot.title))).toEqual([]);
    expect(SMS_TEMPLATE_SEEDS).toHaveLength(9);
    expect(
      SMS_TEMPLATE_SEEDS.filter((item) => item.kind === "verify").map((item) => item.templateKey),
    ).toEqual(["verify_code"]);
  });

  it("绑定只写给登记过的商家场景与对公摘要；槽位与模板都在播种清单里；要发短信的都有模板", () => {
    const sceneKeys: readonly string[] = NOTIFY_SCENES.map((scene) => scene.key);
    const slots: readonly string[] = WX_TEMPLATE_SLOT_SEEDS.map((slot) => slot.slotKey);
    const templates = SMS_TEMPLATE_SEEDS.map((item) => item.templateKey);
    expect(Object.keys(SCENE_BINDINGS).filter((key) => !key.startsWith("m."))).toEqual([
      "s.receipt_daily_digest",
    ]);
    for (const [key, binding] of Object.entries(SCENE_BINDINGS)) {
      expect(sceneKeys, key).toContain(key);
      if (key === "s.receipt_daily_digest") {
        expect(NOTIFY_SCENES.find((scene) => scene.key === key)?.audience).toBe("staff");
        expect(binding).toEqual({
          wxTemplateSlotKey: null,
          sendWindow: "immediate",
          smsPolicy: "never",
          smsTemplateKey: null,
          smsNodes: null,
          collapseWindowSec: 0,
        });
      } else expect(key.startsWith("m."), key).toBe(true);
      if (binding.wxTemplateSlotKey !== null) {
        expect(slots, key).toContain(binding.wxTemplateSlotKey);
        // 带订阅槽位的商家场景一律有短信模板
        expect(binding.smsTemplateKey, key).not.toBeNull();
      }
      if (binding.smsTemplateKey !== null) expect(templates, key).toContain(binding.smsTemplateKey);
      if (binding.smsPolicy !== "never") expect(binding.smsTemplateKey, key).not.toBeNull();
    }
    // 12 个槽位都有场景在用；带槽位的是原型的 17 个订阅场景
    const used = Object.values(SCENE_BINDINGS).map((binding) => binding.wxTemplateSlotKey);
    expect(slots.filter((slot) => !used.includes(slot as never))).toEqual([]);
    expect(used.filter((slot) => slot !== null)).toHaveLength(17);
  });

  it("照文档抽几格：样片与广告只在催办节点补短信，到期与下架只在前一天，员工场景只发站内", () => {
    expect(sceneBindingOf("m.sample_pending")).toMatchObject({
      wxTemplateSlotKey: "service_progress",
      sendWindow: "window",
      smsPolicy: "fallback",
      smsTemplateKey: "sample_pending",
      smsNodes: ["R1", "M"],
    });
    expect(sceneBindingOf("m.plan_expiring")).toMatchObject({
      sendWindow: "scheduled",
      smsNodes: ["T-1"],
    });
    expect(sceneBindingOf("m.pay_success")).toMatchObject({
      smsPolicy: "never",
      smsTemplateKey: "generic_todo",
    });
    expect(sceneBindingOf("m.points_changed").collapseWindowSec).toBe(600);
    expect(sceneBindingOf("m.account_security")).toMatchObject({
      wxTemplateSlotKey: null,
      smsPolicy: "always",
      smsTemplateKey: "account_notice",
    });
    for (const scene of NOTIFY_SCENES.filter((item) => item.audience === "staff")) {
      expect(sceneBindingOf(scene.key), scene.key).toMatchObject({
        wxTemplateSlotKey: null,
        smsPolicy: "never",
        smsTemplateKey: null,
      });
    }
  });
});

describe("协议清单与价目", () => {
  it("6 份协议：键不重复，签署场景都在契约的枚举里", () => {
    expect(AGREEMENT_SEEDS.map((item) => item.key)).toEqual([
      "user",
      "privacy",
      "member",
      "points",
      "custom_license",
      "ad_service",
    ]);
    const scenes: readonly string[] = AGREEMENT_CONSENT_SCENE.values;
    for (const item of AGREEMENT_SEEDS) {
      expect(item.scenes.length, item.key).toBeGreaterThan(0);
      for (const scene of item.scenes) expect(scenes, item.key).toContain(scene);
    }
  });

  it("三个套餐：版本越高月费与积分越高，各启用的周期都有总价", () => {
    expect(PLAN_SEEDS.map((plan) => plan.code)).toEqual(["basic", "pro", "flagship"]);
    for (const [index, plan] of PLAN_SEEDS.entries()) {
      const lower = PLAN_SEEDS[index - 1];
      if (lower) {
        expect(plan.rank).toBeGreaterThan(lower.rank);
        expect(plan.monthlyFeeFen).toBeGreaterThan(lower.monthlyFeeFen);
        expect(plan.monthlyPoints).toBeGreaterThan(lower.monthlyPoints);
      }
      expect(plan.discountBp).toBeGreaterThanOrEqual(5000);
      expect(plan.discountBp).toBeLessThanOrEqual(10_000);
      expect(Object.keys(cyclePricesOf(plan))).toEqual(INITIAL_CYCLES.map(String));
    }
    expect(cyclePricesOf(PLAN_SEEDS[1] as never)).toEqual({
      "1": 600_000,
      "3": 1_800_000,
      "12": 7_200_000,
    });
  });

  it("模板价 S ≥ A ≥ B ≥ C；积分包不重复；12 个计费参数的值形态合库里的约束", () => {
    const tiers = HEAT_TIER.values.map((tier) => PRICE_TIER_SEEDS[tier]);
    expect(tiers).toEqual([...tiers].sort((a, b) => b - a));
    for (const points of tiers) {
      expect(points).toBeGreaterThanOrEqual(100);
      expect(points).toBeLessThanOrEqual(20_000);
    }
    expect(repeated(POINT_PACK_SEEDS.map((pack) => String(pack.points)))).toEqual([]);
    expect(POINT_PACK_SEEDS.every((pack) => pack.points >= 100 && pack.priceFen > 0)).toBe(true);
    expect(Object.keys(BILLING_PARAM_SEEDS)).toEqual([...BILLING_PARAM_KEY.values]);
    const shapeOf = (value: unknown): string =>
      Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value;
    for (const key of BILLING_PARAM_KEY.values) {
      const expected =
        key === "renewalReminderDays" || key === "enabledCycles"
          ? "array"
          : key === "cancelDeductionBp" || key === "expiredTermRefund"
            ? "object"
            : "number";
      expect(shapeOf(BILLING_PARAM_SEEDS[key]), key).toBe(expected);
    }
    expect(BILLING_PARAM_SEEDS.enabledCycles).toEqual(INITIAL_CYCLES);
  });
});

describe("工作日历", () => {
  const year2026 = calendarDaysOf(2026);
  const kindOf = (day: string) => year2026.find((item) => item.day === day)?.kind;

  it("播有放假安排的年份与下一年；每年铺满，每一天合“类型与星期”的约束", () => {
    expect(seededCalendarYears()).toEqual([2026, 2027]);
    expect(HOLIDAY_ARRANGEMENTS.map((item) => item.year)).toEqual([2026]);
    for (const year of seededCalendarYears()) {
      const days = calendarDaysOf(year);
      expect(days).toHaveLength(365);
      expect(days[0]?.day).toBe(`${year}-01-01`);
      expect(days.at(-1)?.day).toBe(`${year}-12-31`);
      for (const item of days) {
        const dow = new Date(`${item.day}T00:00:00.000Z`).getUTCDay();
        const weekend = dow === 0 || dow === 6;
        if (item.kind === "weekday") expect(weekend, item.day).toBe(false);
        if (item.kind === "weekend" || item.kind === "adjusted_workday") {
          expect(weekend, item.day).toBe(true);
        }
        expect(item.note === null, item.day).toBe(
          item.kind === "weekday" || item.kind === "weekend",
        );
      }
    }
  });

  it("2026 年：国庆 10-01 至 10-07 放假，09-30、10-08 工作，09-20、10-10 调休上班", () => {
    expect(kindOf("2026-09-30")).toBe("weekday");
    for (let day = 1; day <= 7; day += 1) expect(kindOf(`2026-10-0${day}`)).toBe("holiday");
    expect(kindOf("2026-10-08")).toBe("weekday");
    expect([kindOf("2026-09-20"), kindOf("2026-10-10")]).toEqual([
      "adjusted_workday",
      "adjusted_workday",
    ]);
    // 春节 9 天；清明落在周末的两天也记放假
    expect(year2026.filter((item) => item.note === "春节")).toHaveLength(9);
    expect([kindOf("2026-04-04"), kindOf("2026-04-05"), kindOf("2026-04-06")]).toEqual([
      "holiday",
      "holiday",
      "holiday",
    ]);
    expect(year2026.filter((item) => item.kind === "holiday")).toHaveLength(33);
    expect(year2026.filter((item) => item.kind === "adjusted_workday")).toHaveLength(6);
  });

  it("没有放假安排的年份只有平日与周末", () => {
    const kinds = new Set(calendarDaysOf(2027).map((item) => item.kind));
    expect([...kinds].sort()).toEqual(["weekday", "weekend"]);
  });
});
