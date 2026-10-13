import { describe, expect, it } from "vitest";
import { createAdminApi } from "../../../lib/api";
import type { AccessSnapshot } from "../../../lib/permissions";
import { writeIntent } from "../../system/staff-access";
import { createReferralApi, type ReferralRow } from "./api";
import {
  canManageReferral,
  referralAction,
  referralBody,
  referralQuery,
  referralSearch,
  sourceLabel,
  statusLabel,
} from "./model";

const id = "0199e187-e72a-7000-8000-000000000001";
const row: ReferralRow = {
  referralCodeId: id,
  code: "TESTCODE",
  sourceType: "campaign",
  owner: null,
  label: null,
  status: "active",
  disabledAt: null,
  registeredUserCount: 3,
  entityCount: 2,
  createdAt: "2030-10-14T04:00:00.000Z",
};
const access: AccessSnapshot = {
  staff: { id, name: "虚构员工", roleKey: "cs", roleName: "客服" },
  isLead: true,
  moduleLevels: { merchant: "v" },
  actions: ["merchant.referral_code.manage"],
  dataScope: "all",
  releases: {},
};
const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, message: "ok", data }), {
    headers: { "Content-Type": "application/json" },
  });
const failure = (status: number, error: string) =>
  new Response(JSON.stringify({ code: 40001, error, message: "虚构受控拒绝" }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function transport(reply: (request: Request, index: number) => Response, stepUp = () => {}) {
  const requests: Request[] = [];
  const api = createAdminApi({
    baseUrl: "http://admin.test",
    build: "w215",
    fetch: async (input) => {
      if (!(input instanceof Request)) throw new Error("必须使用真实Request");
      requests.push(input.clone());
      return reply(input, requests.length);
    },
    handlers: {
      redirectToLogin() {},
      stepUp: async () => {
        stepUp();
        return true;
      },
      refreshAccess() {},
      invalidateQueries() {},
      notify() {},
      showBlocked() {},
      buildMismatch() {},
    },
  });
  return { api: createReferralApi({ api }), requests };
}
describe("W215渠道码真实契约与运输", () => {
  it("URL独立恢复坏筛选、闭集写入与权限状态相交，未知读枚举保留而坏结构拒绝", async () => {
    expect(
      referralQuery({
        q: " ABC ",
        sourceType: "sales,campaign",
        status: "active,disabled",
        ownerStaffId: id,
        page: 2,
        pageSize: 50,
        sort: "unexpected",
        tab: "secret",
      }),
    ).toEqual({
      q: "ABC",
      sourceType: "sales,campaign",
      status: "active,disabled",
      ownerStaffId: id,
      page: 2,
      pageSize: 50,
    });
    expect(
      referralSearch({
        q: "x".repeat(35),
        status: "bad",
        sourceType: "partner",
        ownerStaffId: "bad",
        page: -1,
        pageSize: 100,
      }),
    ).toEqual({ q: "x".repeat(30), page: "1", pageSize: "20", sourceType: "partner" });
    expect(canManageReferral(access)).toBe(true);
    expect(canManageReferral({ ...access, moduleLevels: {} })).toBe(false);
    expect(referralAction({ ...access, actions: [] }, row)).toBeUndefined();
    expect(referralAction(access, row)).toBe("disable");
    expect(referralAction(access, { ...row, status: "disabled" })).toBe("enable");
    expect(referralAction(access, { ...row, status: "future" })).toBeUndefined();
    expect(sourceLabel("future")).toBe("未识别来源");
    expect(statusLabel("future")).toBe("未识别状态");
    expect(
      referralBody({ code: " abc4 ", sourceType: "sales", ownerStaffId: "", label: "" }).success,
    ).toBe(false);
    expect(
      referralBody({ code: " abc4 ", sourceType: "campaign", ownerStaffId: id, label: " 注释 " }),
    ).toMatchObject({
      success: true,
      data: { code: "ABC4", sourceType: "campaign", label: "注释" },
    });
    const future = transport(() =>
      ok({
        items: [
          {
            ...row,
            sourceType: "future_source",
            status: "future_state",
            owner: {
              staffId: id,
              staffNo: 1001,
              name: "虚构员工",
              roleKey: "future_role",
              isLead: false,
              status: "future_staff",
            },
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      }),
    );
    expect((await future.api.list({})).items[0]).toMatchObject({
      sourceType: "future_source",
      status: "future_state",
      owner: { roleKey: "future_role", status: "future_staff" },
    });
    const malformed = transport(() =>
      ok({ items: [{ ...row, registeredUserCount: -1 }], total: 1, page: 1, pageSize: 20 }),
    );
    await expect(malformed.api.list({})).rejects.toThrow("渠道码响应不符合契约");
  });
  it("四公口真实body与键；step-up重放和手动重试同意图同键、失败不伪成功且选人仅GET", async () => {
    let steps = 0,
      creates = 0;
    const client = transport(
      (request) => {
        const path = new URL(request.url).pathname;
        if (request.method === "GET")
          return ok({
            items: path.endsWith("staff") ? [] : [row],
            page: 1,
            pageSize: 20,
            total: path.endsWith("staff") ? 0 : 1,
          });
        if (path.endsWith("disable")) return ok({ ...row, status: "disabled" });
        if (path.endsWith("enable")) return failure(409, "INVALID_STATE");
        creates++;
        if (creates === 1) return failure(403, "STEP_UP_REQUIRED");
        if (creates === 2) return failure(409, "REFERRAL_CODE_TAKEN");
        return ok(row);
      },
      () => steps++,
    );
    await client.api.list(referralQuery({ sourceType: "sales,campaign", page: 2 }));
    await client.api.owners(" 虚构 ", 2);
    expect(client.requests.every((request) => request.method === "GET")).toBe(true);
    expect(new URL(client.requests[0]!.url).searchParams.get("sourceType")).toBe("sales,campaign");
    expect(new URL(client.requests[1]!.url).searchParams.get("status")).toBe("active");
    let keys = 0;
    const intent = writeIntent("referral-create", () => `intent-${++keys}`);
    const body = { code: "TESTCODE", sourceType: "campaign" as const };
    await expect(intent.run(body, (key) => client.api.create(body, key))).rejects.toMatchObject({
      failure: { symbol: "REFERRAL_CODE_TAKEN" },
    });
    expect(await intent.run(body, (key) => client.api.create(body, key))).toMatchObject({
      code: "TESTCODE",
    });
    expect(steps).toBe(1);
    expect(keys).toBe(1);
    expect(
      client.requests.slice(2, 5).map((request) => request.headers.get("Idempotency-Key")),
    ).toEqual(["intent-1", "intent-1", "intent-1"]);
    expect(await Promise.all(client.requests.slice(2, 5).map((request) => request.json()))).toEqual(
      [body, body, body],
    );
    expect(await intent.run(body, (key) => client.api.create(body, key))).toBeUndefined();
    expect(await client.api.disable(id, "disable-key")).toMatchObject({ status: "disabled" });
    await expect(client.api.enable(id, "enable-key")).rejects.toMatchObject({
      failure: { symbol: "INVALID_STATE", status: 409 },
    });
    expect(await client.requests[5]!.json()).toEqual({});
    expect(await client.requests[6]!.json()).toEqual({});
    expect(client.requests[5]!.headers.get("Idempotency-Key")).toBe("disable-key");
    expect(client.requests[6]!.headers.get("Idempotency-Key")).toBe("enable-key");
    expect(client.requests.every((request) => request.headers.get("X-LYX-Admin") === "1")).toBe(
      true,
    );
  });
});
