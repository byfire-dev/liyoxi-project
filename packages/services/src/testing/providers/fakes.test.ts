import { describe, expect, it } from "vitest";

import type { ProviderName } from "../../providers/types.js";
import {
  ALL_PROVIDER_METHODS,
  callWithSample,
  createFakeProviders,
  FAKE_CERT_SERIAL,
  tickFakes,
} from "./index.js";
import type { FakeControl } from "./index.js";

// 十二个替身共有的能力（W0-19 任务书 第 10 节第 5 项）：记录调用、可注入失败与延迟、跟随可拨时钟；
// 假存储不依赖 MinIO。假微信支付的编排见 wechat-pay.test.ts，内容安全见 wechat.test.ts。

function manualClock(start = "2026-10-04T02:00:00.000Z") {
  let now = new Date(start).getTime();
  return {
    now: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

function setup() {
  const clock = manualClock();
  const fakes = createFakeProviders({ clock });
  const control = (name: ProviderName) => fakes[name] as FakeControl<string>;
  return { clock, fakes, control };
}

describe("每个方法：记录调用、注入失败、注入延迟", () => {
  it.each(ALL_PROVIDER_METHODS)("$provider 的 $method", async ({ provider, method }) => {
    const { clock, fakes, control } = setup();
    const fake = control(provider);

    // 记录调用：方法名、入参、发生的时刻（替身的时钟）
    await callWithSample(fakes, provider, method);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ method, at: clock.now() });
    expect(fake.calls[0]?.input).toBeDefined();
    expect(fake.callsOf(method)).toHaveLength(1);

    // 注入失败：缺省一次、unavailable；之后恢复
    fake.failNext(method);
    expect(await callWithSample(fakes, provider, method)).toEqual({
      ok: false,
      reason: "unavailable",
      message: "替身注入的失败",
    });
    const recovered = await callWithSample(fakes, provider, method);
    expect(recovered).not.toMatchObject({ message: "替身注入的失败" });

    // 注入失败：指定原因与次数
    fake.failNext(method, { reason: "rejected", message: "外部侧拒绝", times: 2 });
    for (let round = 0; round < 2; round += 1) {
      expect(await callWithSample(fakes, provider, method)).toEqual({
        ok: false,
        reason: "rejected",
        message: "外部侧拒绝",
      });
    }
    expect(fake.calls).toHaveLength(5);

    // 注入延迟：应答压着，拨动时钟到点、tick() 之后才返回
    fake.delayNext(method, 3_000);
    let settled = false;
    const pending = callWithSample(fakes, provider, method).finally(() => {
      settled = true;
    });
    expect(fake.pendingCalls()).toBe(1);
    clock.advance(2_999);
    expect(fake.tick()).toBe(0);
    await Promise.resolve();
    expect(settled).toBe(false);
    clock.advance(1);
    expect(tickFakes(fakes)).toBe(1);
    await pending;
    expect(settled).toBe(true);
    expect(fake.pendingCalls()).toBe(0);
    expect(fake.calls).toHaveLength(6);

    // 清空记录
    fake.failNext(method);
    fake.resetCalls();
    expect(fake.calls).toEqual([]);
    expect(await callWithSample(fakes, provider, method)).not.toMatchObject({
      message: "替身注入的失败",
    });
  });

  it("延迟与失败叠在一起：失败的应答也晚到", async () => {
    const { clock, fakes } = setup();
    fakes.sms.delayNext("sendActivationCode", 1_000);
    fakes.sms.failNext("sendActivationCode");
    const pending = fakes.sms.sendActivationCode({ phone: "13800138000", code: "1" });
    clock.advance(1_000);
    fakes.sms.tick();
    expect(await pending).toMatchObject({ ok: false, reason: "unavailable" });
    expect(fakes.sms.sent).toEqual([]);
  });

  it("十二个替身共用一个时钟：调用时刻跟着拨", async () => {
    const { clock, fakes } = setup();
    await fakes.mail.send({ to: "a@example.invalid", subject: "s", text: "t" });
    clock.advance(60_000);
    await fakes.asr.transcribe({ url: "u" });
    expect(fakes.mail.calls[0]?.at.toISOString()).toBe("2026-10-04T02:00:00.000Z");
    expect(fakes.asr.calls[0]?.at.toISOString()).toBe("2026-10-04T02:01:00.000Z");
  });

  it("不给时钟就用系统时间", async () => {
    const fakes = createFakeProviders();
    const before = Date.now();
    await fakes.asr.transcribe({ url: "u" });
    expect(fakes.asr.calls[0]?.at.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("假存储：不依赖 MinIO，行为照本地驱动", () => {
  const body = new TextEncoder().encode("成片第 1 集");
  const post = {
    bucket: "media",
    key: "incoming/u1/ep1.mp4",
    mime: "video/mp4",
    maxBytes: 1024,
    expiresSec: 600,
  } as const;

  it("表单直传到 incoming/ → 读对象头 → 条件复制到正式区 → 签发读地址 → 删除", async () => {
    const { fakes } = setup();
    const { storage } = fakes;

    const signed = await storage.presignPost(post);
    if (!signed.ok) throw new Error(signed.message);
    expect(storage.upload(signed.value, body)).toBe(204);

    const head = await storage.head({ bucket: "media", key: post.key });
    expect(head).toMatchObject({
      ok: true,
      value: { exists: true, size: body.byteLength, mime: "video/mp4" },
    });
    if (!head.ok || head.value.etag === undefined) throw new Error("没读到 etag");

    const dst = { bucket: "media", key: "files/f1/ep1.mp4" } as const;
    expect(
      await storage.copy({
        src: { bucket: "media", key: post.key },
        dst,
        ifMatchEtag: head.value.etag,
        contentType: "video/mp4",
        contentDisposition: "inline",
      }),
    ).toEqual({ ok: true, value: { etag: head.value.etag } });

    const read = await storage.presignGet({ ...dst, expiresSec: 900, downloadName: "第 1 集.mp4" });
    if (!read.ok) throw new Error(read.message);
    expect(storage.fetch(read.value.url)).toEqual({
      status: 200,
      body,
      mime: "video/mp4",
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent("第 1 集.mp4")}`,
    });

    expect(await storage.delete(dst)).toEqual({ ok: true, value: undefined });
    expect(await storage.head(dst)).toEqual({ ok: true, value: { exists: false, size: 0 } });
    expect(storage.fetch(read.value.url)).toEqual({ status: 404 });
    expect(await storage.delete(dst)).toEqual({ ok: true, value: undefined });
  });

  it("四个桶互不相干", async () => {
    const { fakes } = setup();
    for (const bucket of ["secure", "asset", "media", "pub"] as const) {
      fakes.storage.put(
        { bucket, key: "files/same-key" },
        new TextEncoder().encode(bucket),
        "text/plain",
      );
    }
    expect(fakes.storage.objects.size).toBe(4);
    for (const bucket of ["secure", "asset", "media", "pub"] as const) {
      const read = await fakes.storage.presignGet({
        bucket,
        key: "files/same-key",
        expiresSec: 60,
      });
      if (!read.ok) throw new Error(read.message);
      const fetched = fakes.storage.fetch(read.value.url);
      expect(fetched.status === 200 && new TextDecoder().decode(fetched.body)).toBe(bucket);
    }
  });

  it("直传只能落在写入区；超过大小、内容类型被改、表单过期都传不上", async () => {
    const { clock, fakes } = setup();
    const { storage } = fakes;
    expect(await storage.presignPost({ ...post, key: "files/direct.mp4" })).toMatchObject({
      ok: false,
      reason: "rejected",
    });

    const signed = await storage.presignPost(post);
    if (!signed.ok) throw new Error(signed.message);
    expect(storage.upload(signed.value, new Uint8Array(2048))).toBe(400);
    expect(
      storage.upload(
        { ...signed.value, fields: { ...signed.value.fields, "Content-Type": "text/html" } },
        body,
      ),
    ).toBe(403);
    expect(
      storage.upload(
        { ...signed.value, fields: { ...signed.value.fields, key: "incoming/other" } },
        body,
      ),
    ).toBe(403);
    expect(storage.upload({ ...signed.value, fields: { key: post.key } }, body)).toBe(403);
    clock.advance(600_001);
    expect(storage.upload(signed.value, body)).toBe(403);
    expect(storage.objects.size).toBe(0);
  });

  it("条件复制：源不存在、etag 对不上都不复制", async () => {
    const { fakes } = setup();
    const { storage } = fakes;
    const src = { bucket: "asset", key: "incoming/a" } as const;
    const dst = { bucket: "asset", key: "files/a" } as const;
    const copy = { src, dst, contentType: "image/png" };
    expect(await storage.copy({ ...copy, ifMatchEtag: '"x"' })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    const etag = storage.put(src, body, "application/octet-stream");
    expect(await storage.copy({ ...copy, ifMatchEtag: '"x"' })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(await storage.copy({ ...copy, ifMatchEtag: etag })).toMatchObject({ ok: true });
    expect(await storage.head(dst)).toMatchObject({ ok: true, value: { mime: "image/png" } });
  });

  it("读地址过期后访问被拒：按替身的时钟判", async () => {
    const { clock, fakes } = setup();
    const { storage } = fakes;
    const ref = { bucket: "secure", key: "files/license.pdf" } as const;
    storage.put(ref, body, "application/pdf");
    const read = await storage.presignGet({ ...ref, expiresSec: 300 });
    if (!read.ok) throw new Error(read.message);
    expect(read.value.expiresAt.toISOString()).toBe("2026-10-04T02:05:00.000Z");
    clock.advance(300_000);
    expect(storage.fetch(read.value.url).status).toBe(200);
    clock.advance(1);
    expect(storage.fetch(read.value.url)).toEqual({ status: 403 });
    expect(storage.fetch("https://fake-storage.invalid/secure/files/license.pdf")).toEqual({
      status: 403,
    });
  });

  it("临时密钥：缺省能签发；关掉能力后返回 unsupported", async () => {
    const { fakes } = setup();
    const input = { bucket: "media", keyPrefix: "incoming/u1/", durationSec: 900 } as const;
    const issued = await fakes.storage.issueSts(input);
    expect(issued).toMatchObject({
      ok: true,
      value: { expiresAt: new Date("2026-10-04T02:15:00.000Z") },
    });
    fakes.storage.capabilities.sts = false;
    expect(await fakes.storage.issueSts(input)).toMatchObject({ ok: false, reason: "unsupported" });
  });
});

describe("其余替身各自的预置与记录", () => {
  it("sms：记下发出的短信，能取回最后一个激活码", async () => {
    const { fakes } = setup();
    await fakes.sms.sendActivationCode({ phone: "13800138000", code: "111111" });
    await fakes.sms.sendActivationCode({ phone: "13800138000", code: "222222" });
    await fakes.sms.sendSubscribeFallback({
      phone: "13900139000",
      templateKey: "k",
      params: { a: "1" },
    });
    await fakes.sms.sendOncallAlert({
      phones: ["13700137000"],
      title: "告警",
      content: "租约过期",
    });
    expect(fakes.sms.sent.map((message) => message.kind)).toEqual([
      "activation_code",
      "activation_code",
      "subscribe_fallback",
      "oncall_alert",
    ]);
    expect(fakes.sms.lastActivationCode("13800138000")).toBe("222222");
    expect(fakes.sms.lastActivationCode("13900139000")).toBeUndefined();
  });

  it("media：体检给预置的报告，没预置的给缺省报告；转码、打包直接完成", async () => {
    const { fakes } = setup();
    const src = { bucket: "media", key: "incoming/a.mp4" } as const;
    expect(await fakes.media.probe({ src })).toEqual({
      ok: true,
      value: { processed: true, report: fakes.media.defaultReport },
    });
    const landscape = { ...fakes.media.defaultReport, width: 1920, height: 1080 };
    fakes.media.reports.set("media/incoming/a.mp4", landscape);
    expect(await fakes.media.probe({ src })).toEqual({
      ok: true,
      value: { processed: true, report: landscape },
    });
    const dst = { bucket: "media", key: "files/a-wm.mp4" } as const;
    expect(
      await fakes.media.transcode({ src, dst, template: "watermark", userData: "job:1" }),
    ).toEqual({
      ok: true,
      value: { jobId: "fake-transcode-1", state: "done", processed: true },
    });
    expect(
      await fakes.media.pack({
        bucket: "media",
        items: [{ key: dst.key, name: "1.mp4" }],
        dstKey: "files/p.zip",
        userData: "job:2",
      }),
    ).toEqual({ ok: true, value: { jobId: "fake-pack-2", state: "done", processed: true } });
    expect(fakes.media.jobs.map((job) => [job.kind, job.userData])).toEqual([
      ["transcode", "job:1"],
      ["pack", "job:2"],
    ]);
  });

  it("ocr：营业执照与许可证字段按预置给，没预置的给样例", async () => {
    const { fakes } = setup();
    expect(await fakes.ocr.recognizeBusinessLicense({ imageUrl: "u1" })).toEqual({
      ok: true,
      value: fakes.ocr.defaultLicense,
    });
    fakes.ocr.licenses.set("u2", {
      name: "某面馆",
      uscc: "X",
      principal: "李四",
      warnings: ["翻拍"],
    });
    expect(await fakes.ocr.recognizeBusinessLicense({ imageUrl: "u2" })).toMatchObject({
      ok: true,
      value: { name: "某面馆", warnings: ["翻拍"] },
    });
    fakes.ocr.licenseFields.set("f1", { 许可证编号: "JY123" });
    expect(
      await fakes.ocr.extractLicenseFields({
        fileUrl: "f1",
        fieldNames: ["许可证编号", "有效期至"],
      }),
    ).toEqual({
      ok: true,
      value: { fields: { 许可证编号: "JY123", 有效期至: "样例有效期至" } },
    });
  });

  it("asr 与 llm：预置的先用，用完了给样例", async () => {
    const { fakes } = setup();
    fakes.asr.transcripts.set("u1", "老板说今天有活动。");
    expect(await fakes.asr.transcribe({ url: "u1" })).toMatchObject({
      ok: true,
      value: { text: "老板说今天有活动。" },
    });
    expect(await fakes.asr.transcribe({ url: "u2" })).toMatchObject({
      ok: true,
      value: { text: "这是替身给的转写文本。" },
    });

    fakes.llm.tagReplies.push({ description: "一碗牛肉面", tags: ["菜品", "面食"] });
    expect(await fakes.llm.tagAsset({ kind: "image", url: "u" })).toEqual({
      ok: true,
      value: { description: "一碗牛肉面", tags: ["菜品", "面食"] },
    });
    expect(await fakes.llm.tagAsset({ kind: "audio", text: "t" })).toEqual({
      ok: true,
      value: { description: "样例素材", tags: ["audio"] },
    });
    fakes.llm.keyPointReplies.push(["招牌是牛肉面"]);
    expect(await fakes.llm.extractKeyPoints({ text: "随便" })).toEqual({
      ok: true,
      value: { points: ["招牌是牛肉面"] },
    });
    expect(await fakes.llm.extractKeyPoints({ text: "一。二。三。四。", maxPoints: 2 })).toEqual({
      ok: true,
      value: { points: ["一", "二"] },
    });
  });

  it("wecom：记下应用消息与“联系我”二维码；加好友回调能造能解，被改过的验签不过", async () => {
    const { fakes } = setup();
    await fakes.wecom.sendAppMessage({ toUser: "staff-1", title: "新工单", description: "待处理" });
    expect(fakes.wecom.messages).toEqual([
      { toUser: "staff-1", title: "新工单", description: "待处理" },
    ]);
    expect(await fakes.wecom.createContactWay({ userId: "manager-1", state: "store:1" })).toEqual({
      ok: true,
      value: {
        configId: "fake-contact-way-1",
        qrCodeUrl: "https://fake-wecom.invalid/qr/fake-contact-way-1",
      },
    });
    expect(fakes.wecom.contactWays).toHaveLength(1);

    const event = {
      kind: "contact_added",
      userId: "manager-1",
      externalUserId: "ext-1",
      state: "store:1",
    } as const;
    const callback = fakes.wecom.encodeCallback(event);
    expect(await fakes.wecom.verifyAndDecryptCallback(callback)).toEqual({
      ok: true,
      value: event,
    });
    expect(
      await fakes.wecom.verifyAndDecryptCallback({
        ...callback,
        rawBody: callback.rawBody.replace("ext-1", "ext-2"),
      }),
    ).toEqual({ ok: false, reason: "rejected", message: "验签失败" });
    expect(await fakes.wecom.getKfLink({ scene: "order" })).toEqual({
      ok: true,
      value: { url: "https://fake-wecom.invalid/kf?scene=order" },
    });
  });

  it("esign：按带数字签名的样子返回，签署时刻取替身的时钟", async () => {
    const { clock, fakes } = setup();
    const pdf = new TextEncoder().encode("%PDF-授权书");
    expect(await fakes.esign.seal({ pdf })).toEqual({
      ok: true,
      value: { pdf, mode: "certificate", certSerial: FAKE_CERT_SERIAL, signedAt: clock.now() },
    });
    expect(fakes.esign.sealed).toEqual([pdf]);
  });

  it("mail 与 invoice：发件箱；同一申请单号重复开票给同一个发票号", async () => {
    const { fakes } = setup();
    const attachment = {
      filename: "发票.pdf",
      contentType: "application/pdf",
      content: new Uint8Array([1]),
    };
    expect(
      await fakes.mail.send({
        to: "a@example.invalid",
        subject: "电子发票",
        text: "见附件",
        attachments: [attachment],
      }),
    ).toEqual({ ok: true, value: { messageId: "fake-mail-1" } });
    expect(fakes.mail.outbox).toEqual([
      {
        messageId: "fake-mail-1",
        to: "a@example.invalid",
        subject: "电子发票",
        text: "见附件",
        attachments: [attachment],
      },
    ]);

    const request = { requestNo: "FP-1", title: "某面馆", amountFen: 19900 };
    const first = await fakes.invoice.issue(request);
    expect(first).toEqual({ ok: true, value: { invoiceNo: "FAKE-INV-000001" } });
    expect(await fakes.invoice.issue(request)).toEqual(first);
    expect(await fakes.invoice.issue({ ...request, requestNo: "FP-2" })).toEqual({
      ok: true,
      value: { invoiceNo: "FAKE-INV-000002" },
    });
    expect(fakes.invoice.issued.size).toBe(2);
  });
});
