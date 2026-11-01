import { AdminSampleRequestChangeBodySchema } from "@liyoxi/contract";
import { describe, expect, it, vi } from "vitest";
import {
  actionCommand,
  createTicketActionIntent,
  emptyActionFields,
  forceTargets,
  type TicketCommand,
} from "./m5-actions";
import { TicketActionFailure, type M5Ticket } from "./m5-api";

// Model fixtures isolate request intent; they never substitute for the real live writer chain.
const id = "019aa000-0000-7000-8000-000000000001";
const ticket = {
  deliveryTicketId: id,
  ticketNo: "GD202611010001",
  step: "sample_confirm",
  lockVersion: 4,
  currentSample: { sampleId: "019aa000-0000-7000-8000-000000000002", versionNo: 3 },
} as M5Ticket;
const command: TicketCommand = { action: "reevaluate", body: {} };
const read = () => Promise.resolve(ticket);
const validate = () => {};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("工单实际请求意图与换域隔离", () => {
  it("同步双击只允许一条POST；成功必须取得写后GET", async () => {
    const gate = deferred<unknown>(),
      send = vi.fn((_key: string, _signal: AbortSignal) => gate.promise),
      fetch = vi.fn(read);
    const intent = createTicketActionIntent(() => "one-key");
    const first = intent.submit(command, fetch, validate, send);
    await expect(intent.submit(command, fetch, validate, send)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0]).toBe("one-key");
    gate.resolve({ transitions: [] });
    await expect(first).resolves.toEqual({ current: ticket, value: { transitions: [] } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("POST网络结果未知保留原键和原body，禁止另一意图覆盖", async () => {
    const intent = createTicketActionIntent(() => "same-key"),
      send = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("network"))
        .mockResolvedValueOnce({ replayed: true });
    await expect(intent.submit(command, read, validate, send)).rejects.toThrow("network");
    expect(intent.phase).toBe("unknown");
    await expect(
      intent.submit({ action: "rework", body: { reason: "更正内容" } }, read, validate, send),
    ).rejects.toMatchObject({ code: "RESULT_UNCERTAIN" });
    await intent.submit(command, read, validate, send);
    expect(send.mock.calls.map((call) => call[0])).toEqual(["same-key", "same-key"]);
  });
  it("POST已受理而写后GET失败，恢复只GET，不发第二条写请求", async () => {
    const intent = createTicketActionIntent(),
      send = vi.fn(async () => ({ accepted: true }));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(ticket)
      .mockRejectedValueOnce(new TypeError("read lost"));
    await expect(intent.submit(command, fetch, validate, send)).rejects.toThrow("read lost");
    expect(intent.phase).toBe("accepted");
    await expect(intent.submit(command, read, validate, send)).resolves.toMatchObject({
      value: { accepted: true },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([400, 403, 404, 409, 422, 429])(
    "%s前置失败后不得自动重放写，要求重读并重新确认",
    async (status) => {
      const intent = createTicketActionIntent(),
        send = vi.fn();
      await expect(
        intent.submit(
          command,
          read,
          () => {
            throw new TicketActionFailure("PRECONDITION_CHANGED", status);
          },
          send,
        ),
      ).rejects.toMatchObject({ status });
      await expect(intent.submit(command, read, validate, send)).rejects.toMatchObject({
        code: "RECONFIRM_REQUIRED",
      });
      expect(send).not.toHaveBeenCalled();
    },
  );
  it("切换对象或退出后，迟到预读不能发POST；重新激活不收旧结果", async () => {
    const intent = createTicketActionIntent(),
      late = deferred<M5Ticket>(),
      send = vi.fn();
    let signal: AbortSignal | undefined;
    const pending = intent.submit(
      command,
      (value) => {
        signal = value;
        return late.promise;
      },
      validate,
      send,
    );
    intent.close();
    intent.activate();
    late.resolve(ticket);
    expect(signal?.aborted).toBe(true);
    await expect(pending).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
  it("异步制作事实重核期间换域同样不能发POST", async () => {
    const intent = createTicketActionIntent(),
      gate = deferred<void>(),
      send = vi.fn();
    const pending = intent.submit(command, read, () => gate.promise, send);
    await Promise.resolve();
    intent.close();
    gate.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
  it("写前GET失败仍可修改尚未发送的表单", async () => {
    const intent = createTicketActionIntent(),
      send = vi.fn(async () => ({}));
    await expect(
      intent.submit(
        command,
        async () => {
          throw new TypeError("offline");
        },
        validate,
        send,
      ),
    ).rejects.toThrow();
    await intent.submit({ action: "rework", body: { reason: "新的原因" } }, read, validate, send);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
describe("工单正式契约表单", () => {
  it("首次指派不传改派原因，已有负责人改派才带原因", () => {
    const fields = { ...emptyActionFields(), staffId: id, reasonCode: "staff_change" };
    expect(actionCommand({ ...ticket, editor: null }, "assign-editor", fields)).toEqual({
      action: "assign-editor",
      body: { staffId: id },
    });
    const editor = { staffId: id } as NonNullable<M5Ticket["editor"]>;
    expect(actionCommand({ ...ticket, editor }, "assign-editor", fields)).toMatchObject({
      body: { staffId: id, reasonCode: "staff_change" },
    });
  });
  it("强迁目标来自正式机器；完整工单号及当前步骤写入confirm，越界目标拒绝", () => {
    expect(forceTargets("sample_confirm")).toEqual(
      expect.arrayContaining(["plan_confirm", "ad_prep", "sample_making"]),
    );
    const fields = {
      ...emptyActionFields(),
      toStep: "plan_confirm",
      note: "已重新核对完整交付方案与商家要求",
    };
    expect(actionCommand(ticket, "force-transition", fields)).toMatchObject({
      body: {
        confirm: { ticketNo: ticket.ticketNo, fromStep: "sample_confirm" },
        toStep: "plan_confirm",
      },
    });
    expect(() =>
      actionCommand(ticket, "force-transition", { ...fields, toStep: "archived" }),
    ).toThrow();
    expect(() => actionCommand(ticket, "force-transition", { ...fields, note: "短" })).toThrow();
  });
  it("代录使用真实样片版次；compose无广告字段，ad_content须广告且可保留毫秒定位和3图", () => {
    const fields = { ...emptyActionFields(), note: "请调整转场和广告文案", feedbackFileIds: [id] };
    expect(actionCommand(ticket, "feedback", fields)).toEqual({
      action: "feedback",
      targetId: ticket.currentSample!.sampleId,
      body: { versionNo: 3, feedbackKind: "compose", note: fields.note, feedbackFileIds: [id] },
    });
    expect(() =>
      actionCommand(ticket, "feedback", { ...fields, feedbackKind: "ad_content" }),
    ).toThrow();
    const feedbackFileIds = [
      id,
      "019aa000-0000-7000-8000-000000000003",
      "019aa000-0000-7000-8000-000000000004",
    ];
    const adContent = actionCommand(ticket, "feedback", {
      ...fields,
      feedbackKind: "ad_content",
      adId: id,
      feedbackTime: "1250",
      feedbackFileIds,
    });
    expect(adContent).toEqual({
      action: "feedback",
      targetId: ticket.currentSample!.sampleId,
      body: {
        versionNo: 3,
        feedbackKind: "ad_content",
        adId: id,
        note: fields.note,
        feedbackTimeMs: 1250,
        feedbackFileIds,
      },
    });
    // The staff endpoint is free-only: a merchant's paid-revision consent is never a legal body field.
    expect(
      AdminSampleRequestChangeBodySchema.safeParse({ ...adContent.body, acceptChargePoints: 1 })
        .success,
    ).toBe(false);
    expect(adContent.body).not.toHaveProperty("acceptChargePoints");
    expect(() => actionCommand(ticket, "feedback", { ...fields, feedbackTime: "-1" })).toThrow();
  });
  it("补发集号唯一、原因必填；补标不得空工具和空说明", () => {
    const fields = {
      ...emptyActionFields(),
      episodes: [1, 1],
      reasonCode: "other",
      note: "重新补发",
    };
    expect(() => actionCommand(ticket, "reissue", fields)).toThrow();
    expect(() => actionCommand(ticket, "restamp", emptyActionFields(), id)).toThrow();
  });
});
