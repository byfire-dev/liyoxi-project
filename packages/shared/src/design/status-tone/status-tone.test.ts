import { describe, expect, it } from "vitest";

import { firstTable, specSection } from "../../../scripts/lib/spec.js";
import {
  STATUS_TONE_GROUPS,
  statusToneByEnum,
  statusToneByState,
  TONES,
  type StatusToneEntry,
  type Tone,
} from "./index.js";

const COLOR_TO_TONE: Record<string, Tone> = {
  橙: "warning",
  蓝: "info",
  绿: "success",
  红: "danger",
  灰: "neutral",
  紫: "purple",
};

interface SpecRow {
  object: string;
  state: string;
  /** null = 这一端不出现 */
  merchant: Tone | null;
  admin: Tone | null;
  /** 原型自相矛盾、规范做了裁决的（★） */
  ruled: boolean;
}

/** 一个单元格里的颜色：按“ / ”分位置；“—”、空、“见表下说明”都是这一端不出现 */
function tonesOf(cell: string, count: number): Array<{ tone: Tone | null; ruled: boolean }> {
  const parts = cell.split(" / ").map((part) => part.trim());
  return Array.from({ length: count }, (_, index) => {
    const part = (parts.length === 1 ? parts[0] : parts[index]) ?? "";
    const color = part.replace(/[★◇]/g, "").trim();
    if (color === "—" || color === "" || color === "见表下说明") return { tone: null, ruled: false };
    const tone = COLOR_TO_TONE[color];
    if (!tone) throw new Error(`规范 第 6.2 节里有不认识的颜色：${cell}`);
    return { tone, ruled: part.includes("★") };
  });
}

/** 规范 第 6.2 节的表逐行拆开：一行里用“ / ”并列的按位置对颜色，用“、”并列的同色 */
function specRows(): SpecRow[] {
  const rows: SpecRow[] = [];
  let object = "";
  for (const [objectCell = "", stateCell = "", merchantCell = "", adminCell = ""] of firstTable(
    specSection("### 6.2 状态取色表"),
  )) {
    if (objectCell !== "") object = objectCell;
    const groups = stateCell.split(" / ");
    const merchant = tonesOf(merchantCell, groups.length);
    const admin = tonesOf(adminCell, groups.length);
    groups.forEach((group, index) => {
      for (const state of group.replace(/（[^）]*）/g, "").split("、")) {
        rows.push({
          object,
          state: state.trim(),
          merchant: merchant[index]?.tone ?? null,
          admin: admin[index]?.tone ?? null,
          ruled: (merchant[index]?.ruled ?? false) || (admin[index]?.ruled ?? false),
        });
      }
    });
  }
  return rows;
}

const rows = specRows();
const entriesOf = (row: SpecRow): StatusToneEntry[] =>
  STATUS_TONE_GROUPS.find((group) => group.object === row.object)?.entries.filter(
    (entry) => entry.row === row.state,
  ) ?? [];
const all = STATUS_TONE_GROUPS.flatMap((group) => group.entries.map((entry) => ({ group, entry })));

describe("规范 第 6.2 节逐行对账", () => {
  it("表读得出来", () => {
    expect(rows.length).toBeGreaterThan(100);
    expect(new Set(rows.map((row) => row.object)).size).toBe(STATUS_TONE_GROUPS.length);
  });

  it.each(rows.map((row) => [`${row.object} · ${row.state}`, row] as const))(
    "%s",
    (_title, row) => {
      const entries = entriesOf(row);
      expect(entries.length, "字典里没有这一行").toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.merchant?.tone ?? null, "商家端").toBe(row.merchant);
        expect(entry.admin?.tone ?? null, "后台").toBe(row.admin);
      }
    },
  );

  it("字典里出自 6.2 的条目，在表里都找得到那一行", () => {
    for (const { group, entry } of all) {
      if (entry.row === null) continue;
      const hit = rows.some((row) => row.object === group.object && row.state === entry.row);
      expect(hit, `${group.object} · ${entry.state}`).toBe(true);
    }
  });
});

