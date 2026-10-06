import { describe, expect, it, vi } from "vitest";
import { bankConflicts, createReceiptIntent, receivedFen } from "./model";
import { ReceiptFailure } from "./api";
const body = {
  lockVersion: 0,
  bankSerialNo: "BANK1",
  confirm: { orderNo: "FK2026100600001", receivedAmountFen: 600000 },
  confirmChecks: ["bank_statement_checked"],
};
describe("到账确认意图", () => {
  it("金额输入空值、零、小数多位非法，元转分精确", () => {
    for (const value of ["", " ", "0", "-1", "6000.001", "NaN"])
      expect(receivedFen(value)).toBeNull();
    expect(receivedFen("6000.01")).toBe(600001);
  });
  it("失败后同请求体沿用键，修改金额/付款行/冲突完整回显换新键，同步双点单飞", async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ paid: true });
    let count = 0;
    const intent = createReceiptIntent("confirm", call, () => `intent-${++count}`);
    await expect(intent.submit(body)).rejects.toThrow("network");
    await intent.submit(body);
    await intent.submit({
      ...body,
      payerBankCode: "bank_b",
      confirm: { ...body.confirm, conflictOrderNos: ["FKOTHER1", "FKOTHER2"] },
    });
    expect(call.mock.calls.map((v) => v[1])).toEqual(["intent-1", "intent-1", "intent-2"]);
    let release!: () => void;
    const slow = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const single = createReceiptIntent("confirm", slow, () => "one-key");
    const first = single.submit(body);
    expect(await single.submit(body)).toBeNull();
    release();
    await first;
    expect(slow).toHaveBeenCalledTimes(1);
  });
  it("仅BANK_SERIAL_DUPLICATE取完整冲突单号，普通错误不开启付款行", () => {
    const failure = {
      symbol: "BANK_SERIAL_DUPLICATE",
      message: "duplicate",
      status: 409,
      requestId: null,
      disposition: "toast" as const,
      body: {
        error: "BANK_SERIAL_DUPLICATE" as const,
        code: 0,
        message: "duplicate",
        requestId: "r",
        details: {
          conflicts: [
            { ref: "FK2026100600001", payerBank: null },
            { ref: "FK2026100600002", payerBank: { code: "bank_a", name: "A银行" } },
          ],
        },
      },
    };
    expect(bankConflicts(new ReceiptFailure(failure))?.map((v) => v.ref)).toEqual([
      "FK2026100600001",
      "FK2026100600002",
    ]);
    expect(
      bankConflicts(new ReceiptFailure({ ...failure, symbol: "VERSION_CONFLICT" })),
    ).toBeNull();
  });
});
