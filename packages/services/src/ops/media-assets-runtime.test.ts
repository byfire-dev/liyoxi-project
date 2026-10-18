import { expect, it, vi } from "vitest";
import { uuidv7 } from "../kernel/index.js";
import type { DeliveredEvent, FiredTimer, Tx } from "../kernel/index.js";
import { assembleForTest } from "../testing/index.js";
import { createMediaAssetsAssembly } from "./media-assets-runtime.js";

const event: DeliveredEvent = {
  id: uuidv7(),
  type: "calendar.imported",
  payload: { v: 1, year: 2026, calendarVersion: 1, changedDays: [] },
};
const timer: FiredTimer = {
  id: uuidv7(),
  kind: "sla.breach",
  subjectType: "store_asset",
  subjectId: uuidv7(),
  payload: {},
};
const tx = {} as Tx;
const service = () => ({
  onAssetCalendarImported: vi.fn(async () => {}),
  onAssetSlaBreach: vi.fn(async () => "skipped" as const),
});

it("两个素材assembly只使用所属实例，关闭后拒绝而不回退到另一实例", async () => {
  const base = assembleForTest({ entry: "api" });
  const a = createMediaAssetsAssembly(base),
    b = createMediaAssetsAssembly(base);
  const first = service(),
    second = service();
  a.attach(first);
  b.attach(second);
  try {
    await a.assembly.subscriber("media.onCalendarImported")!.handle(tx, event);
    await b.assembly.subscriber("media.onCalendarImported")!.handle(tx, event);
    await a.assembly.timerHandler("sla.breach")!.handle(tx, timer);
    expect(first.onAssetCalendarImported).toHaveBeenCalledExactlyOnceWith(tx, event);
    expect(second.onAssetCalendarImported).toHaveBeenCalledExactlyOnceWith(tx, event);
    expect(first.onAssetSlaBreach).toHaveBeenCalledExactlyOnceWith(tx, timer);
    expect(second.onAssetSlaBreach).not.toHaveBeenCalled();
    b.close();
    await a.assembly.subscriber("media.onCalendarImported")!.handle(tx, event);
    expect(first.onAssetCalendarImported).toHaveBeenCalledTimes(2);
    expect(() => b.assembly.subscriber("media.onCalendarImported")!.handle(tx, event)).toThrow(
      TypeError,
    );
    expect(() => b.attach(first)).toThrow(TypeError);
    a.close();
    expect(() => a.assembly.timerHandler("sla.breach")!.handle(tx, timer)).toThrow(TypeError);
    expect(second.onAssetSlaBreach).not.toHaveBeenCalled();
  } finally {
    a.close();
    b.close();
  }
});

it("只接管store_asset SLA，原其它subject处理与所有port保持同一对象", async () => {
  const actual = assembleForTest({ entry: "worker" });
  const original = vi.fn(async () => "fired" as const);
  const base = {
    ...actual,
    timerHandlers: actual.timerHandlers.map((item) =>
      item.kind === "sla.breach" ? { ...item, handle: original } : item,
    ),
  };
  const scope = createMediaAssetsAssembly(base),
    own = service();
  scope.attach(own);
  try {
    const sibling = { ...timer, subjectType: "delivery_ticket" };
    expect(await scope.assembly.timerHandler("sla.breach")!.handle(tx, sibling)).toBe("fired");
    expect(original).toHaveBeenCalledExactlyOnceWith(tx, sibling);
    expect(own.onAssetSlaBreach).not.toHaveBeenCalled();
    expect(scope.assembly.ports).toBe(base.ports);
    expect(scope.assembly.portImplementations).toBe(base.portImplementations);
    expect(scope.assembly.invariants).toBe(base.invariants);
    expect(() => scope.attach(service())).toThrow(TypeError);
  } finally {
    scope.close();
  }
});
