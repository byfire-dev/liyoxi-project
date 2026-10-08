import { describe, expect, it } from "vitest";
import { SUBSCRIBERS, TIMERS } from "@liyoxi/contract/registry";
import type { AccessSnapshot } from "../../../lib/permissions";
import type { TimerView } from "./api";
import {
  actionAllowed,
  actorKey,
  canReadFlow,
  changeFilter,
  cursorScope,
  flowSearch,
  outboxQuery,
  reasonValid,
  safeSummary,
  statusLabel,
  tableSearch,
  timerQuery,
  webhookQuery,
} from "./model";
const id = "0199e187-e72a-7000-8000-000000000001";
const access: AccessSnapshot = {
  staff: { id, name: "测试", roleKey: "finance", roleName: "财务" },
  isLead: false,
  moduleLevels: { system: "n" },
  actions: [],
  dataScope: "all",
  releases: {},
};
describe("流程运维实际查询与权限模型", () => {
  it("分别保留两种页码与仅回调游标，不混用或泄漏未知UI字段", () => {
    expect(timerQuery(flowSearch({ page: 2, pageSize: 10, cursor: "abc", media: "1" }))).toEqual({
      status: "failed",
      page: 2,
      pageSize: 10,
    });
    expect(
      outboxQuery(
        flowSearch({ tab: "outbox", page: 2, pageSize: 50, subscriber: SUBSCRIBERS[0]!.name }),
      ),
    ).toMatchObject({ page: 2, pageSize: 50, status: "dead", subscriber: SUBSCRIBERS[0]!.name });
    expect(
      webhookQuery(
        flowSearch({
          tab: "webhooks",
          page: 9,
          provider: "wechat,wechatpay",
          processState: "failed,dead",
          limit: 100,
          cursor: "YWJj",
        }),
      ),
    ).toEqual({
      provider: "wechat,wechatpay",
      processState: "failed,dead",
      limit: 100,
      cursor: "YWJj",
    });
  });
  it("正式CSV wire保持文本，坏日期/UUID/配对/枚举/数量恢复但不删除别的合法字段", () => {
    const search = flowSearch({
      status: "failed,scheduled",
      kind: TIMERS[0]!.kind,
      entityId: id,
      subjectType: "drama_order",
      subjectId: "bad",
      fireFrom: "2026-02-30",
      page: "nan",
      pageSize: 100,
      unknown: "secret",
    });
    expect(search).toEqual({
      tab: "timers",
      status: "failed,scheduled",
      kind: TIMERS[0]!.kind,
      entityId: id,
      page: "1",
      pageSize: "20",
    });
    expect(
      flowSearch({ status: "constructor", fireFrom: "2026-10-08", fireTo: "2026-10-07" }),
    ).toEqual({ tab: "timers", status: "failed", page: "1", pageSize: "20" });
    expect(flowSearch({ tab: "outbox", aggregateType: "drama_order" })).not.toHaveProperty(
      "aggregateType",
    );
    expect(
      flowSearch({ tab: "webhooks", cursor: "https://evil.invalid", provider: "evil", limit: 101 }),
    ).toEqual({ tab: "webhooks", processState: "failed,dead", limit: "20" });
  });
  it("筛选清分页，游标范围与参数顺序无关且仅原页码控件控制页数", () => {
    expect(
      changeFilter(flowSearch({ page: 3, subjectType: "drama_order", subjectId: id }), {
        entityId: id,
      }),
    ).toMatchObject({ page: "1", subjectType: "drama_order", subjectId: id, entityId: id });
    const search = flowSearch({ tab: "webhooks", cursor: "YWJj", provider: "wechatpay" });
    expect(cursorScope(search)).toBe(cursorScope({ ...search, cursor: "ZGVm" }));
    expect(cursorScope(search)).not.toBe(cursorScope({ ...search, provider: "wechat" }));
    expect(changeFilter(search, { eventType: "TRANSACTION.SUCCESS" })).not.toHaveProperty("cursor");
    expect(tableSearch(flowSearch({ page: 2, status: "failed", entityId: id }))).toEqual({
      tab: "timers",
      q: undefined,
      page: 2,
      pageSize: 20,
      sort: undefined,
      filters: {},
    });
  });
  it("system查看 OR 显式flow查看；manage与服务端actions缺一都不渲染", () => {
    expect(canReadFlow(null)).toBe(false);
    expect(canReadFlow(access)).toBe(false);
    const system = { ...access, moduleLevels: { system: "v" as const } },
      view = { ...access, actions: ["flow.ops.view"] },
      manage = { ...access, actions: ["flow.ops.manage"] };
    expect(canReadFlow(system)).toBe(true);
    expect(canReadFlow(view)).toBe(true);
    expect(canReadFlow(manage)).toBe(false);
    const row = { timerId: id, actions: ["reschedule", "cancel"] } as TimerView;
    expect(actionAllowed(system, { kind: "cancel", row })).toBe(false);
    expect(actionAllowed(manage, { kind: "cancel", row })).toBe(true);
    expect(actionAllowed(manage, { kind: "cancel", row: { ...row, actions: [] } })).toBe(false);
    expect(actorKey(view)).not.toBe(actorKey(manage));
  });
  it("取消真实5–200字，备注可空，emoji按字而非UTF16；安全摘要不展示未知复杂内容", () => {
    expect(reasonValid("cancel", "四个字呀")).toBe(false);
    expect(reasonValid("cancel", "五个字理由")).toBe(true);
    expect(reasonValid("cancel", " 😀😀😀😀😀 ")).toBe(true);
    expect(reasonValid("retry-outbox", "")).toBe(true);
    expect(reasonValid("retry-webhook", "x".repeat(201))).toBe(false);
    expect(safeSummary({ token: "fake-secret", nested: { phone: "13900000000" } })).toBe(
      "复杂内容已裁剪",
    );
    expect(safeSummary({ amountFen: 100, state: "SUCCESS", serial: "A1", user: { id } })).toBe(
      "金额（分）：100 · 状态：SUCCESS · 流水：A1",
    );
    expect(statusLabel("constructor")).toBe("未知状态");
    expect(statusLabel("dead")).toBe("死信");
  });
});
