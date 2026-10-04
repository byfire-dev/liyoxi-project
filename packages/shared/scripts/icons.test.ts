import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ICON_NAMES, ICON_VIEW_BOX, ICONS } from "../src/design/generated/icons.js";
import { paths } from "./generate.js";
import {
  ICON_STROKE_WIDTHS,
  iconDataUri,
  parseIconSource,
  readIconSources,
  renderIconsMaskScss,
} from "./lib/icons.js";
import { repoRoot } from "./lib/spec.js";

const icons = readIconSources(paths.icons);
const allowedWidths: readonly number[] = ICON_STROKE_WIDTHS;

const svg = (body: string, width = "1.8"): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`;

describe("图标源", () => {
  it("每个图标：画布 0 0 24 24、不填充、圆头圆角、颜色跟随文字色、线宽三选一", () => {
    expect(icons.length).toBeGreaterThan(0);
    for (const file of readdirSync(paths.icons)) {
      const text = readFileSync(join(paths.icons, file), "utf8");
      expect(text, file).toContain(`viewBox="${ICON_VIEW_BOX}"`);
      expect(text, file).toContain('fill="none"');
      expect(text, file).toContain('stroke="currentColor"');
      expect(text, file).toContain('stroke-linecap="round" stroke-linejoin="round"');
      // 只有外层这一处 fill 与 stroke：图形里不另填充、不另着色
      expect(text.match(/fill=/g), file).toHaveLength(1);
      expect(text.match(/stroke=/g), file).toHaveLength(1);
    }
    for (const icon of icons) expect(allowedWidths, icon.name).toContain(icon.strokeWidth);
  });

  it("名字唯一、小写短横线；目录里只有 .svg", () => {
    const names = icons.map((icon) => icon.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    expect(readdirSync(paths.icons).every((file) => file.endsWith(".svg"))).toBe(true);
  });

  it("图形相同的不重复收录", () => {
    expect(new Set(icons.map((icon) => icon.body)).size).toBe(icons.length);
  });

  it("写法不合规的图标源读不进来", () => {
    const body = '<path d="M5 12h14"/>';
    expect(parseIconSource("ok-icon", svg(body)).body).toBe(body);
    expect(() => parseIconSource("BadName", svg(body))).toThrow("小写短横线");
    expect(() => parseIconSource("wide", svg(body, "3"))).toThrow("线宽");
    expect(() => parseIconSource("filled", svg('<path d="M5 12h14" fill="red"/>'))).toThrow("图形");
    expect(() => parseIconSource("canvas", svg(body).replace("0 0 24 24", "0 0 64 64"))).toThrow(
      "固定写法",
    );
  });
});

describe("图标数据与 mask 变量", () => {
  it("生成的图标数据与图标源一一对应，按名字排序", () => {
    expect([...ICON_NAMES]).toEqual(icons.map((icon) => icon.name));
    expect([...ICON_NAMES]).toEqual([...ICON_NAMES].sort());
    for (const icon of icons) {
      expect(ICONS[icon.name as keyof typeof ICONS]).toEqual({
        strokeWidth: icon.strokeWidth,
        body: icon.body,
      });
    }
  });

  it("mask 变量每个图标一条，data URI 解出来就是这个图标", () => {
    const scss = renderIconsMaskScss(icons);
    for (const icon of icons) {
      const uri = iconDataUri(icon);
      expect(scss).toContain(`"${icon.name}": "${uri}",`);
      const decoded = decodeURIComponent(uri.slice("data:image/svg+xml,".length));
      expect(decoded).toContain(`viewBox='${ICON_VIEW_BOX}'`);
      expect(decoded).toContain(`stroke-width='${icon.strokeWidth}'`);
      expect(decoded).toContain(icon.body.replaceAll('"', "'"));
      expect(uri).not.toMatch(/[<>#"]/);
    }
  });
});

// ---- 与原型对账：图标集 = 原型源码里 24 画布、不填充的线性图形，一个不多、一个不少
// （登记在 NOT_IN_PROTOTYPE 里的除外：那是原型之外新增的）

/**
 * 原型之外新增的图标：名字登记在这里，不参加与原型的对账。现在为空。
 * 新增图标的画法照 scripts/README.md“怎么改”一节；线宽按规范 第 9.1 节（18px 及以上 1.8、16px 及以下 2）。
 */
const NOT_IN_PROTOTYPE: readonly string[] = [];

interface ProtoShape {
  body: string;
  /** 线宽 → 出现次数 */
  widths: Map<number, number>;
  /** 每一处都是不填充的线性图形 */
  linear: boolean;
  sides: Set<string>;
}

function prototypeShapes(): Map<string, ProtoShape> {
  const shapes = new Map<string, ProtoShape>();
  for (const side of ["merchant", "admin"]) {
    const dir = join(repoRoot, "design/prototype", side, "src");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".dc.html"))) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const match of text.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/g)) {
        const attrs = match[1] ?? "";
        if (!attrs.includes(`viewBox="${ICON_VIEW_BOX}"`)) continue;
        const body = (match[2] ?? "")
          .trim()
          .replace(/\s+/g, " ")
          .replace(/><\/(?:path|circle|rect)>/g, "/>");
        const fill = /\bfill="([^"]*)"/.exec(attrs)?.[1];
        // 收藏的心形在模板里写 fill="{{…}}"，未收藏时是线性的；其余须写 fill="none"
        const linear =
          (fill === "none" || fill?.startsWith("{{") === true) &&
          /\bstroke="/.test(attrs) &&
          !/\b(?:fill|stroke)=/.test(body);
        const shape = shapes.get(body) ?? {
          body,
          widths: new Map(),
          linear: true,
          sides: new Set(),
        };
        const width = Number(/stroke-width="([^"]*)"/.exec(attrs)?.[1]);
        if (!Number.isNaN(width)) shape.widths.set(width, (shape.widths.get(width) ?? 0) + 1);
        shape.linear &&= linear;
        shape.sides.add(side);
        shapes.set(body, shape);
      }
    }
  }
  return shapes;
}

/** 线宽照原型：取这个图形在原型里用得最多的那一档；原型只用了三档之外的线宽时取最近的一档 */
function prototypeWidth(shape: ProtoShape): number {
  const byCount = [...shape.widths].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const allowed = byCount.find(([width]) => allowedWidths.includes(width));
  if (allowed) return allowed[0];
  const top = byCount[0]?.[0] ?? Number.NaN;
  const tenths = (value: number): number => Math.trunc(value * 10 + 0.5);
  const distance = (value: number): number => Math.abs(tenths(value) - tenths(top));
  return [...allowedWidths].sort((a, b) => distance(a) - distance(b) || a - b)[0] ?? Number.NaN;
}

describe("与原型对账", () => {
  const shapes = prototypeShapes();
  const linear = [...shapes.values()].filter((shape) => shape.linear);
  const fromPrototype = icons.filter((icon) => !NOT_IN_PROTOTYPE.includes(icon.name));

  it("原型里每个不填充的线性图形都收了，图标集里没有登记之外的图形", () => {
    expect(linear.length).toBeGreaterThan(0);
    expect(fromPrototype.map((icon) => icon.body).sort()).toEqual(
      linear.map((shape) => shape.body).sort(),
    );
  });

  it("登记为“原型之外新增”的图标：图标集里有它，原型里确实没有它的图形，名字不重复登记", () => {
    expect(new Set(NOT_IN_PROTOTYPE).size).toBe(NOT_IN_PROTOTYPE.length);
    for (const name of NOT_IN_PROTOTYPE) {
      const icon = icons.find((item) => item.name === name);
      expect(icon, name).toBeDefined();
      if (icon) expect(shapes.has(icon.body), name).toBe(false);
    }
  });

  it("没收的只有实心图形与右上角胶囊示意", () => {
    const skipped = [...shapes.values()].filter((shape) => !shape.linear);
    expect(skipped.length).toBe(shapes.size - fromPrototype.length);
    for (const shape of skipped) expect(icons.some((icon) => icon.body === shape.body)).toBe(false);
  });

  it("线宽照原型原样保留", () => {
    for (const icon of fromPrototype) {
      const shape = shapes.get(icon.body);
      expect(shape, icon.name).toBeDefined();
      if (shape) expect(icon.strokeWidth, icon.name).toBe(prototypeWidth(shape));
    }
  });

  it("两端共用的图形只收一份", () => {
    const sharedByBoth = linear.filter((shape) => shape.sides.size === 2);
    expect(sharedByBoth.length).toBeGreaterThan(0);
    for (const shape of sharedByBoth) {
      expect(icons.filter((icon) => icon.body === shape.body)).toHaveLength(1);
    }
  });
});
