import { expect, it, vi } from "vitest";
import { accessFromMe } from "../auth/model";
import {
  accessEmpty,
  accessResult,
  actorScope,
  activationMessage,
  allowedStaffActions,
  workReady,
  writeIntent,
  type OpenWork,
} from "./staff-access";

const access = accessFromMe({
  staff: { staffId: "staff-a", name: "员工", roleKey: "super_admin", isLead: true },
  roleName: "管理员",
  moduleLevels: {
    workbench: "v",
    drama: "n",
    billing: "n",
    merchant: "n",
    order: "n",
    delivery: "n",
    publish: "n",
    service: "n",
    finance: "n",
    report: "n",
    ops: "n",
    system: "e",
    channel: "n",
  },
  permissions: ["sys.staff.manage"],
  dataScope: "all",
  flags: {},
});
it("actions 必须同时由当前后端返回且有当前权限，未知动作不成为可执行项", () => {
  expect(
    allowedStaffActions({ actions: ["update", "disable", "future", "enable"] }, access),
  ).toEqual(["update", "enable"]);
  expect(allowedStaffActions({ actions: ["update"] }, null)).toEqual([]);
});
it("员工身份、角色与权限变化分别改变组件scope，匿名不沿用员工scope", () => {
  expect(actorScope(access)).not.toBe(actorScope(null));
  expect(actorScope(access)).not.toBe(
    actorScope({ ...access, staff: { ...access.staff, id: "staff-b" } }),
  );
  expect(actorScope(access)).not.toBe(actorScope({ ...access, actions: [] }));
});
it("写入同步双击只发一次，成功后不重复外呼", async () => {
  let resolve!: (value: string) => void;
  const send = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const intent = writeIntent("test", () => "key-1");
  const first = intent.run({ a: 1 }, send);
  expect(await intent.run({ a: 1 }, send)).toBeUndefined();
  resolve("done");
  expect(await first).toBe("done");
  expect(await intent.run({ a: 1 }, send)).toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
});
it("失败重试复用幂等键，实质输入变更才换键", async () => {
  let sequence = 0;
  const send = vi.fn<(key: string) => Promise<void>>().mockRejectedValue(new Error("network"));
  const intent = writeIntent("test", () => `key-${++sequence}`);
  for (const body of [{ a: 1 }, { a: 1 }, { a: 2 }])
    await expect(intent.run(body, send)).rejects.toThrow("network");
  expect(send.mock.calls.map(([key]) => key)).toEqual(["key-1", "key-1", "key-2"]);
});
it("真实在办与实际候选是移交前置，其他原因不可缺说明", () => {
  const work: OpenWork = {
    staff: {
      staffId: "a",
      staffNo: 1001,
      name: "甲",
      roleKey: "cs",
      isLead: false,
      status: "active",
    },
    total: 1,
    bySource: [],
    pendingApprovalsAsRequester: 0,
    candidates: [
      { staffId: "b", staffNo: 1002, name: "乙", roleKey: "cs", isLead: false, status: "active" },
    ],
  };
  expect(workReady(undefined, "b", "reassigned", "")).toBe(false);
  expect(workReady(work, "fake", "reassigned", "")).toBe(false);
  expect(workReady(work, "b", "other", " ")).toBe(false);
  expect(workReady(work, "b", "other", "核实调岗")).toBe(true);
});
it("空成功envelope与错误符号按真实契约处理；重放无激活码声明", async () => {
  await expect(
    accessEmpty({ data: { code: 0, message: "ok" }, response: new Response(null) }),
  ).resolves.toBeUndefined();
  await expect(
    accessResult({
      error: { code: 40901, error: "VERSION_CONFLICT", message: "版本已变化" },
      response: new Response(null, { status: 409 }),
    }),
  ).rejects.toMatchObject({ failure: { symbol: "VERSION_CONFLICT" } });
  expect(
    activationMessage({
      purpose: "activate",
      delivery: "manual",
      expiresAt: "2026-10-10T00:00:00Z",
      activationCode: null,
      replayed: true,
    }),
  ).toContain("重放");
});
