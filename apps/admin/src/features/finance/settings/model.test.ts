import { expect, it } from "vitest";
import {
  canPropose,
  configDecisions,
  createConfigIntent,
  currentConfig,
  settingsSearch,
} from "./model";
import { access, bank, requester } from "./fixtures.test-support";

it("财务scope、真实actions与creator共同守卫；当前生效不混待生效且非法URL选择清空", () => {
  const row = bank();
  expect(canPropose(access)).toBe(true);
  expect(configDecisions(row, access)).toEqual(["approve", "reject"]);
  expect(configDecisions(row, { ...access, staff: { ...access.staff, id: requester } })).toEqual(
    [],
  );
  expect(configDecisions(row, { ...access, moduleLevels: { finance: "n" } })).toEqual([]);
  expect(canPropose({ ...access, actions: [] })).toBe(false);
  expect(
    configDecisions(
      { ...row, actions: ["withdraw"], approval: { ...row.approval, actions: [] } },
      access,
    ),
  ).toEqual([]);
  expect(configDecisions({ ...row, state: "scheduled" }, access)).toEqual([]);
  expect(currentConfig([{ ...row, state: "scheduled" }], "bank_account")).toBeNull();
  expect(
    currentConfig([{ ...row, state: "effective" }], "bank_account")?.financeConfigRevisionId,
  ).toBe(row.financeConfigRevisionId);
  expect(
    settingsSearch({ id: "javascript:bad", tab: "invalid", configKey: "future" }),
  ).toMatchObject({ id: undefined, tab: "current", configKey: undefined, page: 1 });
});
it("同正文未知结果保留原key，同步闩挡双击；scope关闭取消运输并丢弃迟到结果", async () => {
  let count = 0;
  const intent = createConfigIntent(() => `fixture-${++count}`),
    keys: string[] = [];
  await expect(
    intent.submit("create", { value: 0 }, async (key) => {
      keys.push(key);
      throw new Error("unknown");
    }),
  ).rejects.toThrow("unknown");
  expect(
    await intent.submit("create", { value: 0 }, async (key) => {
      keys.push(key);
      return true;
    }),
  ).toBe(true);
  expect(keys).toEqual(["fixture-1", "fixture-1"]);
  let finish!: (value: string) => void, signal!: AbortSignal;
  const pending = intent.submit("approve", { version: 7 }, async (_key, own) => {
    signal = own;
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  expect(intent.pending).toBe(true);
  expect(
    await intent.submit("approve", { version: 7 }, async () => {
      throw new Error("double submit");
    }),
  ).toBeUndefined();
  intent.close();
  expect(signal.aborted).toBe(true);
  finish("late");
  expect(await pending).toBeUndefined();
  intent.activate();
  expect(await intent.submit("approve", { version: 8 }, async (key) => key)).toBe("fixture-3");
});
