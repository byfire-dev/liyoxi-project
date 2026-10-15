// 十二个接口每个方法一份样例入参。类型照接口推出来：接口加了方法而这里没补，编译失败。
// 用例拿它把全部方法逐个调一遍（未配置实现、外呼前钩子、替身的失败与延迟）。

import { PROVIDER_METHODS, PROVIDER_NAMES } from "../../providers/types.js";
import type {
  ProviderMethodName,
  ProviderName,
  ProviderResult,
  Providers,
} from "../../providers/types.js";

export type ProviderInputs = {
  [K in ProviderName]: {
    [M in ProviderMethodName<Providers[K]>]: NonNullable<Providers[K][M]> extends (
      input: infer I,
    ) => unknown
      ? I
      : never;
  };
};

const SAMPLE_REF = { bucket: "media", key: "incoming/sample/video.mp4" } as const;

export const SAMPLE_PROVIDER_INPUTS: ProviderInputs = {
  wechat: {
    code2Session: { code: "sample-code" },
    getPhoneNumber: { code: "sample-phone-code" },
    sendSubscribeMessage: {
      openid: "sample-openid",
      templateId: "sample-template",
      data: { thing1: "样例" },
    },
    createMiniProgramCode: { scene: "s=1", page: "pages/home/index" },
    checkText: { openid: "sample-openid", scene: "profile", content: "样例称呼" },
    checkImage: {
      openid: "sample-openid",
      scene: "profile",
      mediaUrl: "https://example.invalid/a.jpg",
    },
  },
  wechatPay: {
    signMiniProgramPay: { prepayId: "sample-prepay" },
    createJsapiOrder: {
      outTradeNo: "FK-SAMPLE-0001",
      description: "样例套餐",
      amountFen: 19900,
      payerOpenid: "sample-openid",
    },
    verifyAndDecryptNotification: { headers: {}, rawBody: "{}" },
    queryByOutTradeNo: { outTradeNo: "FK-SAMPLE-0001" },
    closeOrder: { outTradeNo: "FK-SAMPLE-0001" },
    createRefund: {
      outTradeNo: "FK-SAMPLE-0001",
      outRefundNo: "TK-SAMPLE-0001",
      refundFen: 100,
      totalFen: 19900,
    },
    fetchTradeBill: { billDate: "2026-10-01" },
  },
  sms: {
    sendTemplate: {
      phone: "13800138000",
      template: {
        templateKey: "account_notice",
        kind: "notice",
        status: "active",
        providerTemplateId: "1234",
        signName: "样例平台",
        params: [],
      },
      params: {},
    },
    checkBalance: {},
    sendActivationCode: { phone: "13800138000", code: "246810" },
    sendSubscribeFallback: {
      phone: "13800138000",
      templateKey: "order_delivered",
      params: { orderNo: "LYX-SAMPLE-0001" },
    },
    sendOncallAlert: { phones: ["13800138000"], title: "样例告警", content: "worker 租约过期" },
  },
  storage: {
    presignPost: { ...SAMPLE_REF, mime: "video/mp4", maxBytes: 20 * 1024 * 1024, expiresSec: 600 },
    issueSts: { bucket: "media", keyPrefix: "incoming/sample/", durationSec: 900 },
    head: SAMPLE_REF,
    readPrefix: { ...SAMPLE_REF, bytes: 4096 },
    readObject: { ...SAMPLE_REF, maxBytes: 20 * 1024 * 1024 },
    putObject: { ...SAMPLE_REF, body: new Uint8Array([1, 2, 3]), contentType: "application/pdf" },
    copy: {
      src: SAMPLE_REF,
      dst: { bucket: "media", key: "files/sample/video.mp4" },
      ifMatchEtag: '"sample-etag"',
      contentType: "video/mp4",
    },
    presignGet: { ...SAMPLE_REF, expiresSec: 900, disposition: "inline" },
    presignVisionGet: { ...SAMPLE_REF, expiresSec: 900, source: { kind: "image" } },
    delete: SAMPLE_REF,
    restoreVersions: { ...SAMPLE_REF, signal: new AbortController().signal },
    eraseVersions: { ...SAMPLE_REF, signal: new AbortController().signal },
    abortMultipart: SAMPLE_REF,
    readTo: {
      ...SAMPLE_REF,
      expectedSize: 3,
      maxBytes: 3,
      ifMatchEtag: '"sample-etag"',
      signal: new AbortController().signal,
      sink: async () => undefined,
    },
    putStream: {
      ...SAMPLE_REF,
      body: async function* () {
        yield new Uint8Array([1, 2, 3]);
      },
      size: 3,
      sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      contentIdentity: "1".repeat(64),
      contentType: "video/mp4",
      ifAbsent: true,
      signal: new AbortController().signal,
    },
    putBackupStream: {
      key: "daily/2026-10-14.dump.age",
      maxBytes: 3,
      signal: new AbortController().signal,
      body: async function* () {
        yield new Uint8Array([1, 2, 3]);
      },
    },
    headBackup: { key: "daily/2026-10-14.dump.age", signal: new AbortController().signal },
    copyBackup: {
      srcKey: "daily/2026-10-14.dump.age",
      dstKey: "monthly/2026-10-14.dump.age",
      ifMatchEtag: '"sample-etag"',
      signal: new AbortController().signal,
    },
  },
  media: {
    probe: { src: SAMPLE_REF },
    transcode: {
      src: SAMPLE_REF,
      dst: { bucket: "media", key: "files/sample/video-720p.mp4" },
      template: "mp4-720p",
      userData: "sample-job:1",
    },
    pack: {
      bucket: "media",
      items: [{ key: "files/sample/video.mp4", name: "第 1 集.mp4" }],
      dstKey: "files/sample/pack.zip",
      userData: "sample-job:2",
    },
    audit: { src: SAMPLE_REF, scenes: ["porn", "politics"], userData: "sample-job:3" },
    auditText: { bucket: "asset", text: "虚构审核文本", userData: "sample-job:3" },
    auditVideo: { src: SAMPLE_REF, userData: "sample-job:3" },
    describeAudit: { src: SAMPLE_REF, jobId: "fake-audit-1", userData: "sample-job:3" },
    describe: { jobId: "fake-job-1", family: "media" },
    find: {
      family: "media",
      tag: "Transcode",
      userData: "sample-job:3",
      createdAfter: new Date("2026-01-01T00:00:00Z"),
      createdBefore: new Date("2026-01-02T00:00:00Z"),
    },
    cancel: { jobId: "fake-job-1", family: "media" },
  },
  ocr: {
    recognizeBusinessLicense: { imageUrl: "https://example.invalid/license.jpg" },
    extractLicenseFields: {
      fileUrl: "https://example.invalid/permit.jpg",
      fieldNames: ["许可证编号", "有效期至"],
    },
  },
  asr: {
    transcribe: { url: "https://example.invalid/voice.m4a" },
    submit: { url: "https://example.invalid/voice.m4a" },
    query: { taskId: "1" },
  },
  llm: {
    tagAsset: { kind: "image", url: "https://example.invalid/dish.jpg" },
    extractKeyPoints: { text: "招牌菜是酸菜鱼。周末有优惠。门口可以停车。", maxPoints: 3 },
    summarizeAsset: {
      text: "公开虚构样例：门店菜单含牛肉面。",
      vocabulary: {
        content: [{ code: "menu", label: "菜单价目" }],
        usage: [],
        timeliness: [],
      },
    },
    analyzeVision: { imageUrls: ["https://example.invalid/vision.jpg"] },
  },
  wecom: {
    sendRobotMessage: { title: "样例告警", content: "有一项运行事实待处理", mentionAll: false },
    sendAppMessage: {
      toUser: "sample-staff",
      title: "新工单",
      description: "有一张交付工单待处理",
    },
    createContactWay: { userId: "sample-manager", state: "store:sample" },
    verifyAndDecryptCallback: { query: {}, rawBody: "{}" },
    getKfLink: { scene: "order" },
    exchangeWebLoginCode: { code: "fake-web-login-code" },
  },
  esign: { seal: { pdf: new TextEncoder().encode("%PDF-sample") } },
  invoice: { issue: { requestNo: "FP-SAMPLE-0001", title: "样例餐饮店", amountFen: 19900 } },
  mail: { send: { to: "owner@example.invalid", subject: "电子发票", text: "发票见附件。" } },
};

/** 十二个接口的全部方法，一行一个，顺序照 PROVIDER_NAMES 与 PROVIDER_METHODS */
export const ALL_PROVIDER_METHODS: ReadonlyArray<{ provider: ProviderName; method: string }> =
  PROVIDER_NAMES.flatMap((provider) =>
    PROVIDER_METHODS[provider].map((method) => ({ provider, method })),
  );

/** 用样例入参调一个方法 */
export function callWithSample(
  providers: Providers,
  provider: ProviderName,
  method: string,
): Promise<ProviderResult<unknown>> {
  const target = providers[provider] as unknown as Record<
    string,
    ((input: unknown) => Promise<ProviderResult<unknown>>) | undefined
  >;
  const inputs: Record<string, unknown> = SAMPLE_PROVIDER_INPUTS[provider];
  const call = target[method];
  if (typeof call !== "function") throw new Error(`${provider} 没有方法 ${method}`);
  return call.call(target, inputs[method]);
}
