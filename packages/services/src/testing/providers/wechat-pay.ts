// 假微信支付：内存里的订单与退款，加一个回调编排器（D7 第 10.1 节；W0-19 任务书 第 7 节第 7 条）。
//
// 能编排的五样：
//   延迟      pay(单号, { delayMs })：通知晚到。拨动时钟后 deliverDue() 才投
//   重复      pay(单号, { copies })：同一条通知（编号相同）投几次
//   乱序      queue 就是待投的队列，按数组顺序投；reorder() 改它的顺序，缺省倒过来
//   失败      接口调用失败用 failNext()；回调处理器应答失败（返回 false 或抛错）时，
//             这条通知隔 retryDelayMs 重投，最多投 maxAttempts 次
//   查单结果  setQueryResult(单号, 结果)：之后查这个单号都返回它
// 预下单幂等于商户单号、退款幂等于退款单号：同号、同样的入参重复调用返回同一个结果，只生效一次。
// 通知的请求头与请求体缺省是替身自己的格式（签名是摘要，不是真实的验签）。
//
// X-04 扩的两样（缺省都不生效，原有的行为不变）：
//   真实结构  useWireFormat()：之后发出的通知是微信支付 APIv3 的真实结构：四个请求头、RSA-SHA256 签名、
//             资源用 AEAD_AES_256_GCM 加密。密钥是替身现场生成的测试密钥；返回的材料（公钥、公钥 ID、
//             APIv3 密钥）交给被测的真实驱动去验签解密。同一条通知重复投递时通知 id 与请求体不变，
//             每次投递重新取时间戳、随机串并重新签名（官方文档 4013053420 第 2.1 节）。
//             encode(通知, { probe: true }) 造一条签名探测流量。
//   应答超时  loseResponseNext(方法)：外部侧已经处理（改动照常生效），但应答丢了，调用方拿到 unavailable。
// 本文件不引真实驱动：签名与加密是照官方文档另写的一份，好让替身与驱动互相印证。

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

import {
  createWechatPayNotificationCrypto,
  createVerifiedTradeBill,
} from "../../providers/index.js";
import { failed, ok } from "../../providers/types.js";
import type {
  ProviderFailure,
  ProviderMethodName,
  ProviderResult,
  VerifiedTradeBillResult,
  WechatPayNotification,
  WechatPayProvider,
  WechatPayRefund,
  WechatPayRefundStatus,
  WechatPayTradeState,
  WechatPayTransaction,
} from "../../providers/types.js";
import { createFakeCore, systemClock } from "./base.js";
import type { FakeClock, FakeControl } from "./base.js";

type Method = ProviderMethodName<WechatPayProvider>;

export interface FakeWechatPayOrder {
  appid: string;
  mchid: string;
  outTradeNo: string;
  prepayId: string;
  description: string;
  amountFen: number;
  payerOpenid: string;
  attach?: string;
  expireAt?: Date;
  tradeState: WechatPayTradeState;
  transactionId?: string;
  successAt?: Date;
}

export interface NotificationPlan {
  /** 晚多少毫秒投（按替身的时钟）。缺省 0：下一次 deliverDue() 就投 */
  delayMs?: number;
  /** 同一条通知一共投几次。缺省 1 */
  copies?: number;
}

export interface QueuedNotification {
  notification: WechatPayNotification;
  dueAt: Date;
  /** 第几次投这条通知，从 1 起 */
  attempt: number;
}

/** 交给回调处理器的一次投递：处理器照真实回调那样，先拿 headers 与 rawBody 去验签解密 */
export interface FakeWechatPayDelivery {
  headers: Record<string, string>;
  rawBody: string;
  attempt: number;
}

/** 回调处理器。返回 false 或抛错表示应答失败，替身会重投；其余都算应答成功 */
export type FakeNotificationHandler = (
  delivery: FakeWechatPayDelivery,
) => boolean | void | Promise<boolean | void>;

export interface FakeDeliveryRecord {
  notification: WechatPayNotification;
  attempt: number;
  at: Date;
  acknowledged: boolean;
}

