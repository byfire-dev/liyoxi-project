// 三段式用例的共用装置（W0-20）：只给本目录的测试用。
// 一个测试文件一个库；库里现建样例的探针表；外部服务是假微信支付，包了外呼前钩子与外呼中断器；时钟可拨。
import type { PrismaClient } from "@liyoxi/db";
import { beforeAll } from "vitest";

import {
  connectTestDatabase,
  createCallInterrupter,
  createClock,
  createFakeProviders,
  SAMPLE_PREPAY_DDL,
  samplePrepay,
  samplePrepayRows,
  useTestDatabase,
} from "../../../testing/index.js";
import type {
  AdjustableClock,
  CallInterrupter,
  FakeWechatPay,
  SamplePrepayResult,
  SamplePrepayRow,
  SampleShape,
} from "../../../testing/index.js";
import { merchant } from "../../__fixtures__/idempotency.js";
import type { Actor } from "../../actor.js";
import { createIdempotencyContext } from "../../idempotency.js";
import type { IdempotencyContext } from "../../idempotency.js";
import { createTxRunner } from "../../tx.js";
import type { TxRunner } from "../../tx.js";
import { createThreePhaseRunner, guardProviderCall } from "../three-phase.js";
import type { ThreePhaseRunner } from "../three-phase.js";

export const SCOPE = "m.paymentOrder.wechatPrepay";
export const SLOW = 120_000;

export interface Attempt {
  /** 商户单号 */
  no: string;
  /** Idempotency-Key */
  key: string;
  actor: Actor;
  amountFen?: number;
  /** 路由登记的脱敏路径 */
  redact?: readonly string[];
}

export interface Harness {
  prisma: PrismaClient;
  tx: TxRunner;
  clock: AdjustableClock;
  wechatPay: FakeWechatPay;
  interrupter: CallInterrupter;
  threePhase: ThreePhaseRunner;
  /** 一次请求的幂等上下文：每次调用都新建 */
  request(attempt: Attempt): IdempotencyContext;
  /** 发一次请求：跑一遍样例用例。返回结果与这次用的上下文 */
  send(
    shape: SampleShape,
    attempt: Attempt,
    idem?: IdempotencyContext,
  ): Promise<{ result: SamplePrepayResult; idem: IdempotencyContext }>;
  /** 探针表里这个单号的行；没有是 undefined */
  row(no: string): Promise<SamplePrepayRow | undefined>;
  /** 这个键的幂等行；没有是 null */
  idemRow(attempt: Attempt): ReturnType<PrismaClient["idempotencyRecord"]["findUnique"]>;
  /** 替身收到的这个单号的预下单次数 */
  calls(no: string): number;
}

let serial = 0;
/** 一组不与别的用例相撞的单号、键与操作人 */
export const attemptOf = (label: string, extra: Partial<Attempt> = {}): Attempt => {
  serial += 1;
  return {
    no: `S-${label}-${serial}`,
    key: `prepay:${label}-${serial}`,
    actor: merchant(),
    ...extra,
  };
};

/** 在测试文件顶层调：返回的对象在 beforeAll 之后才有内容 */
export function useThreePhase(options: { max?: number } = {}): Harness {
  const db = useTestDatabase("services", { max: options.max });
  const harness = {} as Harness;

  beforeAll(async () => {
    const prisma = await db.prisma();
    const owner = await connectTestDatabase(db.name, { role: null });
    try {
      await owner.query(SAMPLE_PREPAY_DDL);
    } finally {
      await owner.end();
    }
    const clock = createClock();
    const { wechatPay } = createFakeProviders({ clock, beforeCall: guardProviderCall });
    const interrupter = createCallInterrupter();
    const tx = createTxRunner({ prisma, appEnv: "test" });
    const threePhase = createThreePhaseRunner({ tx, clock });

    const request = (attempt: Attempt): IdempotencyContext =>
      createIdempotencyContext({
        mode: "required",
        scope: SCOPE,
        actor: attempt.actor,
        key: attempt.key,
        request: { method: "POST", body: { no: attempt.no, amountFen: attempt.amountFen ?? 100 } },
        redact: attempt.redact,
      });

    Object.assign(harness, {
      prisma,
      tx,
      clock,
      wechatPay,
      interrupter,
      threePhase,
      request,
      async send(shape, attempt, idem = request(attempt)) {
        const useCase = samplePrepay(
          shape,
          { wechatPay, call: interrupter.call },
          { outTradeNo: attempt.no, amountFen: attempt.amountFen ?? 100, payerOpenid: "o-sample" },
        );
        return { result: await threePhase.run(useCase, { idem }), idem };
      },
      row: async (no) => (await samplePrepayRows(prisma)).find((row) => row.outTradeNo === no),
      idemRow: (attempt) =>
        prisma.idempotencyRecord.findUnique({
          where: {
            scope_actorKey_key: {
              scope: SCOPE,
              actorKey: `merchant:${attempt.actor.id}`,
              key: attempt.key,
            },
          },
        }),
      calls: (no) =>
        wechatPay
          .callsOf("createJsapiOrder")
          .filter((call) => (call.input as { outTradeNo: string }).outTradeNo === no).length,
    } satisfies Harness);
  }, SLOW);

  return harness;
}