describe("9 处 ★（规范 第 13 节的裁决）", () => {
  const ruled = rows.filter((row) => row.ruled);

  it("表里标 ★ 的正好 9 处", () => {
    expect(ruled.map((row) => `${row.object}·${row.state}`)).toHaveLength(10);
    // “已采用、可直接使用”是一处裁决、两个状态名，所以拆开后是 10 行
    expect(new Set(ruled.map((row) => row.object)).size).toBe(9);
  });

  it.each([
    ["订购单", "待上线", "admin", "warning"],
    ["单部剧", "样片待确认", "admin", "info"],
    ["广告视频", "待商家确认", "admin", "info"],
    ["资质审核", "审核中", "merchant", "info"],
    ["渠道账号", "待核验", "admin", "warning"],
    ["上线链接", "核验中", "admin", "warning"],
    ["门店素材", "可直接使用", "merchant", "success"],
    ["套餐与积分包（上架管理）", "调整待生效", "admin", "info"],
    ["协议、公告、运营位", "草稿", "admin", "neutral"],
  ] as const)("%s · %s：%s 为 %s", (object, state, side, tone) => {
    expect(ruled.some((row) => row.object === object && row.state === state)).toBe(true);
    const group = STATUS_TONE_GROUPS.find((item) => item.object === object);
    const entry = group?.entries.find((item) => item.state === state);
    expect(entry?.[side]?.tone).toBe(tone);
  });

  it("“样片待确认”商家端为 warning、后台为 info", () => {
    const entry = statusToneByState("order-item", "样片待确认");
    expect(entry?.merchant).toEqual({ tone: "warning", label: "样片待确认" });
    expect(entry?.admin).toEqual({ tone: "info", label: "样片待确认" });
  });
});

describe("字典自身", () => {
  it("每个条目至少在一端出现，色调是六种之一；紫色只在后台", () => {
    for (const { group, entry } of all) {
      const title = `${group.object} · ${entry.state}`;
      expect(entry.merchant !== null || entry.admin !== null, title).toBe(true);
      for (const side of [entry.merchant, entry.admin]) {
        if (side) {
          expect(TONES, title).toContain(side.tone);
          expect(side.label, title).not.toBe("");
        }
      }
      expect(entry.merchant?.tone, title).not.toBe("purple");
    }
  });

  it("分组键、对象名不重复；同一对象内状态名不重复", () => {
    expect(new Set(STATUS_TONE_GROUPS.map((group) => group.key)).size).toBe(STATUS_TONE_GROUPS.length);
    expect(new Set(STATUS_TONE_GROUPS.map((group) => group.object)).size).toBe(
      STATUS_TONE_GROUPS.length,
    );
    for (const group of STATUS_TONE_GROUPS) {
      expect(group.key).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      const states = group.entries.map((entry) => entry.state);
      expect(new Set(states).size, group.object).toBe(states.length);
    }
  });

  it("有枚举对应的条目写了“表.列”与取值；同一对取值只出现一次", () => {
    const seen = new Set<string>();
    for (const { group, entry } of all) {
      if (entry.column === null) continue;
      expect(entry.column, group.object).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(entry.values.length, `${group.object} · ${entry.state}`).toBeGreaterThan(0);
      for (const value of entry.values) {
        expect(value).toMatch(/^[a-z_]+$/);
        const key = `${entry.column}=${value}`;
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    }
  });

  it("无枚举对应的条目标明了“无枚举对应”并写了推导来源；表外的条目写了依据", () => {
    for (const { group, entry } of all) {
      const title = `${group.object} · ${entry.state}`;
      if (entry.column === null) {
        expect(entry.values, title).toEqual([]);
        expect(entry.note, title).toMatch(/^无枚举对应：.+/);
      }
      if (entry.row === null) expect(entry.note, title).toMatch(/规范 第 13 节/);
    }
  });

  it("字典里不写色值", () => {
    const text = JSON.stringify(STATUS_TONE_GROUPS);
    expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl)a?\(/);
  });

  it("按枚举、按状态名都查得到", () => {
    expect(statusToneByEnum("drama_order.status", "to_launch")?.admin?.tone).toBe("warning");
    expect(statusToneByEnum("delivery_ticket.step", "sample_confirm")?.state).toBe("样片确认");
    expect(statusToneByEnum("drama_order.status", "no_such_value")).toBeUndefined();
    expect(statusToneByState("ad", "待商家确认")?.merchant?.label).toBe("待确认");
    expect(statusToneByState("qualification", "审核中")?.admin?.label).toBe("待审核");
    expect(statusToneByState("no-such-group", "审核中")).toBeUndefined();
  });
});
