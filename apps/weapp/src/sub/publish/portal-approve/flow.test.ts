import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/request";
import { createPrivacy } from "@/lib/privacy";
import { createDeliveryGuard } from "@/stores/delivery";
import type { createPortalApprovalApi, PortalDecision, PortalPreview } from "./api";
import { createPortalApprovalFlow } from "./flow";

const NOW = Date.parse("2026-11-04T10:00:00Z");
const preview: PortalPreview = {
  portalTicketId: "019a2cb2-3000-7000-8000-000000000001",
  storeId: "019a2cb2-3000-7000-8000-000000000002",
  storeName: "北门店",
  browser: "Firefox",
  regionHint: null,
  createdAt: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + 120000).toISOString(),
  pairChoices: ["17", "23", "36"],
};
const approved: PortalDecision = {
  portalTicketId: preview.portalTicketId,
  status: "approved",
  rejectReason: null,
  approvedAt: new Date(NOW).toISOString(),
  storeId: preview.storeId,
};
const rejected: PortalDecision = {
  ...approved,
  status: "rejected",
  rejectReason: "by_owner",
  approvedAt: null,
  storeId: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function invalid(reason: string) {
  return new ApiError({
    error: "PORTAL_TICKET_INVALID",
    status: 410,
    message: "server",
    requestId: "test",
    details: { reason },
  });
}
function setup(options: { initial?: string; role?: string; token?: string | null } = {}) {
  let scope = {
    store: preview.storeId,
    token: options.token === undefined ? "merchant-session" : options.token,
    role: options.role ?? "owner",
    rev: 1,
  };
  let member = "member-a",
    now = NOW,
    keys = 0;
  type Api = ReturnType<typeof createPortalApprovalApi>;
  const api = {
    lookup: vi.fn<Api["lookup"]>().mockResolvedValue(preview),
    approve: vi.fn<Api["approve"]>().mockResolvedValue(approved),
    reject: vi.fn<Api["reject"]>().mockResolvedValue(rejected),
  };
  const key = vi.fn((action: string) => `${action}:${++keys}`);
  const guard = createDeliveryGuard(() => JSON.stringify(scope), key);
  const authorize = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
  const privacy = createPrivacy({
    getPrivacySetting: async () => ({ needAuthorization: true }),
    requirePrivacyAuthorize: authorize,
  });
  const scan = vi.fn(async () => ({ result: "AB12CD34" }));
  const flow = createPortalApprovalFlow(
    {
      api,
      scope: () => scope,
      identity: () => JSON.stringify([scope, member]),
      now: () => now,
      withPrivacy: privacy.withPrivacy,
      scan,
    },
    options.initial,
  );
  async function run<T>(action: (current: () => boolean) => Promise<T>) {
    const current = guard.begin();
    if (!current) return null;
    try {
      return await action(current);
    } finally {
      guard.finish(current);
    }
  }
  return {
    api,
    flow,
    guard,
    key,
    authorize,
    scan,
    run,
    read: () => flow.load(guard.nextRead()),
    find: () => run((current) => flow.find("AB12CD34", current)),
    decide: (allow = true, pair = "17") =>
      run((current) => flow.decide(allow, pair, current, guard.intent)),
    change: (value: Partial<typeof scope>) => {
      scope = { ...scope, ...value };
    },
    changeMember: () => {
      member = "member-b";
    },
    advance: () => {
      now += 120000;
    },
  };
}

describe("审批真实动作与终态", () => {
  it("深链失败后可手输恢复；取消后刷新不重新打开路由中的旧登录码", async () => {
    const h = setup({ initial: "AB12CD34" });
    h.api.lookup.mockRejectedValueOnce(invalid("expired"));
    expect(await h.read()).toMatchObject({
      preview: null,
      decision: null,
      notice: expect.stringContaining("过期"),
    });
    await h.find();
    expect(h.flow.snapshot().preview).toEqual(preview);
    h.flow.reset();
    await h.read();
    expect(h.api.lookup).toHaveBeenCalledTimes(2);
    expect(h.flow.snapshot()).toMatchObject({ code: "", preview: null, decision: null });
    expect(h.api.approve).not.toHaveBeenCalled();
    expect(h.api.reject).not.toHaveBeenCalled();
  });
  it("候选内错数字由服务器裁决：200 rejected/pair_mismatch 是拒绝终态，不能继续批准", async () => {
    const h = setup();
    await h.find();
    h.api.approve.mockResolvedValueOnce({ ...rejected, rejectReason: "pair_mismatch" });
    await h.decide(true, "23");
    expect(h.api.approve).toHaveBeenCalledWith(preview.portalTicketId, "23", expect.any(String));
    expect(h.flow.snapshot()).toMatchObject({
      preview: null,
      decision: { status: "rejected", rejectReason: "pair_mismatch" },
    });
    await h.decide();
    await h.read();
    expect(h.api.approve).toHaveBeenCalledTimes(1);
    expect(h.api.lookup).toHaveBeenCalledTimes(1);
  });
  it("拒绝与批准共用同步锁；重复点击仅发一次，真实拒绝回执后不可重放", async () => {
    const h = setup(),
      pending = deferred<PortalDecision>();
    await h.find();
    h.api.reject.mockReturnValueOnce(pending.promise);
    const first = h.decide(false),
      duplicate = h.decide(false),
      opposite = h.decide(true);
    expect(h.api.reject).toHaveBeenCalledTimes(1);
    expect(h.api.approve).not.toHaveBeenCalled();
    pending.resolve(rejected);
    await Promise.all([first, duplicate, opposite]);
    expect(h.flow.snapshot().decision).toEqual(rejected);
    await h.decide(false);
    expect(h.api.reject).toHaveBeenCalledTimes(1);
  });
  it("未知网络结果保留同意图键供重试；批准回执后刷新不重发或重查初始码", async () => {
    const h = setup({ initial: "AB12CD34" });
    await h.read();
    h.api.approve.mockRejectedValueOnce(new Error("network"));
    await expect(h.decide()).rejects.toThrow("network");
    await h.decide();
    expect(h.api.approve.mock.calls[0]).toEqual(h.api.approve.mock.calls[1]);
    expect(h.key).toHaveBeenCalledTimes(1);
    await h.read();
    await h.decide();
    expect(h.flow.snapshot().decision).toEqual(approved);
    expect(h.api.lookup).toHaveBeenCalledTimes(1);
    expect(h.api.approve).toHaveBeenCalledTimes(2);
  });
  it("取消旧确认结束意图；同票据重新核对后使用新键", async () => {
    const h = setup();
    await h.find();
    h.api.approve.mockRejectedValueOnce(new Error("network"));
    await expect(h.decide()).rejects.toThrow();
    h.flow.reset();
    await h.find();
    await h.decide();
    expect(h.api.approve.mock.calls[0]![2]).not.toBe(h.api.approve.mock.calls[1]![2]);
  });
  it.each([
    ["expired", "过期"],
    ["approved", "已确认"],
    ["consumed", "已使用"],
    ["rejected", "已作废"],
    ["not_found", "未找到"],
  ])("服务端 %s 清掉旧确认，不造成功，也不允许第二次决策", async (reason, message) => {
    const h = setup();
    await h.find();
    h.api.approve.mockRejectedValueOnce(invalid(reason));
    await h.decide();
    expect(h.flow.snapshot()).toMatchObject({
      preview: null,
      decision: null,
      notice: expect.stringContaining(message),
    });
    await h.decide();
    expect(h.api.approve).toHaveBeenCalledTimes(1);
  });
  it("显示期间到期和不在候选内的数字不发写请求", async () => {
    const h = setup();
    await h.find();
    await expect(h.decide(true, "99")).rejects.toThrow("两位数字");
    h.advance();
    await h.decide();
    expect(h.flow.snapshot().notice).toContain("过期");
    expect(h.api.approve).not.toHaveBeenCalled();
  });
  it("拒绝后端返回的其它票据或门店授权回执，不显示成功", async () => {
    const h = setup();
    await h.find();
    h.api.approve.mockResolvedValueOnce({ ...approved, storeId: "other-store" });
    await expect(h.decide()).rejects.toThrow("不一致");
    expect(h.flow.snapshot().decision).toBeNull();
  });
});

describe("权限、身份与迟到隔离", () => {
  it.each([{ role: "clerk" }, { token: null }])("%j 不查票据或调用扫码", async (options) => {
    const h = setup(options);
    await expect(h.find()).rejects.toThrow();
    await expect(h.run((current) => h.flow.scan(current))).rejects.toThrow();
    expect(h.api.lookup).not.toHaveBeenCalled();
    expect(h.scan).not.toHaveBeenCalled();
  });
  it("lookup 摘要属于别店时不能进入确认", async () => {
    const h = setup();
    h.api.lookup.mockResolvedValueOnce({ ...preview, storeId: "other-store" });
    await expect(h.find()).rejects.toThrow("门店已变化");
    expect(h.flow.snapshot().preview).toBeNull();
    await h.decide();
    expect(h.api.approve).not.toHaveBeenCalled();
  });
  it.each(["ROLE_FORBIDDEN", "NOT_A_MEMBER"] as const)("服务端 %s 清除旧确认", async (error) => {
    const h = setup();
    await h.find();
    h.api.approve.mockRejectedValueOnce(
      new ApiError({ error, status: 403, requestId: "test", message: "server" }),
    );
    await h.decide();
    expect(h.flow.snapshot().preview).toBeNull();
    expect(h.flow.snapshot().decision).toBeNull();
    expect(h.flow.snapshot().notice).toMatch(/老板|权限/);
    await h.decide();
    expect(h.api.approve).toHaveBeenCalledTimes(1);
  });
  it.each(["store", "token", "role", "member"])("%s 变化使旧确认和在途回执失效", async (kind) => {
    const h = setup(),
      pending = deferred<PortalDecision>();
    await h.find();
    h.api.approve.mockReturnValueOnce(pending.promise);
    const work = h.decide();
    if (kind === "member") h.changeMember();
    else
      h.change(
        kind === "store"
          ? { store: "other-store" }
          : kind === "token"
            ? { token: "other-token" }
            : { role: "clerk" },
      );
    pending.resolve(approved);
    expect(await work).toBeNull();
    expect(h.flow.snapshot()).toMatchObject({ preview: null, decision: null });
    await h.decide();
    expect(h.api.approve).toHaveBeenCalledTimes(1);
  });
  it.each(["hide", "unmount", "new-read"])("%s 后迟到 lookup 不重开旧确认", async (kind) => {
    const h = setup(),
      pending = deferred<PortalPreview>();
    h.api.lookup.mockReturnValueOnce(pending.promise);
    const work = h.flow.find("AB12CD34", h.guard.nextRead());
    if (kind === "hide") h.flow.reset();
    else if (kind === "unmount") h.guard.dispose();
    else h.guard.nextRead();
    pending.resolve(preview);
    expect(await work).toBeNull();
    expect(h.flow.snapshot().preview).toBeNull();
  });
  it("离页后的旧 API 错误不落到新界面", async () => {
    const h = setup(),
      pending = deferred<PortalPreview>();
    h.api.lookup.mockReturnValueOnce(pending.promise);
    const work = h.find();
    h.guard.dispose();
    pending.reject(new Error("old failure"));
    expect(await work).toBeNull();
    expect(h.flow.snapshot().notice).toBeNull();
  });
});

describe("隐私和原生扫码恢复", () => {
  it("隐私拒绝不打开相机；再次主动扫码可恢复，拒绝状态仍可手输", async () => {
    const h = setup();
    h.authorize.mockRejectedValueOnce(new Error("declined"));
    await h.run((current) => h.flow.scan(current));
    expect(h.flow.snapshot().notice).toContain("手输");
    expect(h.scan).not.toHaveBeenCalled();
    expect(h.api.lookup).not.toHaveBeenCalled();
    await h.run((current) => h.flow.scan(current));
    expect(h.scan).toHaveBeenCalledTimes(1);
    expect(h.flow.snapshot().preview).toEqual(preview);
  });
  it("取消扫码只清核对并保留恢复入口，不调用批准/拒绝", async () => {
    const h = setup();
    h.scan.mockRejectedValueOnce({ errMsg: "scanCode:fail cancel" });
    await h.run((current) => h.flow.scan(current));
    expect(h.flow.snapshot()).toMatchObject({
      preview: null,
      decision: null,
      notice: expect.stringContaining("已取消扫码"),
    });
    expect(h.flow.nativePending()).toBe(false);
    expect(h.api.lookup).not.toHaveBeenCalled();
    expect(h.api.approve).not.toHaveBeenCalled();
    expect(h.api.reject).not.toHaveBeenCalled();
    await h.find();
    expect(h.flow.snapshot().preview).toEqual(preview);
  });
  it.each(["member", "hide", "unmount"])(
    "隐私弹窗期间 %s 后不再打开旧扫码/查票据",
    async (kind) => {
      const h = setup(),
        allowed = deferred<unknown>(),
        entered = deferred<void>();
      h.authorize.mockImplementationOnce(() => {
        entered.resolve();
        return allowed.promise;
      });
      const work = h.run((current) => h.flow.scan(current));
      await entered.promise;
      expect(h.flow.nativePending()).toBe(true);
      if (kind === "member") h.changeMember();
      else if (kind === "hide") h.flow.reset();
      else h.guard.dispose();
      allowed.resolve(undefined);
      expect(await work).toBeNull();
      expect(h.scan).not.toHaveBeenCalled();
      expect(h.api.lookup).not.toHaveBeenCalled();
    },
  );
});
