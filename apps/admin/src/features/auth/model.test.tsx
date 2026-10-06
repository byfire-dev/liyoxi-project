import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AccessContext,
  Can,
  useCan,
  useModuleLevel,
  type AccessSnapshot,
} from "../../lib/permissions";
import {
  accessFromMe,
  createStepUpController,
  liveTicket,
  nextPath,
  safeRedirect,
  type MeAccess,
} from "./model";

const me: MeAccess = {
  staff: { staffId: "staff-id", name: "周航", roleKey: "super_admin", isLead: true },
  roleName: "超级管理员",
  moduleLevels: { workbench: "v" } as MeAccess["moduleLevels"],
  permissions: ["staff.create"],
  dataScope: "all",
  flags: { "release.partner": true, "release.notice": "true", other: true },
};
describe("后台权限与登录去向", () => {
  it("当前员工映射补齐模块，release 仅接受真布尔值，未知范围收窄", () => {
    const access = accessFromMe(me);
    expect(access.staff).toEqual({
      id: "staff-id",
      name: "周航",
      roleKey: "super_admin",
      roleName: "超级管理员",
    });
    expect(Object.keys(access.moduleLevels)).toHaveLength(13);
    expect(access.moduleLevels.system).toBe("n");
    expect(access.dataScope).toBe("all");
    expect(access.releases).toEqual({ "release.partner": true, "release.notice": false });
    expect(accessFromMe({ ...me, dataScope: "future" }).dataScope).toBe("own");
  });
  it("四种 next 各走登记地址；票据刷新丢失、用途不符或到期均不可继续", () => {
    expect(
      ["mfa", "set_password", "enroll_totp", "login"].map((value) =>
        nextPath(value as Parameters<typeof nextPath>[0]),
      ),
    ).toEqual(["/login/mfa", "/login/set-password", "/login/enroll-totp", "/login"]);
    const ticket = {
      next: "mfa" as const,
      ticket: "memory-only",
      ticketExpiresAt: "2026-10-06T06:00:00Z",
      methods: [],
    };
    expect(liveTicket(ticket, "mfa", Date.parse("2026-10-06T05:00:00Z"))).toBe("memory-only");
    expect(liveTicket(ticket, "enroll_totp", 0)).toBeNull();
    expect(liveTicket(ticket, "mfa", Date.parse(ticket.ticketExpiresAt))).toBeNull();
    expect(liveTicket(null, "mfa")).toBeNull();
  });
  it("redirect 保留站内查询与锚点，拒绝站外和登录循环", () => {
    expect(safeRedirect("/sys/staff?page=2#x")).toBe("/sys/staff?page=2#x");
    for (const value of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/login",
      "/login/mfa",
      "/%2e%2e/login",
      "/x\n",
      null,
    ])
      expect(safeRedirect(value)).toBe("/");
  });
  it("权限钩子与 Can 读取同一上下文，缺权限显示 fallback", () => {
    function Probe() {
      return (
        <>
          {useModuleLevel("system")}|{String(useCan("staff.create"))}
          <Can action="staff.create">允许</Can>
          <Can module="system" fallback="不可见">
            泄露
          </Can>
        </>
      );
    }
    const render = (access: AccessSnapshot | null) =>
      renderToStaticMarkup(
        createElement(AccessContext.Provider, { value: access }, createElement(Probe)),
      );
    expect(render(accessFromMe(me))).toBe("n|true允许不可见");
    expect(render(null)).toBe("n|false不可见");
  });
  it("再验证并发意图共享一个弹层结果，下一次可重新验证", async () => {
    const modal = createStepUpController();
    const first = modal.request();
    const second = modal.request();
    expect(first).toBe(second);
    expect(modal.get()).toBe(true);
    modal.settle(true);
    expect(await first).toBe(true);
    expect(modal.get()).toBe(false);
    const next = modal.request();
    modal.settle(false);
    expect(await next).toBe(false);
  });
});