/** 真实结构的材料：被测的驱动拿它配验签身份与 APIv3 密钥。都是测试值 */
export interface FakeWechatPayWire {
  /** 替身扮演的微信支付公钥 ID */
  serial: string;
  publicKeyPem: string;
  apiV3Key: string;
  mchid: string;
  appid: string;
}

export interface FakeWechatPayWireOptions {
  serial?: string;
  /** 32 个字节 */
  apiV3Key?: string;
  mchid?: string;
  appid?: string;
  /** 签通知用的密钥对；不给现场生成一对。大量造替身的用例可以共用一对，省掉生成密钥的时间 */
  keyPair?: { privateKey: KeyObject; publicKeyPem: string };
}

export interface FakeWechatPay extends WechatPayProvider, FakeControl<Method> {
  readonly orders: Map<string, FakeWechatPayOrder>;
  readonly refunds: Map<string, WechatPayRefund>;
  /** 配置一份出账后冻结的官方格式样本；null模拟可信账单不存在。旧展示口不受影响。 */
  setTradeBill(billDate: string, body: string | null): void;
  /** 待投的通知，deliverDue() 按数组顺序投到点的。可以直接改它来造乱序 */
  readonly queue: QueuedNotification[];
  /** 投出去的记录，按投递的先后 */
  readonly deliveries: FakeDeliveryRecord[];
  /** 处理器应答失败后隔多久重投。缺省 15 秒 */
  retryDelayMs: number;
  /** 一条通知最多投几次（含第一次）。缺省 5 */
  maxAttempts: number;
  /** 登记回调处理器。没登记时 deliverDue() 只记投递记录，算应答成功 */
  onNotification(handler: FakeNotificationHandler): void;
  /** 模拟用户付款成功：订单置为 SUCCESS，并按 plan 排一条支付成功通知。返回这条通知 */
  pay(outTradeNo: string, plan?: NotificationPlan): WechatPayNotification;
  /** 模拟退款有了结果（缺省 SUCCESS），并按 plan 排一条退款通知。返回这条通知 */
  completeRefund(
    outRefundNo: string,
    plan?: NotificationPlan & { status?: WechatPayRefundStatus },
  ): WechatPayNotification;
  /** 直接排一条通知，不改订单与退款的状态：造迟到的、与当前状态对不上的通知 */
  enqueue(notification: WechatPayNotification, plan?: NotificationPlan): void;
  /** 改待投队列的顺序。不给参数就整个倒过来 */
  reorder(order?: (queue: QueuedNotification[]) => QueuedNotification[]): void;
  /** 指定查单结果：之后查这个单号都返回它；给 null 取消 */
  setQueryResult(outTradeNo: string, result: WechatPayTransaction | ProviderFailure | null): void;
  /** 把到点的通知按队列顺序投给处理器，返回投了几次 */
  deliverDue(): Promise<number>;
  /** 把一条通知编成回调请求（请求头带替身的签名）。造被篡改的回调时用。probe：造一条签名探测流量 */
  encode(
    notification: WechatPayNotification,
    options?: { probe?: boolean },
  ): { headers: Record<string, string>; rawBody: string };
  /** 切到真实结构：之后发出的通知带真实的请求头、签名与密文。返回验签解密要用的材料 */
  useWireFormat(options?: FakeWechatPayWireOptions): FakeWechatPayWire;
  /** 真实结构的材料；没切过是 null */
  readonly wire: FakeWechatPayWire | null;
  /** 让某个方法接下来的调用“成功但应答超时”：改动照常生效，调用方拿到 unavailable。缺省一次 */
  loseResponseNext(method: Method, options?: { times?: number }): void;
}

const SIGNATURE_TYPE = "WECHATPAY2-SHA256-RSA2048";
const PROBE_PREFIX = "WECHATPAY/SIGNTEST/";

/** 时刻 → RFC 3339，写成北京时间（微信的时间字段只到秒） */
function rfc3339(at: Date): string {
  return `${new Date(at.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19)}+08:00`;
}

/** AEAD_AES_256_GCM 加密：密文后面跟 16 字节的认证标签，整体 base64 */
function seal(key: string, plaintext: string, nonce: string, associatedData: string): string {
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]).toString("base64");
}

