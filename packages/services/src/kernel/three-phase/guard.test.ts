import { describe, expect, it } from "vitest";

import { createFakeProviders, samplePrepay } from "../../testing/index.js";
import { createTxRunner, KernelViolation } from "../tx.js";
import { createDocumentConverter } from "../../index.js";
import { attemptOf, SLOW, useThreePhase } from "./__fixtures__/harness.js";
import { guardProviderCall } from "./three-phase.js";

// 验收第 7 条：在事务回调里执行外呼步骤即抛错（W0-07 的“在事务中”标记），替身没被调用。
// 三处都拦：事务里直接调 Provider；在 claim、settle 里调 Provider；在事务里跑整个三段式用例。

const h = useThreePhase();

const input = (no: string) => ({ outTradeNo: no, amountFen: 100, payerOpenid: "o-sample" });
const violation = { name: "KernelViolation", kind: "external_call_in_transaction" };

describe("三段式：事务内外呼（验收 7）", () => {
  it("事务内转换在 admission 前拒绝，真实事务不读取文件或启动 CPU worker", async () => {
    const converter = createDocumentConverter({
      workerUrl: new URL("file:///unused-document-worker.js"),
    });
    let reads = 0;
    try {
      await expect(
        h.tx.run(() =>
          converter.convert({
            load: async () => {
              reads++;
              return { sourceBytes: null, pdfBytes: null };
            },
          }),
        ),
      ).rejects.toMatchObject({
        ...violation,
        message: expect.stringContaining("document conversion"),
      });
      expect(reads).toBe(0);
    } finally {
      await converter.close();
    }
  });

  it("事务内完整对象读取被入口钩子阻断；事务外读取有限字节", async () => {
    const { storage } = createFakeProviders({ beforeCall: guardProviderCall });
    const ref = { bucket: "secure", key: "files/guard/document.pdf" } as const;
    const bytes = new Uint8Array([1, 2, 3]);
    const etag = storage.put(ref, bytes, "application/pdf");
    const input = { ...ref, maxBytes: bytes.length, ifMatchEtag: etag };
    await expect(h.tx.run(() => storage.readObject(input))).rejects.toMatchObject({
      ...violation,
      message: expect.stringContaining("storage.readObject"),
    });
    expect(storage.callsOf("readObject")).toEqual([]);
    expect(await storage.readObject(input)).toEqual({ ok: true, value: bytes });
    expect(storage.callsOf("readObject")).toHaveLength(1);
  });

  it(
    "事务回调里调 Provider：外呼前钩子抛错，替身一次调用都没记到，事务回滚；事务外照常",
    async () => {
      const attempt = attemptOf("guard-direct");
      const inside = h.tx.run(async (handle) => {
        await handle.$executeRaw`
          INSERT INTO lyx_sample_prepay (out_trade_no, status) VALUES (${attempt.no}, 'pending')`;
        return h.wechatPay.createJsapiOrder({ ...input(attempt.no), description: "事务里外呼" });
      });
      await expect(inside).rejects.toBeInstanceOf(KernelViolation);
      await expect(inside).rejects.toMatchObject({
        ...violation,
        message: expect.stringContaining("wechatPay.createJsapiOrder"),
      });
      expect(h.wechatPay.calls).toEqual([]);
      expect(await h.row(attempt.no)).toBeUndefined();

      const outside = await h.wechatPay.createJsapiOrder({
        ...input(attempt.no),
        description: "事务外",
      });
      expect(outside.ok).toBe(true);
      expect(h.calls(attempt.no)).toBe(1);
    },
    SLOW,
  );

  it(
    "在 claim、settle 里调 Provider：同样抛错；settle 里抛的不算业务失败，占用留着、不补偿",
    async () => {
      const inClaim = attemptOf("guard-claim");
      const calls = h.wechatPay.calls.length;
      const base = (no: string) =>
        samplePrepay("local_first", { wechatPay: h.wechatPay }, input(no));
      const claimRun = h.threePhase.run(
        {
          ...base(inClaim.no),
          claim: async () => {
            await h.wechatPay.queryByOutTradeNo({ outTradeNo: inClaim.no });
            return undefined;
          },
        },
        { idem: h.request(inClaim) },
      );
      await expect(claimRun).rejects.toMatchObject(violation);
      expect(await h.idemRow(inClaim)).toBeNull();

      const inSettle = attemptOf("guard-settle");
      const settleRun = h.threePhase.run(
        {
          ...base(inSettle.no),
          settle: async () => {
            await h.wechatPay.closeOrder({ outTradeNo: inSettle.no });
            throw new Error("到不了这里");
          },
        },
        { idem: h.request(inSettle) },
      );
      await expect(settleRun).rejects.toMatchObject(violation);
      // external 是在事务外正常调的那一次；事务里的两次都没到替身
      expect(h.wechatPay.calls.slice(calls).map((call) => call.method)).toEqual([
        "createJsapiOrder",
      ]);
      expect(await h.row(inSettle.no)).toMatchObject({ status: "pending", settled: 0 });
      expect(await h.idemRow(inSettle)).toMatchObject({ state: "in_progress" });
    },
    SLOW,
  );

  it(
    "在事务里跑整个三段式用例：进门即抛错，不占用、不外呼",
    async () => {
      const attempt = attemptOf("guard-nested");
      const calls = h.wechatPay.calls.length;
      const nested = h.tx.run(() => h.send("external_first", attempt));
      await expect(nested).rejects.toMatchObject(violation);
      // 幂等为 none、没有 claim 的用例第一步就是外呼：也拦得住
      const bare = h.tx.run(() =>
        h.threePhase.run(
          samplePrepay("external_first", { wechatPay: h.wechatPay }, input(attempt.no)),
        ),
      );
      await expect(bare).rejects.toMatchObject(violation);
      expect(h.wechatPay.calls).toHaveLength(calls);
      expect(await h.idemRow(attempt)).toBeNull();
    },
    SLOW,
  );

  it("stg、prod：钩子只上报、不拦，调用照常进行（D7 第 2.3 节规则 5）", async () => {
    const reported: KernelViolation[] = [];
    const prod = createTxRunner({
      prisma: h.prisma,
      appEnv: "prod",
      report: (found) => reported.push(found),
    });
    const { wechatPay } = createFakeProviders({ beforeCall: guardProviderCall });
    const answered = await prod.run(() => wechatPay.queryByOutTradeNo({ outTradeNo: "S-none" }));
    expect(answered.ok).toBe(false);
    expect(wechatPay.calls).toHaveLength(1);
    expect(reported.map((found) => found.kind)).toEqual(["external_call_in_transaction"]);
  });
});