/** 上面的逆运算；解不开抛错 */
function open(key: string, ciphertext: string, nonce: string, associatedData: string): string {
  const bytes = Buffer.from(ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(nonce));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  decipher.setAAD(Buffer.from(associatedData));
  const head = decipher.update(bytes.subarray(0, bytes.length - 16));
  return Buffer.concat([head, decipher.final()]).toString("utf8");
}

/** 真实结构里解密后的资源 → 通知。字段照官方文档 4012791902（支付）、4012791906（退款） */
function fromWire(
  id: string,
  eventType: string,
  r: Record<string, unknown>,
): WechatPayNotification {
  const amount = (r.amount ?? {}) as { total?: number; refund?: number };
  if (eventType.startsWith("REFUND.")) {
    const refund = {
      outRefundNo: r.out_refund_no,
      outTradeNo: r.out_trade_no,
      refundId: r.refund_id,
      status: r.refund_status,
      refundFen: amount.refund,
      ...(typeof r.success_time === "string" ? { successAt: new Date(r.success_time) } : {}),
    };
    return { kind: "refund", id, refund: refund as WechatPayRefund };
  }
  const transaction = {
    appid: r.appid,
    mchid: r.mchid,
    outTradeNo: r.out_trade_no,
    tradeState: r.trade_state,
    transactionId: r.transaction_id,
    amountFen: amount.total,
    payerOpenid: (r.payer as { openid?: string } | undefined)?.openid,
    attach: r.attach,
    bankType: typeof r.bank_type === "string" && r.bank_type !== "" ? r.bank_type : undefined,
    successAt: typeof r.success_time === "string" ? new Date(r.success_time) : undefined,
  };
  return { kind: "transaction", id, transaction: transaction as WechatPayTransaction };
}

const SERIAL = "FAKE_PUB_KEY_ID";

function signatureOf(timestamp: string, nonce: string, rawBody: string): string {
  return createHash("sha256")
    .update(`fake-wechatpay\n${timestamp}\n${nonce}\n${rawBody}\n`)
    .digest("hex");
}

/** 北京时间的日期，YYYY-MM-DD */
function beijingDate(at: Date): string {
  return new Date(at.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function transactionOf(order: FakeWechatPayOrder): WechatPayTransaction {
  return {
    appid: order.appid,
    mchid: order.mchid,
    outTradeNo: order.outTradeNo,
    tradeState: order.tradeState,
    transactionId: order.transactionId,
    amountFen: order.amountFen,
    payerOpenid: order.payerOpenid,
    attach: order.attach,
    bankType: "OTHERS",
    successAt: order.successAt,
  };
}

/** 回调请求体里的日期是字符串，解出来要变回 Date */
function reviveNotification(parsed: WechatPayNotification): WechatPayNotification {
  if (parsed.kind !== "transaction" || parsed.transaction.successAt === undefined) return parsed;
  return {
    ...parsed,
    transaction: { ...parsed.transaction, successAt: new Date(parsed.transaction.successAt) },
  };
}

export function createFakeWechatPay(options: { clock?: FakeClock } = {}): FakeWechatPay {
  const clock = options.clock ?? systemClock;
  const core = createFakeCore<Method>(clock);
  const orders = new Map<string, FakeWechatPayOrder>();
  const refunds = new Map<string, WechatPayRefund>();
  const tradeBills = new Map<string, string | null>();
  const queue: QueuedNotification[] = [];
  const deliveries: FakeDeliveryRecord[] = [];
  const queryResults = new Map<string, WechatPayTransaction | ProviderFailure>();
  let handler: FakeNotificationHandler | null = null;
  let seq = 0;
  const next = (prefix: string) => `${prefix}-${String((seq += 1)).padStart(6, "0")}`;
  let wire: (FakeWechatPayWire & { privateKey: KeyObject; publicKey: KeyObject }) | null = null;
  /** 真实结构的请求体，按通知对象记：同一条通知重复投递、重投时请求体不变 */
  const wireBodies = new WeakMap<WechatPayNotification, string>();
  const lostResponses = new Map<Method, number>();

  /** 每个方法的入口：在底座的记录、失败、延迟之外，再套上“成功但应答超时” */
  function run<T>(
    method: Method,
    input: unknown,
    action: () => ProviderResult<T>,
  ): Promise<ProviderResult<T>> {
    return core.run(method, input, () => {
      const result = action();
      const left = lostResponses.get(method) ?? 0;
      if (left === 0) return result;
      lostResponses.set(method, left - 1);
      return failed("unavailable", "替身注入：外部侧已处理，应答超时");
    });
  }

  /** 真实结构的请求体：外层照官方文档 4012791902，资源加密 */
  function wireBody(material: FakeWechatPayWire, notification: WechatPayNotification): string {
    const cached = wireBodies.get(notification);
    if (cached !== undefined) return cached;
    let eventType = "TRANSACTION.SUCCESS";
    let resource: Record<string, unknown>;
    if (notification.kind === "transaction") {
      const { transaction } = notification;
      resource = {
        mchid: material.mchid,
        appid: material.appid,
        out_trade_no: transaction.outTradeNo,
        transaction_id: transaction.transactionId,
        trade_type: "JSAPI",
        trade_state: transaction.tradeState,
        trade_state_desc: "支付成功",
        bank_type: "OTHERS",
        attach: transaction.attach,
        success_time: transaction.successAt && rfc3339(transaction.successAt),
        payer: { openid: transaction.payerOpenid },
        amount: {
          total: transaction.amountFen,
          payer_total: transaction.amountFen,
          currency: "CNY",
          payer_currency: "CNY",
        },
      };
    } else {
      const { refund } = notification;
      if (refund.status === "PROCESSING") {
        throw new Error("假微信支付：真实的退款通知只有成功、异常、关闭三种，没有处理中");
      }
      eventType = `REFUND.${refund.status}`;
      const order = orders.get(refund.outTradeNo);
      const total = order?.amountFen ?? refund.refundFen;
      resource = {
        mchid: material.mchid,
        out_trade_no: refund.outTradeNo,
        transaction_id: order?.transactionId ?? "fake-txn-unknown",
        out_refund_no: refund.outRefundNo,
        refund_id: refund.refundId,
        refund_status: refund.status,
        success_time: refund.status === "SUCCESS" ? rfc3339(clock.now()) : undefined,
        user_received_account: "支付用户零钱",
        amount: {
          total,
          refund: refund.refundFen,
          payer_total: total,
          payer_refund: refund.refundFen,
        },
      };
    }
    const originalType = notification.kind;
    const nonce = randomBytes(6).toString("hex");
    const body = JSON.stringify({
      id: notification.id,
      create_time: rfc3339(clock.now()),
      resource_type: "encrypt-resource",
      event_type: eventType,
      summary: notification.kind === "transaction" ? "支付成功" : "退款通知",
      resource: {
        original_type: originalType,
        algorithm: "AEAD_AES_256_GCM",
        ciphertext: seal(material.apiV3Key, JSON.stringify(resource), nonce, originalType),
        associated_data: originalType,
        nonce,
      },
    });
    wireBodies.set(notification, body);
    return body;
  }

  function encode(
    notification: WechatPayNotification,
    options: { probe?: boolean } = {},
  ): { headers: Record<string, string>; rawBody: string } {
    const timestamp = String(Math.floor(clock.now().getTime() / 1000));
    if (wire) {
      const rawBody = wireBody(wire, notification);
      const nonce = randomBytes(16).toString("hex");
      const signature = createSign("RSA-SHA256")
        .update(`${timestamp}\n${nonce}\n${rawBody}\n`)
        .sign(wire.privateKey, "base64");
      return {
        rawBody,
        headers: {
          "Wechatpay-Timestamp": timestamp,
          "Wechatpay-Nonce": nonce,
          "Wechatpay-Serial": wire.serial,
          "Wechatpay-Signature": options.probe ? `${PROBE_PREFIX}${signature}` : signature,
          "Wechatpay-Signature-Type": SIGNATURE_TYPE,
        },
      };
    }
    const rawBody = JSON.stringify(notification);
    const nonce = notification.id;
    const signature = signatureOf(timestamp, nonce, rawBody);
    return {
      rawBody,
      headers: {
        "wechatpay-timestamp": timestamp,
        "wechatpay-nonce": nonce,
        "wechatpay-serial": SERIAL,
        "wechatpay-signature": options.probe ? `${PROBE_PREFIX}${signature}` : signature,
      },
    };
  }

  function enqueue(notification: WechatPayNotification, plan: NotificationPlan = {}): void {
    const dueAt = new Date(clock.now().getTime() + (plan.delayMs ?? 0));
    for (let copy = 0; copy < (plan.copies ?? 1); copy += 1) {
      queue.push({ notification, dueAt, attempt: 1 });
    }
  }

  const fake: FakeWechatPay = {
    status: "fake",
    configured: true,
    ...core.control,
    orders,
    refunds,
    queue,
    deliveries,
    retryDelayMs: 15_000,
    maxAttempts: 5,
    encode,
    enqueue,
    onNotification(nextHandler) {
      handler = nextHandler;
    },

    get wire() {
      if (!wire) return null;
      const { serial, publicKeyPem, apiV3Key, mchid, appid } = wire;
      return { serial, publicKeyPem, apiV3Key, mchid, appid };
    },

    useWireFormat(options = {}) {
      const keyPair =
        options.keyPair ??
        (() => {
          const generated = generateKeyPairSync("rsa", { modulusLength: 2048 });
          const publicKeyPem = generated.publicKey.export({ type: "spki", format: "pem" });
          return { privateKey: generated.privateKey, publicKeyPem: publicKeyPem.toString() };
        })();
      // 缺省的 APIv3 密钥是现场拼出来的假值：32 个字节
      const apiV3Key = options.apiV3Key ?? "lyx-fake-wechatpay-".padEnd(32, "0");
      if (Buffer.byteLength(apiV3Key) !== 32) throw new Error("假微信支付：APIv3 密钥要 32 个字节");
      wire = {
        serial: options.serial ?? "PUB_KEY_ID_0000000000000000000000000000000000",
        publicKeyPem: keyPair.publicKeyPem,
        apiV3Key,
        mchid: options.mchid ?? "1900000109",
        appid: options.appid ?? "wx0000000000000000",
        privateKey: keyPair.privateKey,
        publicKey: createPublicKey(keyPair.publicKeyPem),
      };
      return fake.wire as FakeWechatPayWire;
    },

    loseResponseNext(method, options = {}) {
      lostResponses.set(method, (lostResponses.get(method) ?? 0) + (options.times ?? 1));
    },

    pay(outTradeNo, plan) {
      const order = orders.get(outTradeNo);
      if (!order) throw new Error(`假微信支付：没有商户单号 ${outTradeNo} 的预下单`);
      if (order.tradeState !== "NOTPAY") {
        throw new Error(`假微信支付：${outTradeNo} 现在是 ${order.tradeState}，不能付款`);
      }
      order.tradeState = "SUCCESS";
      order.transactionId = next("fake-txn");
      order.successAt = clock.now();
      const notification: WechatPayNotification = {
        kind: "transaction",
        id: next("fake-notify"),
        transaction: transactionOf(order),
      };
      enqueue(notification, plan);
      return notification;
    },

    completeRefund(outRefundNo, plan = {}) {
      const refund = refunds.get(outRefundNo);
      if (!refund) throw new Error(`假微信支付：没有退款单号 ${outRefundNo}`);
      refund.status = plan.status ?? "SUCCESS";
      if (refund.status === "SUCCESS") refund.successAt = clock.now();
      const notification: WechatPayNotification = {
        kind: "refund",
        id: next("fake-notify"),
        refund: { ...refund },
      };
      enqueue(notification, plan);
      return notification;
    },

    reorder(order = (current) => [...current].reverse()) {
      const reordered = order([...queue]);
      queue.splice(0, queue.length, ...reordered);
    },

    setQueryResult(outTradeNo, result) {
      if (result === null) queryResults.delete(outTradeNo);
      else queryResults.set(outTradeNo, result);
    },

    async deliverDue() {
      const now = clock.now().getTime();
      const due = queue.filter((item) => item.dueAt.getTime() <= now);
      for (const item of due) {
        queue.splice(queue.indexOf(item), 1);
        let acknowledged = true;
        if (handler) {
          try {
            const answer = await handler({ ...encode(item.notification), attempt: item.attempt });
            acknowledged = answer !== false;
          } catch {
            acknowledged = false;
          }
        }
        deliveries.push({
          notification: item.notification,
          attempt: item.attempt,
          at: clock.now(),
          acknowledged,
        });
        if (!acknowledged && item.attempt < fake.maxAttempts) {
          queue.push({
            notification: item.notification,
            dueAt: new Date(clock.now().getTime() + fake.retryDelayMs),
            attempt: item.attempt + 1,
          });
        }
      }
      return due.length;
    },

    get notificationCrypto() {
      return wire
        ? createWechatPayNotificationCrypto(
            {
              verifiers: [{ serial: wire.serial, pem: wire.publicKeyPem }],
              apiV3Keys: { current: { kid: "fake-v1", key: wire.apiV3Key } },
            },
            () => clock.now(),
          )
        : undefined;
    },

    signMiniProgramPay: (input) =>
      run("signMiniProgramPay", input, () =>
        ok({
          appId: wire?.appid ?? "wx0000000000000000",
          timeStamp: String(Math.floor(clock.now().getTime() / 1000)),
          nonceStr: next("fake-nonce"),
          package: `prepay_id=${input.prepayId}`,
          signType: "RSA",
          paySign: "explicit-fake-signature",
        }),
      ),

    createJsapiOrder: (input) =>
      run("createJsapiOrder", input, () => {
        if (!Number.isInteger(input.amountFen) || input.amountFen <= 0) {
          return failed("rejected", "金额要是正的整数分");
        }
        const existing = orders.get(input.outTradeNo);
        if (existing) {
          if (
            existing.amountFen !== input.amountFen ||
            existing.payerOpenid !== input.payerOpenid
          ) {
            return failed("rejected", "商户单号已存在，入参与上一次不同");
          }
          if (existing.tradeState !== "NOTPAY") {
            return failed("rejected", `订单已是 ${existing.tradeState}，不能再预下单`);
          }
          return ok({ prepayId: existing.prepayId });
        }
        const order: FakeWechatPayOrder = {
          ...input,
          appid: wire?.appid ?? "wx0000000000000000",
          mchid: wire?.mchid ?? "1900000109",
          prepayId: next("fake-prepay"),
          tradeState: "NOTPAY",
        };
        orders.set(input.outTradeNo, order);
        return ok({ prepayId: order.prepayId });
      }),

    verifyAndDecryptNotification: (input) =>
      run("verifyAndDecryptNotification", input, (): ProviderResult<WechatPayNotification> => {
        const headers = Object.fromEntries(
          Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value]),
        );
        if (wire) {
          // 真实结构：照微信的规则验签、解密。只管通与不通；逐种失败的判别在真实驱动里
          const signed = `${headers["wechatpay-timestamp"]}\n${headers["wechatpay-nonce"]}\n${input.rawBody}\n`;
          const signature = Buffer.from(headers["wechatpay-signature"] ?? "", "base64");
          const verified =
            headers["wechatpay-serial"] === wire.serial &&
            createVerify("RSA-SHA256").update(signed).verify(wire.publicKey, signature);
          if (!verified) return failed("rejected", "验签失败");
          try {
            const outer = JSON.parse(input.rawBody) as {
              id: string;
              event_type: string;
              resource: { ciphertext: string; nonce: string; associated_data: string };
            };
            const { ciphertext, nonce, associated_data: associatedData } = outer.resource;
            const plaintext = open(wire.apiV3Key, ciphertext, nonce, associatedData);
            const resource = JSON.parse(plaintext) as Record<string, unknown>;
            return ok(fromWire(outer.id, outer.event_type, resource));
          } catch {
            return failed("rejected", "解密失败");
          }
        }
        const expected = signatureOf(
          headers["wechatpay-timestamp"] ?? "",
          headers["wechatpay-nonce"] ?? "",
          input.rawBody,
        );
        if (headers["wechatpay-signature"] !== expected) {
          return failed("rejected", "验签失败");
        }
        return ok(reviveNotification(JSON.parse(input.rawBody) as WechatPayNotification));
      }),

    queryByOutTradeNo: (input) =>
      run("queryByOutTradeNo", input, (): ProviderResult<WechatPayTransaction> => {
        const preset = queryResults.get(input.outTradeNo);
        if (preset !== undefined) return "ok" in preset ? preset : ok({ ...preset });
        const order = orders.get(input.outTradeNo);
        return order ? ok(transactionOf(order)) : failed("rejected", "订单不存在");
      }),

    closeOrder: (input) =>
      run("closeOrder", input, (): ProviderResult<{ outcome: "closed" | "paid" }> => {
        const order = orders.get(input.outTradeNo);
        if (!order) return failed("rejected", "订单不存在");
        if (order.tradeState === "SUCCESS" || order.tradeState === "REFUND") {
          return ok({ outcome: "paid" });
        }
        order.tradeState = "CLOSED";
        return ok({ outcome: "closed" });
      }),

    createRefund: (input) =>
      run("createRefund", input, () => {
        const existing = refunds.get(input.outRefundNo);
        if (existing) {
          if (existing.outTradeNo !== input.outTradeNo || existing.refundFen !== input.refundFen) {
            return failed("rejected", "退款单号已存在，入参与上一次不同");
          }
          return ok({ ...existing });
        }
        const order = orders.get(input.outTradeNo);
        if (!order) return failed("rejected", "订单不存在");
        if (order.tradeState !== "SUCCESS" && order.tradeState !== "REFUND") {
          return failed("rejected", `订单是 ${order.tradeState}，不能退款`);
        }
        const refunded = [...refunds.values()]
          .filter((refund) => refund.outTradeNo === input.outTradeNo && refund.status !== "CLOSED")
          .reduce((sum, refund) => sum + refund.refundFen, 0);
        if (
          !Number.isInteger(input.refundFen) ||
          input.refundFen <= 0 ||
          refunded + input.refundFen > order.amountFen
        ) {
          return failed("rejected", "退款金额要是正的整数分，累计不超过订单金额");
        }
        const refund: WechatPayRefund = {
          outRefundNo: input.outRefundNo,
          outTradeNo: input.outTradeNo,
          refundId: next("fake-refund"),
          status: "PROCESSING",
          refundFen: input.refundFen,
        };
        refunds.set(input.outRefundNo, refund);
        order.tradeState = "REFUND";
        return ok({ ...refund });
      }),

    queryRefund: (input) =>
      run("queryRefund", input, () => {
        const refund = refunds.get(input.outRefundNo);
        return refund
          ? ok({ ...refund })
          : { ...failed("rejected", "替身：退款单不存在"), refundNotFound: true as const };
      }),

    setTradeBill(billDate, body) {
      tradeBills.set(billDate, body);
    },
    fetchVerifiedTradeBill: (input) =>
      run("fetchVerifiedTradeBill", input, (): ProviderResult<VerifiedTradeBillResult> => {
        const body = tradeBills.get(input.billDate),
          appid = wire?.appid ?? "wx0000000000000000",
          mchid = wire?.mchid ?? "1900000109";
        if (body === undefined || body === null)
          return ok({ kind: "missing" as const, billDate: input.billDate, appid, mchid });
        const bytes = Buffer.from(body, "utf8"),
          sha1 = createHash("sha1").update(bytes).digest("hex");
        return ok(createVerifiedTradeBill({ billDate: input.billDate, appid, mchid, bytes, sha1 }));
      }),

    fetchTradeBill: (input) =>
      run("fetchTradeBill", input, () => {
        const lines = [...orders.values()]
          .filter((order) => order.successAt && beijingDate(order.successAt) === input.billDate)
          .map((order) =>
            [order.successAt?.toISOString(), order.outTradeNo, order.transactionId, order.amountFen]
              .map(String)
              .join(","),
          );
        const text = ["交易时间,商户订单号,微信支付订单号,金额（分）", ...lines].join("\n");
        return ok({ billDate: input.billDate, text });
      }),
  };
  return fake;
}
